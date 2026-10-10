-- ============================================================
-- 28_podcasts.sql
-- Generated podcasts (#12, docs/podcast-design.md §5): episode rows + a private
-- Storage bucket for the MP3s.
-- ============================================================
-- APPLY MANUALLY in the Supabase SQL editor. Idempotent: CREATE TABLE/INDEX
-- IF NOT EXISTS, guarded policies, ON CONFLICT bucket insert.
--
-- ⚠️  APPLY THIS *BEFORE* deploying generate-podcast or the LISTEN frontend.
--
-- Model: an EPISODE is one generated two-host dialogue. The generate-podcast
-- edge function owns the lifecycle (service role):
--   scripting → voicing → ready      (any error → failed, retryable)
-- The client reads its own rows (RLS), streams audio via a signed URL from the
-- `podcasts` bucket, and writes back only listen_position_ms / listened_at.

create table if not exists public.podcast_episodes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null,
  title text not null default '',
  -- article: companion to a processed_news row · digest: today's feed stories ·
  -- topic / text / url: on-demand from the LISTEN tab's + sheet.
  source_kind text not null check (source_kind in ('article', 'digest', 'topic', 'text', 'url')),
  source_ref text,                -- processed_news id / topic / url / digest date (YYYY-MM-DD)
  source_payload jsonb,           -- pasted text etc. needed to (re)generate the script
  minutes int not null default 5,
  status text not null default 'scripting'
    check (status in ('scripting', 'voicing', 'ready', 'failed')),
  status_detail text,             -- last error, for the retry affordance + debugging
  cast_ids jsonb,                 -- { host: persona id, guest: persona id } — drives rotation
  script jsonb,                   -- { title, turns: [{speaker, text}], vocab: [...] }
  alignment jsonb,                -- per turn: { start, end, t: [char start ms] }
  audio_path text,                -- object path inside the `podcasts` bucket
  duration_ms int,
  tts_model text,
  usage jsonb,                    -- script tokens, tts chars/requests, timings
  listen_position_ms int not null default 0,
  listened_at timestamptz,        -- set when playback reaches the end
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.podcast_episodes enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'podcast_episodes'
      and policyname = 'Users can read own episodes'
  ) then
    create policy "Users can read own episodes"
      on public.podcast_episodes for select
      using (auth.uid() = user_id);
  end if;
  -- Playback position / listened flag only; generation fields are written by
  -- the edge function with the service role (which bypasses RLS).
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'podcast_episodes'
      and policyname = 'Users can update own episodes'
  ) then
    create policy "Users can update own episodes"
      on public.podcast_episodes for update
      using (auth.uid() = user_id);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'podcast_episodes'
      and policyname = 'Users can delete own episodes'
  ) then
    create policy "Users can delete own episodes"
      on public.podcast_episodes for delete
      using (auth.uid() = user_id);
  end if;
end $$;

-- LISTEN list: this user's episodes, newest first. Also serves the rotation
-- history (last N cast_ids) and the in-flight / one-digest-per-day guards.
create index if not exists idx_podcast_episodes_user_created
  on public.podcast_episodes (user_id, created_at desc);

-- ── Audio storage ────────────────────────────────────────────────────────────
-- Private bucket; objects live at {user_id}/{episode_id}.mp3. Only the edge
-- function writes (service role); users can read their own folder, which is
-- what createSignedUrl needs.
insert into storage.buckets (id, name, public)
values ('podcasts', 'podcasts', false)
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'Users can read own podcast audio'
  ) then
    create policy "Users can read own podcast audio"
      on storage.objects for select
      using (bucket_id = 'podcasts' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
end $$;
