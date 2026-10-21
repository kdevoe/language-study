-- 41: ハルカ's weekly recap (docs/mockups/weekly-recap.html, design-system §6.17).
--
-- The Sunday dream (learner-dream mode 'weekly', cron 07:00 UTC) reads the week's
-- corrections and flashcard misses and writes one report: 2-3 recurring patterns
-- with the learner's own slips as examples, words that kept slipping, what got
-- solid. Sunday's nightly brief puts the teaser first in its openers, so the
-- Home card's line is the recap, and the chat shows the report as one block that
-- opens a sheet.
--
-- report: { intro, lede, patterns: [{ title, count, examples: [{ was, now, fix }],
--           explain: [..], tip }], words: [{ word, meaning }], solid }
-- Written by the service role only; the learner reads (and can delete) their own.

create table if not exists public.weekly_recaps (
  id          uuid default gen_random_uuid() primary key,
  user_id     uuid references auth.users not null,
  week_start  date not null,
  week_end    date not null,
  title       text not null,
  teaser      text not null,          -- ハルカ's Japanese line for the Home card
  report      jsonb not null,
  usage       jsonb,
  created_at  timestamptz not null default now(),
  unique (user_id, week_end)
);
alter table public.weekly_recaps enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'weekly_recaps' and policyname = 'Users can read own weekly recaps') then
    create policy "Users can read own weekly recaps" on public.weekly_recaps for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'weekly_recaps' and policyname = 'Users can delete own weekly recaps') then
    create policy "Users can delete own weekly recaps" on public.weekly_recaps for delete using (auth.uid() = user_id);
  end if;
end $$;
create index if not exists idx_weekly_recaps_user on public.weekly_recaps(user_id, created_at desc);
