-- Waitlist Table
create table public.waitlist (
  id uuid default gen_random_uuid() primary key,
  email text unique not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS
alter table public.waitlist enable row level security;

-- Allow anonymous users to INSERT into the waitlist
create policy "Anyone can insert to waitlist"
  on public.waitlist
  for insert
  to public
  with check (true);

-- No read access to public/anon to keep emails secret
