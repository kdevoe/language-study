-- ============================================================
-- 26_feed_topics.sql
-- User-selectable feed topics (#10): which curated topic groups the news
-- pipeline pulls from for this user.
-- ============================================================
-- APPLY MANUALLY in the Supabase SQL editor (migrations in this repo are not
-- auto-deployed). Safe to run repeatedly — ADD COLUMN IF NOT EXISTS.
--
-- Values are topic ids from the curated catalog (kept in sync between
-- supabase/functions/fetch-raw-news/index.ts FEED_LIST and the client's
-- src/data/feedTopics.ts): world, technology, science, business, sports,
-- culture, health, japan, ai, space, gaming, climate, food, travel, politics.
--
-- NULL (or an absent row) means "never chosen" — fetch-raw-news falls back to
-- the pre-#10 default lineup (world, technology, science). Unknown ids are
-- dropped server-side, and an empty selection also falls back to the defaults,
-- so a stale client can never zero out a user's feed.

ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS feed_topics text[];
