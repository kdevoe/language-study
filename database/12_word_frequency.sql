-- 12. Word frequency rank for JMDict entries
--
-- jmdict-simplified (our import source) collapses JMDict's priority info into a
-- single `common` boolean and discards the granular frequency bands. The original
-- EDRDG JMdict_e.xml keeps them as `<ke_pri>/<re_pri>` codes, including the
-- `nf01`..`nf48` frequency-of-use bands (groups of 500 words by descending
-- newspaper frequency: nf01 = the 500 most frequent words, nf48 = ranks ~23.5k-24k).
--
-- `freq_rank` stores the best (lowest) nf band across an entry's kanji/kana forms:
--   1   = most common (nf01)
--   48  = least common ranked band (nf48)
--   NULL = no nf band (long-tail / rarer word, or only ichi/spec/gai priority)
--
-- The entry's JMDict sequence number (`<ent_seq>`) equals our `jmdict_entries.id`,
-- so this is backfilled by `scripts/import_word_frequency.cjs` via an exact-id
-- UPDATE -- no re-import of kanji/kana/senses needed.
--
-- The existing `common` boolean is kept as a coarse fallback: words that are
-- common but carry no nf band (some ichi/spec/gai entries) stay common=true with
-- freq_rank=NULL, so consumers sort `common DESC, freq_rank ASC NULLS LAST`.

alter table public.jmdict_entries
  add column if not exists freq_rank smallint
  check (freq_rank is null or (freq_rank between 1 and 48));

-- Frequent words are pulled first for study; index supports ASC NULLS LAST ordering.
create index if not exists idx_jmdict_entries_freq_rank
  on public.jmdict_entries (freq_rank asc nulls last);
