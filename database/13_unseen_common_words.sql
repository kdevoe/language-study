-- ============================================================
-- get_unseen_common_words: per-level "discover" list for the Progress screen
-- ============================================================
-- Returns the most common words at an EXACT JLPT level that the user has not yet
-- encountered, ordered by frequency rank (1 = most common), with reading and the
-- first JMDict gloss for context.
--
-- word_frequency (database/12) is a flat list keyed by surface form with no JLPT
-- tag or reading, so this joins it to JMDict on surface form to recover the
-- level (jmdict_entries.jlpt_level), reading (jmdict_kana) and gloss
-- (jmdict_senses). Already-seen surface words are excluded.
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
  WITH level_forms AS (
    -- All kanji + kana surface forms belonging to entries at this JLPT level.
    SELECT k.text AS form, k.entry_id
    FROM public.jmdict_kanji k
    JOIN public.jmdict_entries e ON e.id = k.entry_id
    WHERE e.jlpt_level = p_level
    UNION
    SELECT a.text AS form, a.entry_id
    FROM public.jmdict_kana a
    JOIN public.jmdict_entries e ON e.id = a.entry_id
    WHERE e.jlpt_level = p_level
  ),
  matched AS (
    SELECT lf.entry_id, wf.word AS form, wf.rank
    FROM public.word_frequency wf
    JOIN level_forms lf ON lf.form = wf.word
    WHERE NOT (wf.word = ANY(p_seen_words))
  ),
  best AS (
    -- Lowest (most common) rank per entry, so an entry isn't listed twice via
    -- two surface forms.
    SELECT DISTINCT ON (entry_id) entry_id, form, rank
    FROM matched
    ORDER BY entry_id, rank ASC
  )
  SELECT
    b.form AS word,
    (SELECT a.text FROM public.jmdict_kana a
       WHERE a.entry_id = b.entry_id ORDER BY a.id LIMIT 1) AS reading,
    b.rank,
    (SELECT array_to_string(s.gloss, '; ') FROM public.jmdict_senses s
       WHERE s.entry_id = b.entry_id ORDER BY s.id LIMIT 1) AS meaning
  FROM best b
  ORDER BY b.rank ASC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.get_unseen_common_words(SMALLINT, TEXT[], INTEGER)
  TO anon, authenticated;
