-- 44: grammar cards rotate their sentences (docs/grammar-cards-plan.md, "Rotation").
--
-- A grammar card (database/43) becomes one rule ("に for where you stay, で for
-- where something happens") with one FSRS schedule, and a pool of sentences that
-- test it. Each review shows the sentence seen least recently, so the learner
-- applies the rule instead of remembering a sentence. The Sunday run tops up a
-- pool once every sentence in it has been seen, and a slip ハルカ sees again adds
-- sentences to the rule's existing card instead of making a second one.
--
-- grammar_cards keeps its sentence columns (before/answer/wrong/after/from_slip)
-- filled with the card's first sentence, so an app that hasn't updated still
-- shows that one. Written by the service role only; the learner reads them and
-- marks a sentence shown (shown_at, the only column they can update).

alter table public.grammar_cards add column if not exists rule text;   -- the one rule, in English
update public.grammar_cards set rule = pattern where rule is null;

create table if not exists public.grammar_sentences (
  id          uuid default gen_random_uuid() primary key,
  user_id     uuid references auth.users not null,
  card_id     uuid references public.grammar_cards on delete cascade not null,
  recap_id    uuid references public.weekly_recaps on delete set null,  -- the recap that added it
  before      text not null default '',               -- sentence = before + [blank] + after
  answer      text not null,
  wrong       text not null,
  after       text not null default '',
  from_slip   boolean not null default false,         -- built on the learner's own sentence
  shown_at    timestamptz,                            -- last time it came up; null = not yet
  created_at  timestamptz not null default timezone('utc'::text, now())
);

alter table public.grammar_sentences enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'grammar_sentences' and policyname = 'Users can read own grammar sentences') then
    create policy "Users can read own grammar sentences" on public.grammar_sentences for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'grammar_sentences' and policyname = 'Users can mark own grammar sentences shown') then
    create policy "Users can mark own grammar sentences shown" on public.grammar_sentences for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;
-- The text is the server's: a learner can only move shown_at.
revoke update on public.grammar_sentences from anon, authenticated;
grant update (shown_at) on public.grammar_sentences to authenticated;
create index if not exists idx_grammar_sentences_card on public.grammar_sentences(card_id);
create index if not exists idx_grammar_sentences_recap on public.grammar_sentences(recap_id);

-- Every existing card's sentence becomes the first in its pool.
insert into public.grammar_sentences (user_id, card_id, recap_id, before, answer, wrong, after, from_slip, shown_at, created_at)
select c.user_id, c.id, c.recap_id, c.before, c.answer, c.wrong, c.after, c.from_slip, c.last_reviewed_at, c.created_at
from public.grammar_cards c
where not exists (select 1 from public.grammar_sentences s where s.card_id = c.id);

-- Which sentence a grade was on.
alter table public.grammar_review_log
  add column if not exists sentence_id uuid references public.grammar_sentences on delete set null;
