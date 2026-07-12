-- ============================================================
-- 24. Word intake queue + daily new-word limit (#68)
-- ============================================================
-- Gate words into the FSRS schedule (#67) instead of grading every word on sight.
-- Today first contact immediately seeds difficulty + a full schedule, which floods a
-- new/returning user with hundreds of "active" words. This migration adds a queue:
-- words WAIT (unscheduled) until a daily cap promotes them, lowest JLPT level first,
-- most-common-in-normal-text first.
--
-- `intake_status` is ORTHOGONAL to #67's `srs_status` (the FSRS card lifecycle,
-- new/learning/review/relearning): a word is `queued` (waiting, no schedule) until the
-- daily cap promotes it to `active` (scheduled). The promotion logic lives client-side
-- (store.ts:promoteIntakeQueue, foundation-first via _shared/wordPriority.ts:compareIntake).
--
-- APPLY MANUALLY in the Supabase SQL editor (migrations in this repo are not
-- auto-deployed). Safe to run repeatedly — IF NOT EXISTS + idempotent backfill.

-- ── Intake status on user_word_progress ─────────────────────────────────────
alter table public.user_word_progress
  add column if not exists intake_status text
    check (intake_status is null or intake_status in ('queued','active')),
  add column if not exists promoted_at timestamptz;   -- when it entered active study

-- Backfill (D2 — grandfather): every row that already has a schedule/grade is active;
-- ungraded rows become queued. Non-destructive: no schedules touched. Idempotent —
-- only stamps rows not already classified.
update public.user_word_progress
  set intake_status = case
                        when stability is not null or difficulty is not null then 'active'
                        else 'queued'
                      end
  where intake_status is null;

-- Supports the queue-health dashboard (#73) and a future server-side promotion job.
create index if not exists idx_uwp_intake
  on public.user_word_progress(user_id, intake_status);

-- ── Daily new-word cap preference (D3 — starts at 3) ────────────────────────
alter table public.user_preferences
  add column if not exists new_words_per_day smallint default 3
    check (new_words_per_day between 0 and 50);

-- ── Unseen-foundation intake candidates (D1, queue source #2) ────────────────
-- The "important words the user hasn't read yet" feed. Sibling of get_unseen_common_words
-- (database/14) but purpose-built for intake:
--   (a) scans the user's level AND all easier levels in ONE call, foundation-first
--       (jlpt_level DESC = easiest first, then freq_rank ASC),
--   (b) excludes already-tracked words by canonical entry_id (correct post-#39 —
--       the older RPC excludes by surface form, which no longer matches the store key),
--   (c) returns entry_id + jlpt_level so a promoted word is canonically keyed and
--       orderable by compareIntake.
-- Perf shape mirrors database/14: order + LIMIT the candidate set on jmdict_entries
-- FIRST (cheap — no display joins), then fetch the display fields for just the top
-- p_limit rows via scalar subqueries.
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
    -- Prefer the kanji surface form; fall back to kana for kana-only entries.
    coalesce(
      (select k.text from public.jmdict_kanji k where k.entry_id = r.id order by k.id limit 1),
      (select a.text from public.jmdict_kana  a where a.entry_id = r.id order by a.id limit 1)
    ) as word,
    (select a.text from public.jmdict_kana a where a.entry_id = r.id order by a.id limit 1) as reading,
    (select array_to_string(s.gloss, '; ') from public.jmdict_senses s
       where s.entry_id = r.id order by s.id limit 1) as meaning
  from ranked r
  order by r.jlpt_level desc, r.freq_rank asc nulls last, r.common desc, r.id asc;
$$;

grant execute on function public.get_intake_candidates(smallint, text[], integer)
  to anon, authenticated;
