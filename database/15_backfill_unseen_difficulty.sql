-- 15. Backfill "seen but ungraded" words out of the unseen bucket
--
-- Legacy rows where the user encountered a word (times_seen >= 1) but never graded
-- it sit at mastery_level = 'unseen' with difficulty = NULL. The client now grades a
-- word the moment it has been read on screen, so a persistent 'unseen' row should no
-- longer exist for an encountered word. This one-time backfill assigns each such row
-- a JLPT-seeded difficulty, treating the past encounter as a 'skip' (read past) — the
-- same seed + nudge the client applies on first contact (see seedDifficulty /
-- applyDifficultyEvent in src/services/store.ts):
--
--   seed = word JLPT vs the user's JLPT level (mirrors seedDifficulty):
--            word has no JLPT tag   -> 9   (assume hard)
--            user has no level set  -> 5   (neutral)
--            else clamp(6 + (userLvl - wordLvl) * 2, 1, 10)
--   diff = clamp(seed - 1, 1, 10)            -- the 'skip' (read past) nudge
--   bucket: 1-3 easy, 4-7 medium, 8-10 hard  -- mirrors bucketForDifficulty
--
-- word_id and jmdict_entries.id are both TEXT, so the join is direct; word_ids that
-- aren't JMDict entries (rare surface-string ids) get jlpt = NULL -> seed 9 -> hard.
-- Each user is graded against their OWN user_preferences.jlpt_level.
--
-- Idempotent: only touches rows still at 'unseen'. Safe to re-run.

update public.user_word_progress uwp
set
  difficulty = d.difficulty,
  mastery_level = case
    when d.difficulty <= 3 then 'easy'
    when d.difficulty <= 7 then 'medium'
    else 'hard'
  end
from (
  select
    p.user_id,
    p.word_id,
    greatest(1, least(10, s.seed - 1)) as difficulty
  from public.user_word_progress p
  left join public.jmdict_entries e on e.id = p.word_id
  left join public.user_preferences up on up.user_id = p.user_id
  cross join lateral (
    select case
      when e.jlpt_level is null then 9
      when up.jlpt_level is null then 5
      else greatest(1, least(10, 6 + (up.jlpt_level - e.jlpt_level) * 2))
    end as seed
  ) s
  where p.mastery_level = 'unseen'
) d
where uwp.user_id = d.user_id
  and uwp.word_id = d.word_id
  and uwp.mastery_level = 'unseen';
