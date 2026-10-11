-- ============================================================
-- 30_audio_cleanup.sql
-- Generated audio is kept until the user deletes it (docs/audio-cache-retention.md).
-- This schedules the daily junk sweep: pg_cron → audio_cleanup_trigger() → one
-- pg_net POST to the audio-cleanup Edge Function, which deletes failed episodes
-- older than 7 days and removes bucket objects that no row points at.
-- ============================================================
-- APPLY MANUALLY in the Supabase SQL editor, after deploying audio-cleanup.
-- Idempotent. Reuses the Vault secret `jit_anon_key` from 19_overnight_cron.sql
-- as the gateway pass (the function uses its own service key for the work).
-- ------------------------------------------------------------

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── audio_orphans: objects in a bucket with no episode/track row ─────────────
-- Paths are `<user_id>/<row_id>.mp3`. An object is kept while a row points at
-- it by audio_path OR carries its id (a failed row whose upload landed before
-- the failure). Objects younger than a day are skipped, so an upload whose row
-- update is still in flight is never touched.
create or replace function public.audio_orphans(p_bucket text, p_table text)
returns setof text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_table not in ('podcast_episodes') then
    raise exception 'audio_orphans: unknown table %', p_table;
  end if;
  return query execute format(
    'select o.name from storage.objects o
      where o.bucket_id = $1
        and o.created_at < now() - interval ''1 day''
        and not exists (
          select 1 from public.%I r
           where r.audio_path = o.name
              or r.id::text = regexp_replace(split_part(o.name, ''/'', 2), ''\.mp3$'', ''''))',
    p_table) using p_bucket;
end;
$$;

revoke all on function public.audio_orphans(text, text) from public, anon, authenticated;
grant execute on function public.audio_orphans(text, text) to service_role;

-- ── audio_cleanup_trigger: POST to the Edge Function ─────────────────────────
create or replace function public.audio_cleanup_trigger()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text := 'https://mfehycyixslnedyffito.supabase.co';  -- public project URL
  v_key text;
begin
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'jit_anon_key';
  if v_key is null then
    raise exception 'audio_cleanup_trigger: missing Vault secret jit_anon_key (see 19_overnight_cron.sql)';
  end if;
  return net.http_post(
    url     := v_url || '/functions/v1/audio-cleanup',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end;
$$;

revoke all on function public.audio_cleanup_trigger() from public, anon, authenticated;

-- ── Schedule: daily at 10:00 UTC (after the 09:00 overnight refill) ──────────
do $$
declare j bigint;
begin
  for j in select jobid from cron.job where jobname = 'audio-cleanup' loop
    perform cron.unschedule(j);
  end loop;
end $$;

select cron.schedule('audio-cleanup', '0 10 * * *', $cron$ select public.audio_cleanup_trigger(); $cron$);

-- ── Verify ───────────────────────────────────────────────────────────────────
--   select jobname, schedule, active from cron.job where jobname = 'audio-cleanup';
--   select public.audio_cleanup_trigger();   -- fires it now
--   select id, status_code, content from net._http_response order by id desc limit 3;
