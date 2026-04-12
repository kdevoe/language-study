-- 1. Word Progress Table
-- Tracks the current state of mastery for each word per user
create table if not exists public.user_word_progress (
  user_id uuid references auth.users not null,
  word_id text not null, -- JMDict Entry ID or unique word string
  mastery_level text check (mastery_level in ('unseen', 'hard', 'medium', 'easy')) default 'unseen',
  times_seen integer default 0,
  streak integer default 0,
  last_seen_at timestamp with time zone default timezone('utc'::text, now()) not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  
  primary key (user_id, word_id)
);

-- Enable RLS for word progress
alter table public.user_word_progress enable row level security;

-- Users can only manage their own word progress
create policy "Users can manage own word progress"
  on public.user_word_progress for all
  using (auth.uid() = user_id);

-- 2. Study History Table
-- Logs every granular encounter with a word for detailed SRS analysis
create table if not exists public.study_history (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null,
  word_id text not null,
  action text check (action in ('seen', 'lookup', 'mastery_change')) not null,
  metadata jsonb, -- Optional: store context sentence, reading, etc.
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS for study history
alter table public.study_history enable row level security;

-- Users can only manage their own study history
create policy "Users can manage own study history"
  on public.study_history for all
  using (auth.uid() = user_id);

-- Index for performance on lookups
create index if not exists idx_user_word_progress_user_id on public.user_word_progress(user_id);
create index if not exists idx_study_history_user_id on public.study_history(user_id);
create index if not exists idx_study_history_word_id on public.study_history(word_id);
