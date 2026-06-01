-- ============================================================
-- get_unseen_common_words: per-level "discover" list for the Progress screen
-- ============================================================
-- Returns the most common words at an EXACT JLPT level that the user has not yet
-- encountered, ordered by frequency (most common first), with reading and the
-- first JMDict gloss for context.
--
-- Frequency comes from jmdict_entries.freq_rank (database/12): the best (lowest)
-- nf01..nf48 band across an entry's forms, where 1 = most common and NULL = a
-- long-tail word with no nf band. We order common entries with a real band first
-- (freq_rank ASC NULLS LAST), falling back to the coarse `common` flag, so the
-- list surfaces high-value vocabulary the learner hasn't tracked yet.
--
-- An entry is "seen" if any of its kanji or kana surface forms is in p_seen_words
-- (the store keys progress by surface form).
--
--   p_level      : 1 (N1) .. 5 (N5)  — exact match
--   p_seen_words : surface words the user already tracks (excluded)
--   p_limit      : max rows

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
  )
  SELECT
    -- Prefer the kanji surface form; fall back to kana for kana-only entries.
    COALESCE(
      (SELECT k.text FROM public.jmdict_kanji k
         WHERE k.entry_id = c.id ORDER BY k.id LIMIT 1),
      (SELECT a.text FROM public.jmdict_kana a
         WHERE a.entry_id = c.id ORDER BY a.id LIMIT 1)
    ) AS word,
    (SELECT a.text FROM public.jmdict_kana a
       WHERE a.entry_id = c.id ORDER BY a.id LIMIT 1) AS reading,
    c.freq_rank::INTEGER AS rank,
    (SELECT array_to_string(s.gloss, '; ') FROM public.jmdict_senses s
       WHERE s.entry_id = c.id ORDER BY s.id LIMIT 1) AS meaning
  FROM candidates c
  ORDER BY c.freq_rank ASC NULLS LAST, c.common DESC, c.id ASC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.get_unseen_common_words(SMALLINT, TEXT[], INTEGER)
  TO anon, authenticated;
