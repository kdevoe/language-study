-- ============================================================
-- 20_source_fullness.sql
-- Track how much real source material reached Gemini per article, so we can
-- measure "what % of articles got full text vs a bare teaser snippet" and tune
-- sourcing toward the full-text path (which produces markedly better articles).
-- ============================================================
-- APPLY MANUALLY in the Supabase SQL editor (migrations in this repo are not
-- auto-deployed). Safe to run repeatedly — ADD COLUMN IF NOT EXISTS + a guarded
-- CHECK constraint.
--
-- WHY: process-article upgrades thin teasers to full article text via Jina
-- Reader, but the outcome was logged and then discarded. These columns persist
-- it so the win/loss is queryable:
--
--   source_kind   full | partial | snippet
--     full     — extraction succeeded and yielded a substantial body (≥1500 chars)
--     partial  — richer than a bare teaser (e.g. a full-text RSS body), but thin
--     snippet  — only the ~150-200 char NewsAPI/teaser fallback reached Gemini
--   source_chars  the final char count of the source block sent to Gemini
--
-- Existing rows predate tracking; they stay NULL (unknown) rather than being
-- mislabeled. Only newly produced articles populate these.

-- ── Fullness columns ─────────────────────────────────────────────────────────
ALTER TABLE public.processed_news
  ADD COLUMN IF NOT EXISTS source_kind  text,
  ADD COLUMN IF NOT EXISTS source_chars integer;

-- Guarded CHECK (ALTER ... ADD CONSTRAINT is not itself idempotent). NULL passes
-- the check, so legacy rows are unaffected.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'processed_news_source_kind_check'
  ) THEN
    ALTER TABLE public.processed_news
      ADD CONSTRAINT processed_news_source_kind_check
      CHECK (source_kind IS NULL OR source_kind IN ('full', 'partial', 'snippet'));
  END IF;
END $$;

-- ── Reporting query (run ad hoc) ─────────────────────────────────────────────
-- What % of articles produced in the last 7 days got full text vs a snippet:
--
--   SELECT
--     source_kind,
--     count(*)                                                  AS articles,
--     round(100.0 * count(*) / sum(count(*)) OVER (), 1)        AS pct,
--     round(avg(source_chars))                                  AS avg_chars
--   FROM public.processed_news
--   WHERE created_at > now() - interval '7 days'
--     AND source_kind IS NOT NULL
--   GROUP BY source_kind
--   ORDER BY articles DESC;
