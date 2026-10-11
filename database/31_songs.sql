-- ============================================================
-- 31_songs.sql
-- Generated songs (聞く › 音楽, mockup docs/mockups/music.html): song rows + a
-- private Storage bucket for the MP3s and cover art.
-- ============================================================
-- APPLY MANUALLY in the Supabase SQL editor, BEFORE deploying generate-song or
-- the 音楽 frontend. Idempotent. Run after 30_audio_cleanup.sql (it replaces
-- audio_orphans() to cover this table too).
--
-- The generate-song edge function owns the lifecycle (service role):
--   writing → composing → ready      (any error → failed, retryable)
-- Claude writes the plan (title, style description, lyrics per section, cover
-- prompt); ElevenLabs Music sings it with phrase timestamps; Gemini paints the
-- cover. The client reads its own rows (RLS) and writes back only play stats.
--
-- No real artist or song names are stored: `request` holds the listener's own
-- description only until the writing stage replaces it with an artist-free
-- rewrite (a failed row keeps it until audio-cleanup deletes the row after 7 days).

create table if not exists public.songs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null,
  title text not null default '',
  style_key text not null,          -- a preset id (songPrompt.ts STYLES) or 'custom'
  request text,                     -- the listener's description ('custom'), artist-free once written
  theme text,                       -- optional: what the song is about
  minutes int not null default 2,
  origin text not null default 'manual' check (origin in ('manual', 'auto')),  -- auto: the every-other-day cron (32)
  status text not null default 'writing'
    check (status in ('writing', 'composing', 'ready', 'failed')),
  status_detail text,
  plan jsonb,                       -- { title, description, cover_prompt, sections: [...], vocab: [...] }
  timing jsonb,                     -- per section, per line: { start, end } ms, from ElevenLabs word timestamps
  audio_path text,                  -- {user_id}/{id}.mp3 in the `music` bucket
  cover_path text,                  -- {user_id}/{id}.jpg in the `music` bucket (null if the cover failed)
  duration_ms int,
  song_model text,
  usage jsonb,                      -- lyric tokens, timings
  play_count int not null default 0,
  last_played_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.songs enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'songs' and policyname = 'Users can read own songs') then
    create policy "Users can read own songs" on public.songs for select using (auth.uid() = user_id);
  end if;
  -- Play stats only; generation fields are written by the edge function (service role).
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'songs' and policyname = 'Users can update own songs') then
    create policy "Users can update own songs" on public.songs for update using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'songs' and policyname = 'Users can delete own songs') then
    create policy "Users can delete own songs" on public.songs for delete using (auth.uid() = user_id);
  end if;
end $$;

create index if not exists idx_songs_user_created on public.songs (user_id, created_at desc);

-- ── Storage: private `music` bucket ──────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('music', 'music', false)
on conflict (id) do nothing;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'Users can read own music') then
    create policy "Users can read own music" on storage.objects for select
      using (bucket_id = 'music' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'Users can delete own music') then
    create policy "Users can delete own music" on storage.objects for delete
      using (bucket_id = 'music' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
end $$;

-- ── audio_orphans: now for songs too ─────────────────────────────────────────
-- Same rule as 30_audio_cleanup.sql, with the id read from any file extension
-- (a song has an .mp3 and a .jpg, both named by its id).
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
              or r.id::text = regexp_replace(split_part(o.name, ''/'', 2), ''\.[A-Za-z0-9]+$'', ''''))',
    p_table) using p_bucket;
end;
$$;

revoke all on function public.audio_orphans(text, text) from public, anon, authenticated;
grant execute on function public.audio_orphans(text, text) to service_role;
