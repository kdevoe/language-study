-- 37: daily activity for 進捗 (docs/mockups/progress-stats.html, B).
--
-- One row per user per local day, holding time the app measures itself: on
-- screen, reading, listening, in the decks, with ハルカ, plus ハルカ turns
-- (tutor transcripts are deleted after 30 days, so turns are counted here).
-- The client adds to today's row every minute or so via bump_daily_activity().
--
-- progress_activity() returns per-day rows for the stats chart and totals:
-- these columns plus counts from the event tables (podcasts finished, songs
-- played, cards and kanji reviewed, words looked up, articles opened and
-- finished), bucketed into the learner's local days, plus the current streak.
--
-- Safe to re-run.

create table if not exists public.daily_activity (
  user_id        uuid references auth.users not null,
  day            date not null,               -- the learner's local calendar day
  app_seconds    int not null default 0,      -- app visible on screen
  read_seconds   int not null default 0,      -- an article open and visible
  listen_seconds int not null default 0,      -- a podcast or song playing
  review_seconds int not null default 0,      -- a flashcard deck open
  chat_seconds   int not null default 0,      -- ハルカ's panel open
  chat_turns     int not null default 0,      -- messages sent to ハルカ
  updated_at     timestamptz not null default now(),
  primary key (user_id, day)
);
alter table public.daily_activity enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'daily_activity' and policyname = 'Users can manage own daily activity') then
    create policy "Users can manage own daily activity" on public.daily_activity for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

-- Adds to a day's row. Each amount is clamped (a flush covers about a minute;
-- an hour allows for one held offline), and the day must be near today.
create or replace function public.bump_daily_activity(
  p_day date, p_app int default 0, p_read int default 0, p_listen int default 0,
  p_review int default 0, p_chat int default 0, p_turns int default 0
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  c int := 3600;
begin
  if auth.uid() is null then return; end if;
  if p_day < current_date - 2 or p_day > current_date + 1 then return; end if;
  insert into public.daily_activity as a (user_id, day, app_seconds, read_seconds, listen_seconds, review_seconds, chat_seconds, chat_turns)
  values (auth.uid(), p_day,
          least(greatest(p_app, 0), c), least(greatest(p_read, 0), c), least(greatest(p_listen, 0), c),
          least(greatest(p_review, 0), c), least(greatest(p_chat, 0), c), least(greatest(p_turns, 0), 200))
  on conflict (user_id, day) do update set
    app_seconds    = a.app_seconds    + excluded.app_seconds,
    read_seconds   = a.read_seconds   + excluded.read_seconds,
    listen_seconds = a.listen_seconds + excluded.listen_seconds,
    review_seconds = a.review_seconds + excluded.review_seconds,
    chat_seconds   = a.chat_seconds   + excluded.chat_seconds,
    chat_turns     = a.chat_turns     + excluded.chat_turns,
    updated_at     = now();
end;
$$;
grant execute on function public.bump_daily_activity(date, int, int, int, int, int, int) to authenticated;

-- Per-day stats from p_from (a local date) to today, in time zone p_tz.
create or replace function public.progress_activity(p_from date, p_tz text default 'UTC')
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  uid   uuid := auth.uid();
  tz    text := coalesce(nullif(p_tz, ''), 'UTC');
  today date;
  since timestamptz;
  days  jsonb;
  streak int := 0;
  d     date;
  active date[];
begin
  if uid is null then return null; end if;
  if not exists (select 1 from pg_timezone_names where name = tz) then tz := 'UTC'; end if;
  today := (now() at time zone tz)::date;
  since := p_from::timestamp at time zone tz;   -- local midnight starting p_from

  with ev as (
    select (listened_at at time zone tz)::date as day, 'podcasts' as k from public.podcast_episodes
     where user_id = uid and listened_at is not null and listened_at >= since
    union all
    select (played_at at time zone tz)::date, 'songs' from public.song_plays
     where user_id = uid and played_at >= since
    union all
    select (reviewed_at at time zone tz)::date, 'cards' from public.srs_review_log
     where user_id = uid and source = 'flashcard' and reviewed_at >= since
    union all
    select (reviewed_at at time zone tz)::date, 'kanji' from public.kanji_review_log
     where user_id = uid and source = 'flashcard' and reviewed_at >= since
    union all
    select (created_at at time zone tz)::date, 'lookups' from public.study_history
     where user_id = uid and action = 'lookup' and created_at >= since
    union all
    select (read_at at time zone tz)::date, 'opened' from public.processed_news
     where user_id = uid and read_at is not null and read_at >= since
    union all
    select (finished_at at time zone tz)::date, 'finished' from public.processed_news
     where user_id = uid and finished_at is not null and finished_at >= since
  ),
  counts as (
    select day,
           count(*) filter (where k = 'podcasts') as podcasts,
           count(*) filter (where k = 'songs')    as songs,
           count(*) filter (where k = 'cards')    as cards,
           count(*) filter (where k = 'kanji')    as kanji,
           count(*) filter (where k = 'lookups')  as lookups,
           count(*) filter (where k = 'opened')   as opened,
           count(*) filter (where k = 'finished') as finished
      from ev group by day
  ),
  merged as (
    select coalesce(a.day, c.day) as day,
           coalesce(a.app_seconds, 0) as app, coalesce(a.read_seconds, 0) as read,
           coalesce(a.listen_seconds, 0) as listen, coalesce(a.review_seconds, 0) as review,
           coalesce(a.chat_seconds, 0) as chat, coalesce(a.chat_turns, 0) as turns,
           coalesce(c.podcasts, 0) as podcasts, coalesce(c.songs, 0) as songs,
           coalesce(c.cards, 0) as cards, coalesce(c.kanji, 0) as kanji,
           coalesce(c.lookups, 0) as lookups, coalesce(c.opened, 0) as opened,
           coalesce(c.finished, 0) as finished
      from (select * from public.daily_activity where user_id = uid and day >= p_from) a
      full join counts c on c.day = a.day
  )
  select coalesce(jsonb_agg(to_jsonb(m) order by m.day), '[]'::jsonb) into days from merged m;

  -- Streak: consecutive days with any study, ending today, or yesterday so a
  -- streak isn't shown as broken before today's first session. Active days
  -- over the last year are collected in one pass, then walked back.
  select coalesce(array_agg(distinct x), '{}') into active from (
    select day as x from public.daily_activity where user_id = uid and day > today - 400 and (app_seconds >= 60 or chat_turns > 0)
    union all
    select (reviewed_at at time zone tz)::date from public.srs_review_log where user_id = uid and reviewed_at > now() - interval '400 days'
    union all
    select (reviewed_at at time zone tz)::date from public.kanji_review_log where user_id = uid and reviewed_at > now() - interval '400 days'
    union all
    select (created_at at time zone tz)::date from public.study_history where user_id = uid and action = 'lookup' and created_at > now() - interval '400 days'
    union all
    select (read_at at time zone tz)::date from public.processed_news where user_id = uid and read_at > now() - interval '400 days'
  ) s;
  d := case when today = any(active) then today else today - 1 end;
  while d = any(active) loop
    streak := streak + 1;
    d := d - 1;
  end loop;

  return jsonb_build_object('today', today, 'days', days, 'streak', streak);
end;
$$;
grant execute on function public.progress_activity(date, text) to authenticated;

-- Check:
--   select public.progress_activity(current_date - 6, 'America/Los_Angeles');
