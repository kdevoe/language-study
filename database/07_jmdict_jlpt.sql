-- Add JLPT level column to jmdict_entries
-- Values: 1 (N1) through 5 (N5), NULL = not in any JLPT list
ALTER TABLE public.jmdict_entries
  ADD COLUMN IF NOT EXISTS jlpt_level SMALLINT DEFAULT NULL;

-- Index for filtering by JLPT level
CREATE INDEX IF NOT EXISTS idx_jmdict_entries_jlpt ON public.jmdict_entries(jlpt_level)
  WHERE jlpt_level IS NOT NULL;
