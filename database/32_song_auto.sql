-- ============================================================
-- 32_song_auto.sql
-- Listening preferences + automatic songs (docs/music-design.md "Automatic songs"): a daily pg_cron run
-- asks generate-song to make a song for each reader who is due one. The
-- function decides per reader (generate-song autoSkipReason):
--   • song_frequency: 'every_other_day' (default) | 'daily' | 'off'
--   • due by calendar day (no auto song today, or yesterday for every other day)
--   • studied since their last automatic song (≥ 20 study events)
--   • fewer than 2 automatic songs still unplayed (a backlog pauses new ones)
-- ============================================================
-- APPLY MANUALLY after 31_songs.sql and after deploying generate-song with the
-- SONG_CRON_SECRET function secret. Idempotent.
--
-- ── ONE PREREQUISITE (run ONCE, by hand): the shared cron secret in Vault ────
-- The same random value goes in the function's secrets (SONG_CRON_SECRET) and
-- in Vault, so only this job can start automatic songs:
--     select vault.create_secret('<random>', 'song_cron_secret', 'generate-song auto run');
-- The gateway pass reuses jit_anon_key (19_overnight_cron.sql).
-- ------------------------------------------------------------

alter table public.user_preferences
  add column if not exists song_frequency text not null default 'every_other_day';
-- (These four columns were applied ahead of the rest on 2026-10-11 so the app's
-- settings could save; re-running is a no-op.)
-- Settings › 聞く: which song styles automatic songs draw from and which podcast
-- hosts rotate (null = all), and the reader's rewrites of host personalities
-- ({ persona id: text }, read by generate-podcast's script prompt).
alter table public.user_preferences add column if not exists song_styles text[];
alter table public.user_preferences add column if not exists podcast_cast text[];
alter table public.user_preferences add column if not exists podcast_personas jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'user_preferences_song_frequency_check') then
    alter table public.user_preferences add constraint user_preferences_song_frequency_check
      check (song_frequency in ('off', 'every_other_day', 'daily'));
  end if;
end $$;

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.song_auto_trigger()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url    text := 'https://mfehycyixslnedyffito.supabase.co';  -- public project URL
  v_key    text;
  v_secret text;
begin
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'jit_anon_key';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'song_cron_secret';
  if v_key is null or v_secret is null then
    raise exception 'song_auto_trigger: missing Vault secret jit_anon_key or song_cron_secret (see 32_song_auto.sql)';
  end if;
  return net.http_post(
    url     := v_url || '/functions/v1/generate-song',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key, 'x-cron-secret', v_secret),
    body    := '{"action":"auto"}'::jsonb,
    timeout_milliseconds := 120000
  );
end;
$$;

revoke all on function public.song_auto_trigger() from public, anon, authenticated;

-- 09:30 UTC (early morning in the US, evening in Japan), after the 09:00 article
-- refill, so a new song is waiting with the morning's articles.
do $$
declare j bigint;
begin
  for j in select jobid from cron.job where jobname = 'song-auto' loop
    perform cron.unschedule(j);
  end loop;
end $$;

select cron.schedule('song-auto', '30 9 * * *', $cron$ select public.song_auto_trigger(); $cron$);

-- ── Verify ───────────────────────────────────────────────────────────────────
--   select jobname, schedule, active from cron.job where jobname = 'song-auto';
--   select public.song_auto_trigger();
--   select id, status_code, content from net._http_response order by id desc limit 3;
