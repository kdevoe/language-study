-- 11. Numeric difficulty for word progress
--
-- `difficulty` (1..10, 1 = easiest for the user, 10 = hardest) is now the source of
-- truth for SRS. The legacy `mastery_level` text column is kept in sync and derived
-- from difficulty (1-3 = easy, 4-7 = medium, 8-10 = hard) so the article-generation
-- pipeline (process-article) keeps working unchanged.

alter table public.user_word_progress
  add column if not exists difficulty smallint
  check (difficulty is null or (difficulty between 1 and 10));

-- Backfill from the existing bucket using each bucket's midpoint.
update public.user_word_progress
set difficulty = case mastery_level
  when 'easy'   then 2
  when 'medium' then 5
  when 'hard'   then 9
  else null            -- 'unseen' (or null) stays ungraded
end
where difficulty is null;
