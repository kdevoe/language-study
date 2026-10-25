-- 43: grammar cards from ハルカ's weekly recap (docs/grammar-cards-plan.md,
-- mockup docs/mockups/grammar-cards.html, 1).
--
-- Each Sunday, after the recap is written, learner-dream/grammarCards.ts writes
-- 2-3 cards per recap pattern: a Japanese sentence with a blank and two choices,
-- one right (answer) and one wrong (wrong, often what the learner actually
-- wrote), and a short English explanation. Every card is checked before it's
-- stored (shape, length, no links; a Haiku pass drops cards where both choices
-- read as natural). They come up mixed into the 単語 session and are scheduled
-- with FSRS like the other decks.
--
-- Written by the service role only. The learner reads, grades (updates the
-- schedule columns) and can delete their own; the review log is theirs to write.

create table if not exists public.grammar_cards (
  id                uuid default gen_random_uuid() primary key,
  user_id           uuid references auth.users not null,
  recap_id          uuid references public.weekly_recaps on delete set null,
  pattern           text not null,                          -- the recap pattern's short label
  before            text not null default '',               -- sentence = before + [blank] + after
  answer            text not null,
  wrong             text not null,
  after             text not null default '',
  explain           text not null,
  from_slip         boolean not null default false,         -- built on the learner's own sentence
  stability         double precision,                       -- FSRS S, in days
  fsrs_difficulty   double precision
    check (fsrs_difficulty is null or (fsrs_difficulty between 1 and 10)),
  due_at            timestamptz,                            -- null until first shown
  last_reviewed_at  timestamptz,
  interval_days     double precision,
  reps              integer not null default 0,
  lapses            integer not null default 0,
  srs_status        text not null default 'new'
    check (srs_status in ('new','learning','review','relearning')),
  introduced_at     timestamptz,                            -- first review
  created_at        timestamptz not null default timezone('utc'::text, now()),
  updated_at        timestamptz not null default timezone('utc'::text, now())
);

alter table public.grammar_cards enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'grammar_cards' and policyname = 'Users can read own grammar cards') then
    create policy "Users can read own grammar cards" on public.grammar_cards for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'grammar_cards' and policyname = 'Users can update own grammar cards') then
    create policy "Users can update own grammar cards" on public.grammar_cards for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'grammar_cards' and policyname = 'Users can delete own grammar cards') then
    create policy "Users can delete own grammar cards" on public.grammar_cards for delete using (auth.uid() = user_id);
  end if;
end $$;
create index if not exists idx_grammar_cards_user on public.grammar_cards(user_id, created_at);
create index if not exists idx_grammar_cards_recap on public.grammar_cards(recap_id);

-- Every grade, append-only. The next recap reads the misses (what was picked).
create table if not exists public.grammar_review_log (
  id               uuid default gen_random_uuid() primary key,
  user_id          uuid references auth.users not null,
  card_id          uuid references public.grammar_cards on delete cascade not null,
  rating           smallint not null check (rating between 1 and 4), -- 1=Again 2=Hard 3=Good 4=Easy
  picked           text,                                  -- the choice tapped
  correct          boolean not null,
  interval_days    double precision,
  stability_after  double precision,
  think_ms         integer,
  reviewed_at      timestamptz not null default timezone('utc'::text, now())
);

alter table public.grammar_review_log enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'grammar_review_log' and policyname = 'Users can manage own grammar review log') then
    create policy "Users can manage own grammar review log" on public.grammar_review_log for all
      using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;
create index if not exists idx_grl_user_time on public.grammar_review_log(user_id, reviewed_at);
