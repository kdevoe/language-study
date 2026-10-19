-- 39: intake v2 (docs/intake-v2-spec.md).
--
-- Two read-only RPCs for the daily promotion pass and 進捗, plus a re-run of the
-- 24_intake_queue backfill for rows that drifted to a NULL intake_status.
--
-- intake_level_progress(): per JLPT level (5..1), how many of the level's words
-- the learner has solid (mastery easy) out of the level's total. The client picks
-- its WORKING LEVEL from it (the easiest level under 80% solid) and 進捗 shows it.
--
-- intake_queue_signals(): for every not-yet-active word the learner tracks, the
-- dictionary's OWN jlpt level and frequency band (the local cache can carry a
-- level guessed from kanji, which let fragments like 見/社 win slots) and how many
-- times they looked it up (counted from study_history, so no new column to keep
-- in sync).
--
-- Both are security invoker and read only the caller's rows. Safe to re-run.

-- Hygiene: rows created by the plain seen/lookup sync never got an intake status.
update public.user_word_progress
  set intake_status = case
                        when stability is not null or difficulty is not null then 'active'
                        else 'queued'
                      end
  where intake_status is null;

create or replace function public.intake_level_progress()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(x order by (x->>'level')::int desc), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'level', e.jlpt_level,
      'total', count(*),
      'solid', count(*) filter (where p.mastery_level = 'easy'),
      'met',   count(*) filter (where p.word_id is not null)
    ) as x
    from public.jmdict_entries e
    left join public.user_word_progress p
      on p.word_id = e.id::text and p.user_id = auth.uid()
    where e.jlpt_level between 1 and 5 and auth.uid() is not null
    group by e.jlpt_level
  ) t;
$$;
grant execute on function public.intake_level_progress() to authenticated;

create or replace function public.intake_queue_signals()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with q as (
    select p.word_id from public.user_word_progress p
    where p.user_id = auth.uid() and coalesce(p.intake_status, 'queued') = 'queued'
  ),
  looks as (
    select h.word_id, count(*)::int as n from public.study_history h
    where h.user_id = auth.uid() and h.action = 'lookup'
    group by h.word_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', q.word_id,
    'level', e.jlpt_level,
    'freq', e.freq_rank,
    'lookups', coalesce(l.n, 0)
  )), '[]'::jsonb)
  from q
  left join public.jmdict_entries e on e.id::text = q.word_id
  left join looks l on l.word_id = q.word_id;
$$;
grant execute on function public.intake_queue_signals() to authenticated;
