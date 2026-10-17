-- 35. RTK kanji deck
--
-- A second study deck, separate from the vocabulary deck: Remembering the Kanji
-- (6th edition), one card per kanji, keyword on the front and the kanji on the back.
-- Kanji are keyed by character, have no JMDict entry and must not show up in the
-- vocab queries, the Progress word list or Policy F pacing, so they get their own
-- tables rather than rows in user_word_progress.
--
-- Scheduling is FSRS-6 via src/services/srs.ts (scheduleKanji, request_retention 0.9);
-- deck selection and the Anki seed live in src/services/kanjiDeck.ts. Rows imported
-- from Anki keep Anki's due date (source = 'anki'); kanji introduced by the app's
-- daily drip are source = 'yugen'. See docs/rtk-kanji-deck-plan.md.
--
-- Applied via the Supabase CLI (project convention: by hand, not on deploy).

create table if not exists public.user_kanji_progress (
  user_id           uuid references auth.users not null,
  kanji             text not null,
  heisig_no         smallint not null check (heisig_no between 1 and 3000),
  stability         double precision,                       -- FSRS S, in days
  fsrs_difficulty   double precision
    check (fsrs_difficulty is null or (fsrs_difficulty between 1 and 10)),
  due_at            timestamptz,                            -- next review
  last_reviewed_at  timestamptz,
  interval_days     double precision,
  reps              integer not null default 0,             -- successful reviews
  lapses            integer not null default 0,
  srs_status        text not null default 'new'
    check (srs_status in ('new','learning','review','relearning')),
  introduced_at     timestamptz not null default timezone('utc'::text, now()),
  source            text not null default 'yugen' check (source in ('anki','yugen')),
  updated_at        timestamptz not null default timezone('utc'::text, now()),
  primary key (user_id, kanji)
);

alter table public.user_kanji_progress enable row level security;

create policy "Users can manage own kanji progress"
  on public.user_kanji_progress for all
  using (auth.uid() = user_id);

create index if not exists idx_ukp_due
  on public.user_kanji_progress(user_id, due_at);

-- Append-only review log: the imported Anki history plus every grade in the app.
-- Kept server-side only (never in localStorage); it's the input for fitting FSRS
-- parameters to this user later.
create table if not exists public.kanji_review_log (
  id               uuid default gen_random_uuid() primary key,
  user_id          uuid references auth.users not null,
  kanji            text not null,
  rating           smallint not null check (rating between 1 and 4), -- 1=Again 2=Hard 3=Good 4=Easy
  source           text not null check (source in ('anki_import','flashcard')),
  interval_days    double precision,   -- interval assigned by this review
  stability_after  double precision,
  think_ms         integer,            -- time on the front before flipping (app grades only)
  reviewed_at      timestamptz not null default timezone('utc'::text, now())
);

alter table public.kanji_review_log enable row level security;

create policy "Users can manage own kanji review log"
  on public.kanji_review_log for all
  using (auth.uid() = user_id);

create index if not exists idx_krl_user_kanji
  on public.kanji_review_log(user_id, kanji);
