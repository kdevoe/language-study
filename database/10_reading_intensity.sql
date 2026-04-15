-- ============================================================
-- Reading Intensity + Vocab Palette RPC
-- ============================================================
--
-- Adds a `reading_intensity` preset to user_preferences, plus an RPC
-- that finds JMDict candidate words whose English glosses match any of
-- a set of topic keywords. Used by process-article to build a targeted
-- vocabulary palette before article rewriting.
-- ============================================================

-- 1. reading_intensity column on user_preferences
--    leisure   -> ~98% known / 1.5% review / 0.5% new
--    balanced  -> ~95% known / 4% review / 1% new  (default)
--    intensive -> ~90% known / 8% review / 2% new

ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS reading_intensity TEXT DEFAULT 'balanced';

ALTER TABLE public.user_preferences
  DROP CONSTRAINT IF EXISTS user_preferences_reading_intensity_check;

ALTER TABLE public.user_preferences
  ADD CONSTRAINT user_preferences_reading_intensity_check
  CHECK (reading_intensity IN ('leisure', 'balanced', 'intensive'));


-- 2. jmdict_vocab_candidates RPC
--    Given an array of English keyword patterns (each already wrapped
--    in '%...%' by the caller), return matching entries at or below
--    the user's JLPT level, along with their preferred kanji surface.
--    JLPT numbering: 5 = N5 (easiest), 1 = N1 (hardest). A user at N4
--    (jlpt_level = 4) can handle N5 and N4 vocab, so we filter
--    `entry.jlpt_level >= user_jlpt`. NULL jlpt_level = untagged/rare
--    and is excluded from the candidate pool (we don't suggest rare
--    vocab to learners).

CREATE OR REPLACE FUNCTION public.jmdict_vocab_candidates(
  keywords     TEXT[],
  user_jlpt    INT,
  max_results  INT DEFAULT 200
)
RETURNS TABLE (
  entry_id    TEXT,
  jlpt_level  SMALLINT,
  kanji       TEXT,
  kana        TEXT,
  is_common   BOOLEAN
)
LANGUAGE sql
STABLE
AS $$
  WITH matched_entries AS (
    SELECT DISTINCT e.id, e.jlpt_level, e.common
    FROM public.jmdict_senses s
    JOIN public.jmdict_entries e ON e.id = s.entry_id
    WHERE e.jlpt_level IS NOT NULL
      AND e.jlpt_level >= user_jlpt
      AND EXISTS (
        SELECT 1 FROM unnest(s.gloss) g
        WHERE g ILIKE ANY(keywords)
      )
    LIMIT max_results
  )
  SELECT
    m.id                                     AS entry_id,
    m.jlpt_level                             AS jlpt_level,
    (SELECT k.text FROM public.jmdict_kanji k
       WHERE k.entry_id = m.id
       ORDER BY k.common DESC, k.id ASC LIMIT 1) AS kanji,
    (SELECT ka.text FROM public.jmdict_kana ka
       WHERE ka.entry_id = m.id
       ORDER BY ka.common DESC, ka.id ASC LIMIT 1) AS kana,
    m.common                                 AS is_common
  FROM matched_entries m;
$$;

GRANT EXECUTE ON FUNCTION public.jmdict_vocab_candidates(TEXT[], INT, INT)
  TO anon, authenticated, service_role;
