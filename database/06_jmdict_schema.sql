-- ============================================================
-- JMDict-Simplified Schema for Supabase
-- Source: https://github.com/scriptin/jmdict-simplified
-- ============================================================

-- 1. Root entry table
CREATE TABLE IF NOT EXISTS public.jmdict_entries (
  id        TEXT PRIMARY KEY,           -- JMDict sequence number (e.g. "1000010")
  common    BOOLEAN DEFAULT FALSE       -- TRUE if any kanji/kana form is marked common
);

-- 2. Kanji (surface form) table
CREATE TABLE IF NOT EXISTS public.jmdict_kanji (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id  TEXT NOT NULL REFERENCES public.jmdict_entries(id) ON DELETE CASCADE,
  text      TEXT NOT NULL,              -- e.g. "食べる"
  common    BOOLEAN DEFAULT FALSE,
  info      TEXT[] DEFAULT '{}'         -- e.g. {"ateji", "irregular"}
);

-- 3. Kana (reading) table
CREATE TABLE IF NOT EXISTS public.jmdict_kana (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id          TEXT NOT NULL REFERENCES public.jmdict_entries(id) ON DELETE CASCADE,
  text              TEXT NOT NULL,      -- e.g. "たべる"
  common            BOOLEAN DEFAULT FALSE,
  applies_to_kanji  TEXT[] DEFAULT '{}' -- empty = applies to all kanji forms
);

-- 4. Senses (definitions) table
CREATE TABLE IF NOT EXISTS public.jmdict_senses (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id  TEXT NOT NULL REFERENCES public.jmdict_entries(id) ON DELETE CASCADE,
  pos       TEXT[] DEFAULT '{}',        -- part of speech tags
  field     TEXT[] DEFAULT '{}',        -- field of application
  misc      TEXT[] DEFAULT '{}',        -- miscellaneous info
  info      TEXT[] DEFAULT '{}',        -- additional sense info
  gloss     TEXT[] DEFAULT '{}'         -- English glosses as text array
);

-- ============================================================
-- Indexes for fast lookups
-- ============================================================

-- B-tree indexes for exact match on surface forms
CREATE INDEX IF NOT EXISTS idx_jmdict_kanji_text ON public.jmdict_kanji(text);
CREATE INDEX IF NOT EXISTS idx_jmdict_kana_text  ON public.jmdict_kana(text);

-- Foreign key indexes for joins
CREATE INDEX IF NOT EXISTS idx_jmdict_kanji_entry ON public.jmdict_kanji(entry_id);
CREATE INDEX IF NOT EXISTS idx_jmdict_kana_entry  ON public.jmdict_kana(entry_id);
CREATE INDEX IF NOT EXISTS idx_jmdict_senses_entry ON public.jmdict_senses(entry_id);

-- GIN trigram indexes for partial/fuzzy search (optional, enable pg_trgm first)
-- CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- CREATE INDEX IF NOT EXISTS idx_jmdict_kanji_trgm ON public.jmdict_kanji USING gin(text gin_trgm_ops);
-- CREATE INDEX IF NOT EXISTS idx_jmdict_kana_trgm  ON public.jmdict_kana  USING gin(text gin_trgm_ops);

-- ============================================================
-- Row Level Security (public read-only, no writes from client)
-- ============================================================
ALTER TABLE public.jmdict_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jmdict_kanji   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jmdict_kana    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jmdict_senses  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read-only" ON public.jmdict_entries FOR SELECT USING (true);
CREATE POLICY "Public read-only" ON public.jmdict_kanji   FOR SELECT USING (true);
CREATE POLICY "Public read-only" ON public.jmdict_kana    FOR SELECT USING (true);
CREATE POLICY "Public read-only" ON public.jmdict_senses  FOR SELECT USING (true);
