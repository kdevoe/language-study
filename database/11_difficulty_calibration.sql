-- ============================================================
-- Difficulty Calibration Offset
-- ============================================================
--
-- A per-user fine-tuning dial that nudges generated articles easier or
-- harder *within* the user's chosen JLPT level — the thing that makes a level
-- actually "dial in". Driven by the per-article "too easy / just right /
-- too hard" feedback control in the Reader, and read by process-article when
-- it builds the grammar directive for the rewrite prompt.
--
--   -1.0  => much easier  (shortest sentences, simplest patterns only)
--    0.0  => on-level      (default)
--   +1.0  => much harder  (long compound sentences, some next-level grammar)
--
-- Resets to 0 whenever the user explicitly changes their JLPT level, so each
-- level starts from a clean calibration.
-- ============================================================

ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS difficulty_offset REAL DEFAULT 0;

ALTER TABLE public.user_preferences
  DROP CONSTRAINT IF EXISTS user_preferences_difficulty_offset_check;

ALTER TABLE public.user_preferences
  ADD CONSTRAINT user_preferences_difficulty_offset_check
  CHECK (difficulty_offset >= -1 AND difficulty_offset <= 1);
