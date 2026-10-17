-- 36. Learner memory + the ハルカ tutor
--
-- One memory behind the tutor, the news editor and the nightly "dream"
-- (docs/learner-memory-design.md, docs/tutor-agent-design.md):
--   L0  learner_events     a view over the tables features already write, plus
--                          the few signals that were missing (below)
--   L1  learner_digests    one short paragraph per day, written by the nightly dream
--   L2  learner_profile_versions
--                          the learner profile; every dream writes a NEW version
--                          (rollback, "what changed last night")
--       learner_briefs     tomorrow's plan: editor brief, study focus, tutor openers
--       learner_notes      append-only observations written during the day (tutor
--                          save_note, editor pick reasons); only the dream folds
--                          them into the profile
--   tutor_threads / tutor_messages
--                          the conversation, one thread per day; verbatim messages
--                          are kept 30 days, thread summaries indefinitely
--
-- APPLY MANUALLY in the Supabase SQL editor (project convention). Idempotent.
-- The cron section reuses the Vault secret `jit_anon_key` from database/19.
-- Deploy the learner-dream edge function before the first 08:00 UTC run.

-- ── Missing signals ──────────────────────────────────────────────────────────
-- "read" is set when an article is OPENED. finished_at = reached the end;
-- read_seconds = time on the article (summed across opens).
-- topic = the feed topic id (src/data/feedTopics.ts) — metadata.category is
-- mostly "Recent News", so coverage couldn't be computed.
-- summary / pick_reason = the editor's one-line English summary and why it chose
-- the story, so memory and dedupe don't have to read Japanese.
alter table public.processed_news
  add column if not exists finished_at  timestamptz,
  add column if not exists read_seconds integer not null default 0,
  add column if not exists topic        text,
  add column if not exists summary      text,
  add column if not exists pick_reason  text;

-- The Reader adds time in chunks (on hide / leave) and stamps finished_at once.
create or replace function public.record_article_reading(p_id text, p_seconds int, p_finished boolean)
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.processed_news
     set read_seconds = read_seconds + greatest(0, least(coalesce(p_seconds, 0), 3600)),
         finished_at  = case when p_finished and finished_at is null then now() else finished_at end
   where user_id = auth.uid() and id = p_id;
$$;
grant execute on function public.record_article_reading(text, int, boolean) to authenticated;

-- Songs only kept a counter; the dream needs when.
create table if not exists public.song_plays (
  id        uuid default gen_random_uuid() primary key,
  user_id   uuid references auth.users not null,
  song_id   uuid references public.songs on delete cascade not null,
  played_at timestamptz not null default now()
);
alter table public.song_plays enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'song_plays' and policyname = 'Users can manage own song plays') then
    create policy "Users can manage own song plays" on public.song_plays for all using (auth.uid() = user_id);
  end if;
end $$;
create index if not exists idx_song_plays_user on public.song_plays(user_id, played_at desc);

-- Grammar ratings were local-only (#43 phase 1); the tutor and the dream read
-- them server-side. tutor_hand = which screen edge opens ハルカ.
-- tutor_prefs = what the learner told ハルカ: { correction: 'recast'|'all'|'ask',
-- asides: 'en'|'ja' } (set_preference tool or Settings).
alter table public.user_preferences
  add column if not exists grammar_progress jsonb,
  add column if not exists tutor_hand  text check (tutor_hand in ('right', 'left')),
  add column if not exists tutor_prefs jsonb;

-- ── Tutor conversation ───────────────────────────────────────────────────────
create table if not exists public.tutor_threads (
  id         uuid default gen_random_uuid() primary key,
  user_id    uuid references auth.users not null,
  persona    text not null default 'haruka',
  day        date not null default (now() at time zone 'utc')::date,
  started_at timestamptz not null default now(),
  ended_at   timestamptz,
  summary    text,                 -- written by the nightly dream
  recap      jsonb,                -- { corrections: [...], newWords: [...], usedWords: [...] }
  usage      jsonb                 -- summed tokens / cost for the thread
);
alter table public.tutor_threads enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'tutor_threads' and policyname = 'Users can manage own tutor threads') then
    create policy "Users can manage own tutor threads" on public.tutor_threads for all using (auth.uid() = user_id);
  end if;
end $$;
create index if not exists idx_tutor_threads_user on public.tutor_threads(user_id, started_at desc);

