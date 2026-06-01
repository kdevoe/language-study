-- ============================================================
-- 14_unseen_common_words_perf.sql
-- Performance rewrite of get_unseen_common_words (supersedes database/13).
-- ============================================================
-- APPLY MANUALLY in the Supabase SQL editor (migrations in this repo are not
-- auto-deployed). Safe to run repeatedly — CREATE OR REPLACE + IF NOT EXISTS.
--
-- WHY: the original (database/13) computed FOUR correlated subqueries
-- (kanji form, kana fallback, reading, gloss) for EVERY unseen candidate at the
-- level — often hundreds to thousands of rows — and only THEN ordered by
-- frequency and applied LIMIT. On the shared Postgres compute that heavy query
-- pegs CPU and starves unrelated queries (single-row jmdict_entries fetches,
-- processed_news reads, even auth), surfacing app-wide as statement timeouts
-- (SQLSTATE 57014) and "Lookup failed" / articles that do nothing on tap.
--
-- FIX: order + LIMIT the candidate set FIRST (ordering only needs columns from
-- jmdict_entries), then fetch the display fields via LATERAL joins for just the
-- top p_limit rows. Identical results, but the per-row lookups run ~p_limit
-- times instead of once per candidate. The client also now sends only this
-- level's seen words in p_seen_words, keeping the anti-joins cheap.

CREATE OR REPLACE FUNCTION public.get_unseen_common_words(
  p_level      SMALLINT,
  p_seen_words TEXT[] DEFAULT '{}',
  p_limit      INTEGER DEFAULT 40
)
RETURNS TABLE (
  word    TEXT,
  reading TEXT,
  rank    INTEGER,
  meaning TEXT
)
LANGUAGE sql
STABLE
AS $$
  WITH candidates AS (
    SELECT e.id, e.freq_rank, e.common
    FROM public.jmdict_entries e
    WHERE e.jlpt_level = p_level
      AND NOT EXISTS (
        SELECT 1 FROM public.jmdict_kanji k
        WHERE k.entry_id = e.id AND k.text = ANY(p_seen_words)
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.jmdict_kana a
        WHERE a.entry_id = e.id AND a.text = ANY(p_seen_words)
      )
    -- Order + limit BEFORE the per-row display lookups below. Ordering only needs
    -- columns already in this CTE, so this is identical to ordering the full
    -- result, but the LATERAL joins then run only p_limit times.
    ORDER BY e.freq_rank ASC NULLS LAST, e.common DESC, e.id ASC
    LIMIT p_limit
  )
  SELECT
    COALESCE(kf.text, kr.text) AS word,   -- prefer kanji form, fall back to kana
    kr.text                    AS reading,
    c.freq_rank::INTEGER       AS rank,
    sg.meaning                 AS meaning
  FROM candidates c
  LEFT JOIN LATERAL (
    SELECT k.text FROM public.jmdict_kanji k
    WHERE k.entry_id = c.id ORDER BY k.id LIMIT 1
  ) kf ON TRUE
  LEFT JOIN LATERAL (
    SELECT a.text FROM public.jmdict_kana a
    WHERE a.entry_id = c.id ORDER BY a.id LIMIT 1
  ) kr ON TRUE
  LEFT JOIN LATERAL (
    SELECT array_to_string(s.gloss, '; ') AS meaning FROM public.jmdict_senses s
    WHERE s.entry_id = c.id ORDER BY s.id LIMIT 1
  ) sg ON TRUE
  ORDER BY c.freq_rank ASC NULLS LAST, c.common DESC, c.id ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_unseen_common_words(SMALLINT, TEXT[], INTEGER)
  TO anon, authenticated;

-- Composite index so the candidate ORDER BY ... LIMIT can be satisfied without a
-- full sort of the level's entries. Optional but recommended.
CREATE INDEX IF NOT EXISTS idx_jmdict_entries_level_freq
  ON public.jmdict_entries (jlpt_level, freq_rank ASC NULLS LAST, common DESC, id);

-- ── Verify the FK indexes from database/06 actually exist in prod ────────────
-- Migrations here are applied by hand, so an index defined in a .sql file is not
-- guaranteed to be live. The NOT EXISTS anti-joins and LATERAL lookups all rely
-- on these. Run this and confirm all five rows come back:
--
--   SELECT indexname FROM pg_indexes
--   WHERE schemaname = 'public'
--     AND indexname IN (
--       'idx_jmdict_kanji_entry', 'idx_jmdict_kana_entry',
--       'idx_jmdict_senses_entry', 'idx_jmdict_kanji_text',
--       'idx_jmdict_entries_jlpt'
--     );
--
-- Any missing → re-run database/06_jmdict_schema.sql (and 07) to create them.
