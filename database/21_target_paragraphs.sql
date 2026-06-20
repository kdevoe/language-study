-- ============================================================
-- 21_target_paragraphs.sql
-- Per-user article-length targets, keyed by how much real source material the
-- article was built from (source_kind: full | partial | snippet — see
-- 20_source_fullness.sql). Length follows source fullness, not JLPT level: a
-- full-text source supports a longer article, while a thin teaser should stay
-- short to avoid padding ("50% means half"). JLPT level still drives complexity.
-- ============================================================
-- APPLY MANUALLY in the Supabase SQL editor (migrations in this repo are not
-- auto-deployed). Safe to run repeatedly — ADD COLUMN IF NOT EXISTS + guarded
-- CHECKs. Existing rows get the defaults below; process-article also falls back
-- to the same defaults when a column is NULL.

ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS target_paragraphs_full    smallint NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS target_paragraphs_partial smallint NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS target_paragraphs_snippet smallint NOT NULL DEFAULT 3;

-- Keep targets in a sane range (1–10 paragraphs). Guarded so re-running is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_preferences_target_paragraphs_check'
  ) THEN
    ALTER TABLE public.user_preferences
      ADD CONSTRAINT user_preferences_target_paragraphs_check
      CHECK (
        target_paragraphs_full    BETWEEN 1 AND 10 AND
        target_paragraphs_partial BETWEEN 1 AND 10 AND
        target_paragraphs_snippet BETWEEN 1 AND 10
      );
  END IF;
END $$;
