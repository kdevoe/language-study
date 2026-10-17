-- ============================================================
-- 38_cron_secret.sql
-- Cron jobs prove themselves with a shared secret, not the public anon key.
--
-- The nightly fan-outs (ensure-buffer, learner-dream) and audio-cleanup were
-- called with the anon key, and those functions then trusted body.userId. The
-- anon key ships in the web bundle, so anyone could trigger article production
-- or a dream for any user (spending Gemini / Claude credits), or run the
-- cleanup. The functions now resolve their caller in
-- supabase/functions/_shared/auth.ts: a signed-in user acts only for
-- themselves, and body.userId counts only from the service role or from a
-- request carrying the x-cron-secret header.
--
-- This migration adds that header to the three cron triggers. The anon-key
-- bearer stays (harmless; audio-cleanup still sits behind the gateway JWT check).
-- ============================================================
-- APPLY MANUALLY in the Supabase SQL editor. Order:
--
--   1. Generate one random value and store it in BOTH places:
--        • the edge functions' secrets:   supabase secrets set CRON_SECRET=<random>
--        • Vault (run once, by hand):
--            select vault.create_secret('<random>', 'cron_secret',
--              'x-cron-secret header for the nightly edge-function crons');
--   2. Run this file (each trigger raises loudly if the Vault secret is missing).
--   3. Deploy the functions: ensure-buffer, learner-dream, audio-cleanup,
--      process-article, dictionary-lookup, fetch-raw-news, daily-feed.
--
-- Steps 1–2 before 3 keep the crons working throughout: the old functions
-- ignore the extra header, the new ones require it.
-- Idempotent: CREATE OR REPLACE FUNCTION only (schedules are unchanged).
-- ------------------------------------------------------------

-- ── ensure-buffer overnight refill (was database/19) ────────────────────────
create or replace function public.jit_refill_active_users(
  p_active_days int default 14,
  p_max_users   int default 500,
  p_timeout_ms  int default 60000
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url    text := 'https://mfehycyixslnedyffito.supabase.co';
  v_key    text;
  v_secret text;
  v_count  int := 0;
  r        record;
begin
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'jit_anon_key';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret';
  if v_key is null or v_secret is null then
    raise exception 'jit_refill_active_users: missing Vault secret jit_anon_key or cron_secret (see database/38_cron_secret.sql)';
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
                   'Authorization', 'Bearer ' || v_key,
                   'x-cron-secret', v_secret
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
revoke all on function public.jit_refill_active_users(int, int, int) from public;

-- ── learner-dream nightly / weekly (was database/36) ────────────────────────
create or replace function public.learner_dream_active_users(
  p_mode        text default 'nightly',
  p_active_days int  default 14,
  p_max_users   int  default 500
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url    text := 'https://mfehycyixslnedyffito.supabase.co';
  v_key    text;
  v_secret text;
  v_count  int := 0;
  r        record;
begin
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'jit_anon_key';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret';
  if v_key is null or v_secret is null then
    raise exception 'learner_dream_active_users: missing Vault secret jit_anon_key or cron_secret (see database/38_cron_secret.sql)';
  end if;

  for r in
    select distinct sh.user_id from public.study_history sh
     where sh.created_at > now() - make_interval(days => p_active_days)
     limit p_max_users
  loop
    perform net.http_post(
      url     := v_url || '/functions/v1/learner-dream',
      headers := jsonb_build_object(
                   'Content-Type',  'application/json',
                   'Authorization', 'Bearer ' || v_key,
                   'x-cron-secret', v_secret
                 ),
      body    := jsonb_build_object('userId', r.user_id, 'mode', p_mode),
      timeout_milliseconds := 120000
    );
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('queued', v_count, 'mode', p_mode);
end;
$$;
revoke all on function public.learner_dream_active_users(text, int, int) from public;

-- ── audio-cleanup daily (was database/30) ───────────────────────────────────
create or replace function public.audio_cleanup_trigger()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url    text := 'https://mfehycyixslnedyffito.supabase.co';
  v_key    text;
  v_secret text;
begin
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'jit_anon_key';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret';
  if v_key is null or v_secret is null then
    raise exception 'audio_cleanup_trigger: missing Vault secret jit_anon_key or cron_secret (see database/38_cron_secret.sql)';
  end if;
  return net.http_post(
    url     := v_url || '/functions/v1/audio-cleanup',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || v_key,
                 'x-cron-secret', v_secret
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end;
$$;
revoke all on function public.audio_cleanup_trigger() from public, anon, authenticated;
