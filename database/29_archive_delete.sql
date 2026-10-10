-- ============================================================
-- 29_archive_delete.sql
-- Swipe-to-delete for LISTEN and LIBRARY (mockup docs/mockups/archive-organize.html).
-- ============================================================
-- APPLY MANUALLY in the Supabase SQL editor. Idempotent: guarded policy.
--
-- Rows already have what they need:
--   podcast_episodes  — "Users can delete own episodes" (28_podcasts.sql)
--   long_form_works   — "Users can manage own works" (FOR ALL, 27); its part
--                       rows in processed_news cascade via work_id.
--
-- Missing piece: the `podcasts` bucket only let users READ their own folder, so
-- deleting an episode would orphan its MP3. Users may now delete objects in
-- their own folder ({user_id}/{episode_id}.mp3). Without this policy the client
-- logs a warning and still deletes the row.

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'Users can delete own podcast audio'
  ) then
    create policy "Users can delete own podcast audio"
      on storage.objects for delete
      using (bucket_id = 'podcasts' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
end $$;

-- ── Verify (run after applying) ──────────────────────────────────────────────
--   SELECT policyname, cmd FROM pg_policies
--   WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname LIKE '%podcast audio%';
--   -- expect: read (SELECT) + delete (DELETE)
