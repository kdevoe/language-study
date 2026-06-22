-- 22. Expose slightly-harder "stretch" vocab to the candidate pool (#22)
--
-- jmdict_vocab_candidates previously returned only entries at or EASIER than the
-- user's level (`jlpt_level >= user_jlpt`), so an unknown word one level harder than
-- the reader (e.g. N3 for an N4 user) was never a candidate and could never be
-- surfaced as a "new" learning target. The Word Priority Metric (#22) wants those
-- stretch words available so it can rank them just below in-reach words, closest-
-- harder first.
--
-- JLPT numbering: 5 = N5 (easiest) … 1 = N1 (hardest). "1-2 levels harder" therefore
-- means a NUMERICALLY LOWER jlpt_level, so we widen the floor to `user_jlpt - 2`:
--   N4 user (4): now matches N5,N4 (at/easier) + N3,N2 (1-2 harder); N1 still excluded.
--   N5 user (5): matches N5,N4,N3.
-- NULL jlpt_level (untagged/rare) stays excluded — we don't suggest rare vocab to
-- learners. The app's classifyBucket()/proximityRank() decide placement and ordering;
-- this only controls eligibility.
--
-- Return columns are unchanged from migration 10, so CREATE OR REPLACE is sufficient.

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
  is_common   BOOLEAN,
  freq_rank   SMALLINT
)
LANGUAGE sql
STABLE
AS $$
  -- Keep the most frequent matches when capping at max_results: order by
  -- freq_rank (1 = most common, NULL = rare/unranked) BEFORE the LIMIT so common
  -- candidates are never arbitrarily dropped before the app can prioritize them.
  WITH matched_entries AS (
    SELECT DISTINCT e.id, e.jlpt_level, e.common, e.freq_rank
    FROM public.jmdict_senses s
    JOIN public.jmdict_entries e ON e.id = s.entry_id
    WHERE e.jlpt_level IS NOT NULL
      AND e.jlpt_level >= user_jlpt - 2   -- at/easier + up to 2 levels harder (#22)
      AND EXISTS (
        SELECT 1 FROM unnest(s.gloss) g
        WHERE g ILIKE ANY(keywords)
      )
    ORDER BY e.common DESC, e.freq_rank ASC NULLS LAST
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
    m.common                                 AS is_common,
    m.freq_rank                              AS freq_rank
  FROM matched_entries m;
$$;

GRANT EXECUTE ON FUNCTION public.jmdict_vocab_candidates(TEXT[], INT, INT)
  TO anon, authenticated, service_role;
