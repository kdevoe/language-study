-- ============================================================
-- 33_song_cover_style.sql
-- Settings › 聞く › Cover art: the reader's art direction for song covers
-- (docs/music-design.md "Cover art"). null = DEFAULT_COVER_STYLE in
-- supabase/functions/_shared/songPrompt.ts. The songwriter only writes the
-- scene; generate-song pairs it with this look.
-- Idempotent.
-- ============================================================
alter table public.user_preferences add column if not exists song_cover_style text;

-- ── audio_orphans: match a file to its row by the uuid prefix ───────────────
-- A repainted cover is uploaded under a new name (<id>-v2.jpg) so cached copies
-- of the old one can't linger; read the id as the name's first 36 characters
-- (a uuid) instead of the whole name minus its extension, so those versions
-- aren't swept as orphans. Otherwise as in 31_songs.sql.
create or replace function public.audio_orphans(p_bucket text, p_table text)
returns setof text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_table not in ('podcast_episodes', 'songs') then
    raise exception 'audio_orphans: unknown table %', p_table;
  end if;
  return query execute format(
    'select o.name from storage.objects o
      where o.bucket_id = $1
        and o.created_at < now() - interval ''1 day''
        and not exists (
          select 1 from public.%I r
           where r.audio_path = o.name
              or r.id::text = left(split_part(o.name, ''/'', 2), 36))',
    p_table) using p_bucket;
end;
$$;

revoke all on function public.audio_orphans(text, text) from public, anon, authenticated;
grant execute on function public.audio_orphans(text, text) to service_role;
