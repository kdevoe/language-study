-- ============================================================
-- 25. Natural surface forms for discover / intake candidates
-- ============================================================
-- Fixes "excessive kanji" on Discover cards and the unseen-words list. Both
-- get_intake_candidates (database/24) and get_unseen_common_words (database/13)
-- chose the display surface with:
--
--   coalesce( (first kanji form by id), (first kana form by id) )
--
-- i.e. the FIRST kanji form in JMDict document order, with NO regard for whether
-- that form is rare. その (entry 1006830) has a kanji form 其の tagged `rK`
-- (rare kanji), so the card showed 其の instead of その — a form no modern text
-- uses. Same for 迚も (とても), 何時も (いつも), 其れ (それ), etc.
--
-- The data to avoid this is already imported (scripts/import_jmdict.cjs stores
-- each kanji form's `common` flag and its `info` tags — rK/oK/iK/ateji…). This
-- migration adds a shared surface picker that USES them, and points both RPCs
-- at it. The rule mirrors process-article's pickSurface intent, but correctly
-- falls back to kana when the only kanji forms are rare/non-common:
--
--   1. a COMMON kanji form that is not rare/outdated/irregular (rK/oK/iK)
--   2. else any kanji form that is not rare/outdated/irregular
--   3. else the COMMON kana reading
--   4. else any kana reading
--
-- So a word whose only kanji spelling is rare (その, とても, いつも) now displays
-- in kana, while ordinary kanji words (食べる, 会社) are unaffected.
--
-- APPLY MANUALLY in the Supabase SQL editor (migrations here are not
-- auto-deployed). Safe to run repeatedly — CREATE OR REPLACE throughout.

-- ── Shared display-surface picker ───────────────────────────────────────────
-- The natural everyday spelling for a JMDict entry: common non-rare kanji first,
-- otherwise any non-rare kanji, otherwise the kana reading. `info && array[...]`
-- is array overlap: true when the form carries any rare/outdated/irregular tag.
create or replace function public.jmdict_display_surface(p_entry_id text)
returns text
language sql
stable
as $$
  select coalesce(
    -- 1. common, non-rare kanji form
    (select k.text from public.jmdict_kanji k
       where k.entry_id = p_entry_id
         and k.common = true
         and not (k.info && array['rK','oK','iK']::text[])
       order by k.id limit 1),
    -- 2. any non-rare kanji form
    (select k.text from public.jmdict_kanji k
       where k.entry_id = p_entry_id
         and not (k.info && array['rK','oK','iK']::text[])
       order by k.id limit 1),
    -- 3. common kana reading
    (select a.text from public.jmdict_kana a
       where a.entry_id = p_entry_id and a.common = true
       order by a.id limit 1),
    -- 4. any kana reading
    (select a.text from public.jmdict_kana a
       where a.entry_id = p_entry_id
       order by a.id limit 1)
  );
$$;

grant execute on function public.jmdict_display_surface(text) to anon, authenticated;

-- ── get_intake_candidates (supersedes database/24) ──────────────────────────
-- Identical to database/24 except `word` now comes from jmdict_display_surface.
create or replace function public.get_intake_candidates(
  p_user_jlpt smallint,
  p_seen_ids  text[] default '{}',
  p_limit     integer default 50
)
returns table (
  entry_id   text,
  jlpt_level smallint,
  freq_rank  integer,
  word       text,
  reading    text,
  meaning    text
)
language sql
stable
as $$
  with ranked as (
    select e.id, e.jlpt_level, e.freq_rank, e.common
    from public.jmdict_entries e
    where e.jlpt_level is not null
      and e.jlpt_level >= p_user_jlpt        -- user's level and EASIER (higher number)
      and not (e.id = any(p_seen_ids))       -- exclude already-tracked, by entry_id (#39)
    order by e.jlpt_level desc, e.freq_rank asc nulls last, e.common desc, e.id asc
    limit p_limit
  )
  select
    r.id,
    r.jlpt_level,
    r.freq_rank::integer,
    public.jmdict_display_surface(r.id) as word,
    (select a.text from public.jmdict_kana a where a.entry_id = r.id order by a.id limit 1) as reading,
    (select array_to_string(s.gloss, '; ') from public.jmdict_senses s
       where s.entry_id = r.id order by s.id limit 1) as meaning
  from ranked r
  order by r.jlpt_level desc, r.freq_rank asc nulls last, r.common desc, r.id asc;
$$;

grant execute on function public.get_intake_candidates(smallint, text[], integer)
  to anon, authenticated;

-- ── get_unseen_common_words (supersedes database/13) ────────────────────────
-- Identical to database/13 except `word` now comes from jmdict_display_surface.
create or replace function public.get_unseen_common_words(
  p_level      smallint,
  p_seen_words text[] default '{}',
  p_limit      integer default 40
)
returns table (
  word    text,
  reading text,
  rank    integer,
  meaning text
)
language sql
stable
as $$
  with candidates as (
    select e.id, e.freq_rank, e.common
    from public.jmdict_entries e
    where e.jlpt_level = p_level
      and not exists (
        select 1 from public.jmdict_kanji k
        where k.entry_id = e.id and k.text = any(p_seen_words)
      )
      and not exists (
        select 1 from public.jmdict_kana a
        where a.entry_id = e.id and a.text = any(p_seen_words)
      )
  )
  select
    public.jmdict_display_surface(c.id) as word,
    (select a.text from public.jmdict_kana a
       where a.entry_id = c.id order by a.id limit 1) as reading,
    c.freq_rank::integer as rank,
    (select array_to_string(s.gloss, '; ') from public.jmdict_senses s
       where s.entry_id = c.id order by s.id limit 1) as meaning
  from candidates c
  order by c.freq_rank asc nulls last, c.common desc, c.id asc
  limit p_limit;
$$;

grant execute on function public.get_unseen_common_words(smallint, text[], integer)
  to anon, authenticated;
