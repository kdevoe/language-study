-- 40: overnight prep (docs/learning-strategy-review.md §4–5).
--
-- • user_preferences.timezone — the learner's IANA zone (the client writes it), so
--   server jobs know what "today" is for them.
-- • user_word_progress.chosen_at / chosen_by — a word the learner asked for: picked
--   in Discover, tapped from a ハルカ offer ('learner'), or queued by the nightly
--   struggle rule from their own repeated mistakes in chat ('haruka'). Chosen words
--   lead the intake ranking (_shared/intake.ts).
-- • level_snapshots — nightly per-level solid counts (history for a later weekly
--   gain; no UI reads it yet).
-- • daily_prep_active_users(stage) + two crons: 'intake' at 08:30 UTC (after the
--   08:00 dream, before the 09:00 news refill, so new articles carry the new
--   words) and 'digest' at 09:40 UTC (after the refill, so the morning podcast has
--   today's stories). Both POST the daily-prep edge function with x-cron-secret.
--
-- Needs database/38 (Vault secrets jit_anon_key + cron_secret). Safe to re-run.

alter table public.user_preferences add column if not exists timezone text;

alter table public.user_word_progress
  add column if not exists chosen_at timestamptz,
  add column if not exists chosen_by text
    check (chosen_by is null or chosen_by in ('learner', 'haruka'));

create table if not exists public.level_snapshots (
  user_id uuid references auth.users not null,
  day     date not null,
  level   int  not null,
  total   int  not null,
  solid   int  not null,
  primary key (user_id, day, level)
);
alter table public.level_snapshots enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'level_snapshots' and policyname = 'Users can read own level snapshots') then
    create policy "Users can read own level snapshots" on public.level_snapshots for select using (auth.uid() = user_id);
  end if;
end $$;
-- Written only by daily-prep (service role, which bypasses RLS).

create or replace function public.daily_prep_active_users(
  p_stage       text default 'intake',
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
  if p_stage not in ('intake', 'digest') then
    raise exception 'daily_prep_active_users: unknown stage %', p_stage;
  end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'jit_anon_key';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret';
  if v_key is null or v_secret is null then
    raise exception 'daily_prep_active_users: missing Vault secret jit_anon_key or cron_secret (see database/38_cron_secret.sql)';
  end if;

  for r in
    select distinct sh.user_id from public.study_history sh
     where sh.created_at > now() - make_interval(days => p_active_days)
     limit p_max_users
  loop
    perform net.http_post(
      url     := v_url || '/functions/v1/daily-prep',
      headers := jsonb_build_object(
                   'Content-Type',  'application/json',
                   'Authorization', 'Bearer ' || v_key,
                   'x-cron-secret', v_secret
                 ),
      body    := jsonb_build_object('userId', r.user_id, 'stage', p_stage),
      timeout_milliseconds := 60000
    );
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('queued', v_count, 'stage', p_stage);
end;
$$;
revoke all on function public.daily_prep_active_users(text, int, int) from public;

do $$
declare j bigint;
begin
  for j in select jobid from cron.job where jobname in ('daily-prep-intake', 'daily-prep-digest') loop
    perform cron.unschedule(j);
  end loop;
end $$;
select cron.schedule('daily-prep-intake', '30 8 * * *', $cron$ select public.daily_prep_active_users('intake'); $cron$);
select cron.schedule('daily-prep-digest', '40 9 * * *', $cron$ select public.daily_prep_active_users('digest'); $cron$);
