-- 42: ハルカ's long reads (docs/haruka-longform-plan.md).
--
-- Twice a week (chained after the nightly dream on the learner's local Tuesday
-- and Friday nights) and whenever the learner asks in chat, the write-longread
-- edge function chooses a topic, researches it (_shared/research.ts) and writes
-- an English source, which process-article turns into a long-form work like a
-- paste. These works carry source_type 'haruka'.
--
-- • long_form_works / processed_news: source_type 'haruka' allowed.
-- • long_form_works.meta: { topic, summary, why, trigger, revisits, whatsNew }.
--   topic + summary are what the chooser compares new topics against; imports get
--   them lazily from write-longread (Haiku), so there's no backfill here.
-- • longread_jobs: one row per piece, through its stages. One job in flight per
--   learner (unique index). Written by the service role only; the learner reads
--   (and can delete) their own.
--
-- Safe to re-run. Deploy write-longread, process-article, learner-dream and
-- tutor-chat after applying.

-- ── source_type 'haruka' ─────────────────────────────────────────────────────
alter table public.long_form_works drop constraint if exists long_form_works_source_type_check;
alter table public.long_form_works
  add constraint long_form_works_source_type_check
  check (source_type in ('import', 'magazine', 'haruka'));

alter table public.processed_news drop constraint if exists processed_news_source_type_check;
alter table public.processed_news
  add constraint processed_news_source_type_check
  check (source_type in ('news', 'import', 'magazine', 'haruka'));

alter table public.long_form_works add column if not exists meta jsonb not null default '{}'::jsonb;

-- ── Jobs ─────────────────────────────────────────────────────────────────────
create table if not exists public.longread_jobs (
  id          uuid default gen_random_uuid() primary key,
  user_id     uuid references auth.users not null,
  trigger     text not null check (trigger in ('scheduled', 'requested')),
  status      text not null default 'planning'
              check (status in ('planning', 'researching', 'writing', 'done', 'failed', 'skipped')),
  topic       text,                   -- the learner's request, or ハルカ's choice once planned
  angle       text,
  thread_id   uuid,                   -- requested: the chat the ready note goes to
  plan        jsonb,                  -- { topic, angle, why, title, questions, revisits, whatsNew }
  dossier     jsonb,                  -- the checked research notes
  work_id     uuid references public.long_form_works (id) on delete set null,
  error       text,
  usage       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.longread_jobs enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'longread_jobs' and policyname = 'Users can read own longread jobs') then
    create policy "Users can read own longread jobs" on public.longread_jobs for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'longread_jobs' and policyname = 'Users can delete own longread jobs') then
    create policy "Users can delete own longread jobs" on public.longread_jobs for delete using (auth.uid() = user_id);
  end if;
end $$;

-- One piece in flight per learner: the cost cap lives in the database too.
create unique index if not exists longread_jobs_one_in_flight
  on public.longread_jobs (user_id) where status in ('planning', 'researching', 'writing');
create index if not exists idx_longread_jobs_user on public.longread_jobs (user_id, created_at desc);

-- ── Verify ───────────────────────────────────────────────────────────────────
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conname in ('long_form_works_source_type_check', 'processed_news_source_type_check');
--   select column_name from information_schema.columns where table_name = 'long_form_works' and column_name = 'meta';
--   select policyname from pg_policies where tablename = 'longread_jobs';
