-- Add is_approved column to waitlist table
alter table public.waitlist 
add column if not exists is_approved boolean default false;

-- Create an RPC to check if an email is approved, waitlisted, or not joined
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
