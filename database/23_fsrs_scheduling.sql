-- 23. FSRS scheduling layer (#67)
--
-- Adds a genuine spaced-repetition schedule (stability + due_at + intervals + a
-- review log) ON TOP OF the existing `difficulty` (1..10) signal — difficulty stays
-- the coarse palette signal and the seed; these fields are the real due-date engine.
--
-- The canonical implementation of the algorithm + seeding is src/services/srs.ts
-- (wraps ts-fsrs, FSRS-6, request_retention 0.85). The backfill below is a ONE-TIME
-- synthesis of a plausible starting schedule for rows that predate this engine; it
-- mirrors `seedSrsFromDifficulty` in that module. Any word touched after migration
-- is rescheduled by the TS engine, so small backfill approximations self-correct.
--
-- Applied by hand in Supabase (project convention).

-- ── Scheduling columns on user_word_progress ────────────────────────────────
-- NULL scheduling fields = word is not yet on a schedule (unseen / queued — the
-- intake gate that promotes queued→active is #68's job, not this migration's).
alter table public.user_word_progress
  add column if not exists stability         double precision,           -- FSRS S, in days
  add column if not exists fsrs_difficulty    double precision            -- FSRS D, 1..10 (algorithm-managed; DISTINCT from `difficulty`)
    check (fsrs_difficulty is null or (fsrs_difficulty between 1 and 10)),
  add column if not exists due_at             timestamptz,                -- next review — the "what's due" key
  add column if not exists last_reviewed_at   timestamptz,                -- last scheduler event (≠ last_seen_at, which is any exposure)
  add column if not exists interval_days      double precision,           -- convenience mirror of the scheduled gap (derivable from S)
  add column if not exists reps               integer default 0,          -- successful reviews
  add column if not exists lapses             integer default 0,          -- Again-after-review count
  add column if not exists srs_status         text                        -- FSRS card lifecycle
    check (srs_status is null or srs_status in ('new','learning','review','relearning'));

-- "What's due today" — the query the flashcard deck (#70) and article feed (#72) hang off.
create index if not exists idx_uwp_due
  on public.user_word_progress(user_id, due_at)
  where due_at is not null;

-- ── Precise, append-only scheduler-input log ────────────────────────────────
-- Distinct from the coarse `study_history` UX log: this records the exact FSRS
-- rating + before/after state per review, for auditability and future FSRS weight
-- optimisation. `source` distinguishes in-context reads from explicit flashcard grades.
create table if not exists public.srs_review_log (
  id                 uuid default gen_random_uuid() primary key,
  user_id            uuid references auth.users not null,
  word_id            text not null,
  rating             smallint not null check (rating between 1 and 4), -- 1=Again 2=Hard 3=Good 4=Easy
  source             text not null check (source in ('reader_skip','reader_click','flashcard')),
  stability_before   double precision,
  stability_after    double precision,
  difficulty_before  double precision,
  difficulty_after   double precision,
  scheduled_days     double precision,   -- interval assigned by this review
  elapsed_days       double precision,   -- actual gap since last_reviewed_at
  reviewed_at        timestamptz default timezone('utc'::text, now()) not null
);

alter table public.srs_review_log enable row level security;

create policy "Users can manage own srs review log"
  on public.srs_review_log for all
  using (auth.uid() = user_id);

create index if not exists idx_srs_review_log_user_word
  on public.srs_review_log(user_id, word_id);

-- ── One-time backfill: seed a schedule from difficulty + last_seen_at ────────
-- Mirrors src/services/srs.ts:
--   stability  S0(d) = 21 * ((10 - d)/9)^1.5 + 0.5   (easy→~21.5d, hard→~0.5d)
--   interval        = 1.906 * S0                     (FSRS-6 interval @ retention 0.85; t is linear in S)
--   due_at          = last_seen_at + interval
--   fsrs_difficulty = difficulty (same 1..10 scale/direction — clean carry-over)
-- Rows with difficulty IS NULL (unseen) stay unscheduled — they belong in #68's queue.
-- Idempotent: only seeds rows not already scheduled.
update public.user_word_progress
set
  stability        = 21 * power((10 - difficulty) / 9.0, 1.5) + 0.5,
  fsrs_difficulty  = difficulty,
  interval_days    = 1.906 * (21 * power((10 - difficulty) / 9.0, 1.5) + 0.5),
  due_at           = last_seen_at
                     + ((1.906 * (21 * power((10 - difficulty) / 9.0, 1.5) + 0.5)) * interval '1 day'),
  last_reviewed_at = last_seen_at,
  reps             = 0,
  lapses           = 0,
  srs_status       = 'review'
where difficulty is not null
  and stability is null;

-- Note: for a large table this bulk UPDATE rewrites many rows; run `vacuum analyze
-- public.user_word_progress;` afterward (autovacuum's 20% trigger may not fire soon).