-- role 'context' = a screen-context snapshot appended when the panel opens from a
-- new place. content = the raw API content blocks (text, tool_use, tool_result)
-- so the thread replays exactly; text = what the panel shows (null for a
-- tool-result turn, which is stored as role 'user' like the API's).
create table if not exists public.tutor_messages (
  id         uuid default gen_random_uuid() primary key,
  thread_id  uuid references public.tutor_threads on delete cascade not null,
  user_id    uuid references auth.users not null,
  role       text not null check (role in ('user', 'assistant', 'context')),
  content    jsonb not null,
  text       text,
  context    jsonb,
  usage      jsonb,
  created_at timestamptz not null default now()
);
alter table public.tutor_messages enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'tutor_messages' and policyname = 'Users can manage own tutor messages') then
    create policy "Users can manage own tutor messages" on public.tutor_messages for all using (auth.uid() = user_id);
  end if;
end $$;
create index if not exists idx_tutor_messages_thread on public.tutor_messages(thread_id, created_at);
create index if not exists idx_tutor_messages_user on public.tutor_messages(user_id, created_at desc);

-- ── Memory ───────────────────────────────────────────────────────────────────
-- Observations. kind: struggle | interest | personal | preference | usage | pick | forget.
-- 'forget' = the learner deleted a profile line; the dream must not bring it back.
create table if not exists public.learner_notes (
  id          uuid default gen_random_uuid() primary key,
  user_id     uuid references auth.users not null,
  persona     text,                 -- null = about the learner; else a relationship note
  kind        text not null check (kind in ('struggle', 'interest', 'personal', 'preference', 'usage', 'pick', 'forget')),
  text        text not null,
  source      text not null check (source in ('tutor', 'editor', 'user', 'dream')),
  ref         jsonb,                -- e.g. { threadId } / { articleId } / { word, correct }
  created_at  timestamptz not null default now(),
  folded_at   timestamptz           -- when a dream folded it into the profile
);
alter table public.learner_notes enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'learner_notes' and policyname = 'Users can manage own learner notes') then
    create policy "Users can manage own learner notes" on public.learner_notes for all using (auth.uid() = user_id);
  end if;
end $$;
create index if not exists idx_learner_notes_user on public.learner_notes(user_id, created_at desc);

create table if not exists public.learner_digests (
  user_id    uuid references auth.users not null,
  day        date not null,
  text       text not null,
  stats      jsonb,                 -- counts behind the paragraph (opened, finished, lookups…)
  created_at timestamptz not null default now(),
  primary key (user_id, day)
);
alter table public.learner_digests enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'learner_digests' and policyname = 'Users can manage own digests') then
    create policy "Users can manage own digests" on public.learner_digests for all using (auth.uid() = user_id);
  end if;
end $$;

-- profile = { summary, items: [{ id, kind, text, evidence, importance, lastSeen }],
--             coverage: { topic: count } }  (shape in supabase/functions/_shared/learner.ts)
-- kind: nightly | weekly | edit (the learner deleted a line) | rollback.
-- accepted = false: the dream failed its guards; readers keep the last accepted one.
create table if not exists public.learner_profile_versions (
  id          uuid default gen_random_uuid() primary key,
  user_id     uuid references auth.users not null,
  version     integer not null,
  kind        text not null check (kind in ('nightly', 'weekly', 'edit', 'rollback')),
  profile     jsonb not null,
  changes     jsonb,                -- { added: [text], faded: [text], updated: [text] }
  accepted    boolean not null default true,
  guard_notes text,
  usage       jsonb,
  created_at  timestamptz not null default now(),
  unique (user_id, version)
);
alter table public.learner_profile_versions enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'learner_profile_versions' and policyname = 'Users can manage own profile versions') then
    create policy "Users can manage own profile versions" on public.learner_profile_versions for all using (auth.uid() = user_id);
  end if;
end $$;

-- brief = { editor: { dueTopics, angles, followUps }, studyFocus: [{ kind, item, why }],
--           openers: [ja text], ideas: [{ kind, topic, why }] }
create table if not exists public.learner_briefs (
  user_id    uuid references auth.users not null,
  day        date not null,
  brief      jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, day)
);
alter table public.learner_briefs enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'learner_briefs' and policyname = 'Users can manage own briefs') then
    create policy "Users can manage own briefs" on public.learner_briefs for all using (auth.uid() = user_id);
  end if;
end $$;

-- ── News editor runs ─────────────────────────────────────────────────────────
-- The Haiku editor (fetch-raw-news, mode 'edit') picks ~6 stories per run with
-- their full text already fetched. ensure-buffer refills one or two at a time,
-- so a run is reused for a few hours until its picks are used up.
create table if not exists public.news_editor_runs (
  id         uuid default gen_random_uuid() primary key,
  user_id    uuid references auth.users not null,
  cards      jsonb not null,
  usage      jsonb,
  created_at timestamptz not null default now()
);
alter table public.news_editor_runs enable row level security;   -- service role only
create index if not exists idx_news_editor_runs_user on public.news_editor_runs(user_id, created_at desc);

