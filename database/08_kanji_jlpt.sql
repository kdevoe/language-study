-- Standalone kanji → JLPT level reference table
-- Source: davidluzgouveia/kanji-data (MIT), derived from KANJIDIC + Tanos JLPT lists
CREATE TABLE IF NOT EXISTS public.kanji_jlpt (
  kanji       CHAR(1) PRIMARY KEY,      -- Single kanji character
  jlpt_level  SMALLINT NOT NULL,         -- 1 (N1) through 5 (N5)
  grade       SMALLINT,                  -- School grade (1-6 = kyouiku, 8 = jouyou remainder)
  strokes     SMALLINT,                  -- Stroke count
  freq        SMALLINT                   -- Newspaper frequency rank
);

CREATE INDEX IF NOT EXISTS idx_kanji_jlpt_level ON public.kanji_jlpt(jlpt_level);

-- RLS: public read-only
ALTER TABLE public.kanji_jlpt ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read-only" ON public.kanji_jlpt FOR SELECT USING (true);
