-- Add is_approved column to waitlist table
alter table public.waitlist 
add column if not exists is_approved boolean default false;

-- Create an RPC to check if an email is approved
-- We use SECURITY DEFINER to allow checking even if RLS would normally block it
create or replace function public.check_is_approved(p_email text)
returns boolean
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
  
  return coalesce(is_appr, false);
end;
$$;
