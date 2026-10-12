-- ============================================================
-- 34_playlists.sql
-- 音楽 lists (mockups docs/mockups/music-playlists.html option 3 and
-- docs/mockups/music-lists.html): named lists of the reader's own songs.
-- ============================================================
-- APPLY MANUALLY in the Supabase SQL editor. Idempotent. Run after 31_songs.sql.
--
-- The client owns these rows outright (RLS per user): it creates, renames and
-- deletes lists, and adds, removes and reorders their songs. `touched_at` moves
-- whenever a list is made or a song is added, and orders both the shelf and the
-- リストに追加 sheet (last used first). Deleting a song or a list cascades.

create table if not exists public.playlists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null default auth.uid(),
  name text not null check (char_length(name) between 1 and 40),
  created_at timestamptz not null default now(),
  touched_at timestamptz not null default now()
);

create table if not exists public.playlist_songs (
  playlist_id uuid not null references public.playlists on delete cascade,
  song_id uuid not null references public.songs on delete cascade,
  user_id uuid references auth.users not null default auth.uid(),
  position int not null default 0,
  added_at timestamptz not null default now(),
  primary key (playlist_id, song_id)
);

create index if not exists playlists_user_idx on public.playlists (user_id, touched_at desc);
create index if not exists playlist_songs_song_idx on public.playlist_songs (song_id);

alter table public.playlists enable row level security;
alter table public.playlist_songs enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'playlists' and policyname = 'Users manage own playlists') then
    create policy "Users manage own playlists" on public.playlists for all
      using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
  -- A row may only join a list and a song that are both the reader's own.
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'playlist_songs' and policyname = 'Users manage own playlist songs') then
    create policy "Users manage own playlist songs" on public.playlist_songs for all
      using (auth.uid() = user_id)
      with check (
        auth.uid() = user_id
        and exists (select 1 from public.playlists p where p.id = playlist_id and p.user_id = auth.uid())
        and exists (select 1 from public.songs s where s.id = song_id and s.user_id = auth.uid())
      );
  end if;
end $$;
