-- ============================================================
-- 19_overnight_cron.sql
-- Server-side JIT buffer, part 3 / Step 5 (issue #31): the overnight refill.
-- pg_cron fires nightly → jit_refill_active_users() → one pg_net POST to the
-- ensure-buffer Edge Function per ACTIVE user. ensure-buffer stays the single
-- entrypoint that enforces the buffer invariant (kill switch, N, daily cap M,
-- advisory-lock claim) — this migration only *triggers* it on a schedule, so
-- a user who never opens the app still wakes up to a ready article, and a user
-- whose buffer drained overnight is topped up before morning.
-- ============================================================
-- APPLY MANUALLY in the Supabase SQL editor, AFTER database/16/17/18 and after
-- ensure-buffer is deployed with JIT_ENABLED=true. Idempotent: guarded extension
-- creates, CREATE OR REPLACE FUNCTION, and a defensive unschedule+reschedule.
--
-- ── ONE PREREQUISITE: store the anon key in Vault (run ONCE, by hand) ─────────
-- ensure-buffer requires a valid JWT at the gateway. The cron sends your PUBLIC
-- anon key (the same one already shipped in the web bundle — not the service-role
-- key) as the bearer; ensure-buffer ignores it for identity and uses the body
-- userId, so the anon key is purely the gateway pass. Set it ONCE in the SQL
-- editor, then run this whole file (the function reads it from Vault by name, so
-- re-running this migration never needs the key again, and it never lands in git):
--
--     select vault.create_secret(
--       'YOUR_ANON_KEY', 'jit_anon_key',
--       'Public anon key the JIT overnight cron uses to pass the ensure-buffer gateway');
--
-- The only other embedded value is the PUBLIC project URL (also in the web bundle).
-- jit_refill_active_users() raises loudly if the secret is missing.
-- ------------------------------------------------------------

-- ── Extensions ───────────────────────────────────────────────────────────────
-- pg_cron schedules jobs (schema `cron`); pg_net issues async, non-blocking HTTP
-- (schema `net`). Both ship with Supabase; if `create extension` is blocked for
-- your role, enable them once via Dashboard → Database → Extensions, then re-run.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── jit_refill_active_users: fan out ensure-buffer over active users ──────────
-- "Active" = anyone with a study_history event in the last p_active_days. Each
-- user gets ONE fire-and-forget POST; ensure-buffer does the per-user accounting
-- and the slow Gemini work. pg_net queues the requests and returns immediately,
-- so this function never blocks on article production.
--
-- Guardrails: p_max_users caps the fan-out (runaway backstop — the per-user cost
-- ceiling still lives in ensure-buffer's N/M/kill-switch). p_timeout_ms is set
-- generous because ensure-buffer produces up to N articles synchronously; even
-- if pg_net stops waiting, the run is idempotent, so the next trigger finishes
-- any half-filled buffer. We don't care about the response — only the trigger.
create or replace function public.jit_refill_active_users(
  p_active_days int default 14,
  p_max_users   int default 500,
  p_timeout_ms  int default 60000  -- covers ~N sequential Gemini rewrites in ensure-buffer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- PUBLIC base URL (same value as VITE_SUPABASE_URL in the web bundle — not a secret).
  v_url   text := 'https://mfehycyixslnedyffito.supabase.co';
  v_key   text;
  v_count int := 0;
  r       record;
begin
  select decrypted_secret into v_key
    from vault.decrypted_secrets where name = 'jit_anon_key';
  if v_key is null then
    raise exception
      'jit_refill_active_users: missing Vault secret jit_anon_key (see database/19_overnight_cron.sql header)';
  end if;

  for r in
    select distinct sh.user_id
      from public.study_history sh
     where sh.created_at > now() - make_interval(days => p_active_days)
     limit p_max_users
  loop
    perform net.http_post(
      url     := v_url || '/functions/v1/ensure-buffer',
      headers := jsonb_build_object(
                   'Content-Type',  'application/json',
                   'Authorization', 'Bearer ' || v_key
                 ),
      body    := jsonb_build_object('userId', r.user_id),
      timeout_milliseconds := p_timeout_ms
    );
    v_count := v_count + 1;
  end loop;

  raise log 'jit_refill_active_users: queued % active user(s) (active_days=%, cap=%)',
    v_count, p_active_days, p_max_users;
  return jsonb_build_object('queued', v_count, 'active_days', p_active_days);
end;
$$;

-- Only the cron scheduler (postgres) runs this; keep it off every client role.
revoke all on function public.jit_refill_active_users(int, int, int) from public;

-- ── Schedule: nightly overnight refill ───────────────────────────────────────
-- 09:00 UTC ≈ 1–4 AM across US time zones — articles are ready before morning.
-- Adjust the cron expression to your users' overnight. Idempotent reschedule:
-- drop the old job first so re-running this file doesn't error or duplicate.
do $$
declare
  j bigint;
begin
  for j in select jobid from cron.job where jobname = 'jit-overnight-refill' loop
    perform cron.unschedule(j);
  end loop;
end $$;

select cron.schedule(
  'jit-overnight-refill',
  '0 9 * * *',
  $cron$ select public.jit_refill_active_users(); $cron$
);

-- ── Retire daily-feed ────────────────────────────────────────────────────────
-- ensure-buffer + this cron fully supersede the old broadcast daily-feed job
-- (which pushed the SAME 2 headlines to every user, ignoring the buffer). Remove
-- any pg_cron schedule that points at it. NOTE: if daily-feed was scheduled via
-- Dashboard → Edge Functions → Schedules (not pg_cron), disable it THERE too —
-- this DO block only reaches pg_cron jobs. The Edge Function source is left
-- deployed but marked deprecated; delete it once this cron is verified live.
do $$
declare
  j bigint;
begin
  for j in
    select jobid from cron.job
     where jobname = 'daily-feed'
        or jobname ilike '%daily-feed%'
        or command ilike '%daily-feed%'
  loop
    perform cron.unschedule(j);
  end loop;
end $$;

-- ── Verify (run after applying) ──────────────────────────────────────────────
--   -- the anon-key secret is present:
--   select name from vault.secrets where name = 'jit_anon_key';
--
--   -- the job is scheduled and daily-feed is gone:
--   select jobid, jobname, schedule, active from cron.job order by jobid;
--
--   -- manual smoke test (fires the real POST(s) now; watch ensure-buffer logs):
--   select public.jit_refill_active_users();   -- → {"queued": N, "active_days": 14}
--
--   -- inspect the most recent pg_net responses (200 = ensure-buffer reached):
--   select id, status_code, content from net._http_response order by id desc limit 5;
--
--   -- inspect cron run history:
--   select jobid, status, return_message, start_time
--     from cron.job_run_details order by start_time desc limit 10;