-- ── L0: learner_events ───────────────────────────────────────────────────────
-- One timeline over the tables features already write. security_invoker so a
-- client only ever sees its own rows (each source table's RLS applies).
-- 'seen' word events are left out: one per word per paragraph read, all noise.
create or replace view public.learner_events
with (security_invoker = true) as
  select user_id, created_at as at, 'article_shown' as kind, id as ref,
         jsonb_build_object('title', title, 'topic', topic, 'summary', summary, 'reason', pick_reason) as detail
    from public.processed_news
   where source_type = 'news' and status in ('ready', 'read', 'dismissed') and title is not null
  union all
  select user_id, read_at, 'article_opened', id,
         jsonb_build_object('title', title, 'topic', topic, 'seconds', read_seconds, 'type', source_type)
    from public.processed_news where read_at is not null
  union all
  select user_id, finished_at, 'article_finished', id,
         jsonb_build_object('title', title, 'topic', topic, 'seconds', read_seconds, 'type', source_type)
    from public.processed_news where finished_at is not null
  union all
  select user_id, dismissed_at, 'article_skipped', id,
         jsonb_build_object('title', title, 'topic', topic)
    from public.processed_news where dismissed_at is not null and title is not null
  union all
  select user_id, listened_at, 'podcast_finished', id::text,
         jsonb_build_object('title', title, 'kind', source_kind, 'minutes', minutes)
    from public.podcast_episodes where listened_at is not null
  union all
  select p.user_id, p.played_at, 'song_played', p.song_id::text,
         jsonb_build_object('title', s.title, 'theme', s.theme)
    from public.song_plays p join public.songs s on s.id = p.song_id
  union all
  select user_id, created_at, 'word_lookup', word_id,
         coalesce(metadata, '{}'::jsonb)
    from public.study_history where action = 'lookup'
  union all
  select user_id, reviewed_at, 'word_review', word_id,
         jsonb_build_object('rating', rating, 'source', source)
    from public.srs_review_log where source = 'flashcard'
  union all
  select user_id, reviewed_at, 'kanji_review', kanji,
         jsonb_build_object('rating', rating)
    from public.kanji_review_log where source = 'flashcard'
  union all
  select user_id, created_at, 'tutor_message', thread_id::text,
         jsonb_build_object('text', left(text, 400))
    from public.tutor_messages where role = 'user' and text is not null;  -- not tool results

-- ── Nightly + weekly dream, transcript retention ────────────────────────────
-- learner_dream_active_users: one fire-and-forget POST to learner-dream per
-- active user (same shape as jit_refill_active_users in database/19).
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
  v_url   text := 'https://mfehycyixslnedyffito.supabase.co';
  v_key   text;
  v_count int := 0;
  r       record;
begin
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'jit_anon_key';
  if v_key is null then
    raise exception 'learner_dream_active_users: missing Vault secret jit_anon_key (see database/19_overnight_cron.sql)';
  end if;

  for r in
    select distinct sh.user_id from public.study_history sh
     where sh.created_at > now() - make_interval(days => p_active_days)
     limit p_max_users
  loop
    perform net.http_post(
      url     := v_url || '/functions/v1/learner-dream',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
      body    := jsonb_build_object('userId', r.user_id, 'mode', p_mode),
      timeout_milliseconds := 120000
    );
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('queued', v_count, 'mode', p_mode);
end;
$$;
revoke all on function public.learner_dream_active_users(text, int, int) from public;

do $$
declare j bigint;
begin
  for j in select jobid from cron.job where jobname in ('learner-dream-nightly', 'learner-dream-weekly', 'tutor-transcript-retention') loop
    perform cron.unschedule(j);
  end loop;
end $$;

-- 08:00 UTC: an hour before the 09:00 buffer refill, so the editor reads tonight's brief.
select cron.schedule('learner-dream-nightly', '0 8 * * *',
  $cron$ select public.learner_dream_active_users('nightly'); $cron$);
-- Sundays 07:00 UTC: the deeper pass (Sonnet) rereads the week and prunes.
select cron.schedule('learner-dream-weekly', '0 7 * * 0',
  $cron$ select public.learner_dream_active_users('weekly'); $cron$);
-- Verbatim transcripts for 30 days; thread summaries, digests and profiles stay.
select cron.schedule('tutor-transcript-retention', '30 8 * * *',
  $cron$ delete from public.tutor_messages where created_at < now() - interval '30 days'; $cron$);

-- ── Verify ───────────────────────────────────────────────────────────────────
--   select jobname, schedule, active from cron.job order by jobid;
--   select public.learner_dream_active_users('nightly');   -- fires now
--   select kind, count(*) from public.learner_events group by kind;
