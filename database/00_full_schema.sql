-- 1. Waitlist Table & Whitelist Logic
create table if not exists public.waitlist (
  id uuid default gen_random_uuid() primary key,
  email text unique not null,
  is_approved boolean default false,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS for waitlist
alter table public.waitlist enable row level security;

-- Allow anyone to join the waitlist
create policy "Anyone can join waitlist"
  on public.waitlist for insert
  with check (true);

-- 2. News Cache Table
create table if not exists public.processed_news (
  id text primary key,
  user_id uuid references auth.users not null,
  title text,
  content jsonb,
  metadata jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS for news cache
alter table public.processed_news enable row level security;

-- Users can only see/edit their own processed news
create policy "Users can manage own news"
  on public.processed_news for all
  using (auth.uid() = user_id);

-- 3. Whitelist Check RPC (returns 'approved', 'waitlisted', or 'not_joined')
drop function if exists public.check_is_approved(text);
create or replace function public.check_is_approved(p_email text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  is_appr boolean;
begin
  select is_approved into is_appr
  from waitlist
  where email = p_email;
  
  if is_appr is null then
    return 'not_joined';
  elsif is_appr = true then
    return 'approved';
  else
    return 'waitlisted';
  end if;
end;
$$;
