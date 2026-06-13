-- ============================================================
-- audit_buffer_readiness.sql  (issue #31 — READ-ONLY data-reality check)
-- Run in the Supabase SQL editor. Nothing here writes. The point is to
-- pressure-test the buffer model's assumptions against real data BEFORE
-- building Steps 3-5: backfill scale, daily-cap (M=15) realism, cron blast
-- radius, and the per-user PK assumption.
-- ============================================================

-- ── Q1: one-shot summary (each metric is a labeled row) ──────────────────────
SELECT metric, value FROM (
  SELECT 1  AS ord, 'total_rows'              AS metric, count(*)::text AS value FROM public.processed_news
  UNION ALL SELECT 2,  'distinct_users',       count(DISTINCT user_id)::text FROM public.processed_news
  UNION ALL SELECT 3,  'max_rows_one_user',    max(c)::text FROM (SELECT count(*) c FROM public.processed_news GROUP BY user_id) t
  UNION ALL SELECT 4,  'median_rows_per_user', round(percentile_cont(0.5) WITHIN GROUP (ORDER BY c))::text FROM (SELECT count(*) c FROM public.processed_news GROUP BY user_id) t
  -- status spread (all 'ready' right now; becomes 'read' after the clean-slate fix)
  UNION ALL SELECT 5,  'status_ready',         count(*)::text FROM public.processed_news WHERE status = 'ready'
  UNION ALL SELECT 6,  'status_read',          count(*)::text FROM public.processed_news WHERE status = 'read'
  UNION ALL SELECT 7,  'status_other',         count(*)::text FROM public.processed_news WHERE status NOT IN ('ready','read')
  -- age of the corpus (informs clean-slate + what 'produced in 24h' noise looks like)
  UNION ALL SELECT 8,  'age_last_24h',         count(*)::text FROM public.processed_news WHERE created_at > now() - interval '24 hours'
  UNION ALL SELECT 9,  'age_last_7d',          count(*)::text FROM public.processed_news WHERE created_at > now() - interval '7 days'
  UNION ALL SELECT 10, 'age_older_7d',         count(*)::text FROM public.processed_news WHERE created_at <= now() - interval '7 days'
  -- cron blast radius (how many users an overnight ensureBuffer would fan out to)
  UNION ALL SELECT 11, 'users_with_prefs',     count(*)::text FROM public.user_preferences
  UNION ALL SELECT 12, 'active_14d',           count(DISTINCT user_id)::text FROM public.study_history WHERE created_at > now() - interval '14 days'
  UNION ALL SELECT 13, 'active_7d',            count(DISTINCT user_id)::text FROM public.study_history WHERE created_at > now() - interval '7 days'
  -- PK sanity: any story id already held by >1 user? (expect 0 — impossible under the old PK)
  UNION ALL SELECT 14, 'ids_shared_across_users', count(*)::text FROM (
    SELECT id FROM public.processed_news GROUP BY id HAVING count(DISTINCT user_id) > 1
  ) x
) q ORDER BY ord;

-- ── Q2: top users by article count — is the corpus one test whale + minnows? ─
SELECT user_id,
       count(*)               AS rows,
       min(created_at)::date  AS oldest,
       max(created_at)::date  AS newest
FROM public.processed_news
GROUP BY user_id
ORDER BY rows DESC
LIMIT 10;

-- ── Q3: who produced how much in the last 24h — is M=15 realistic, or is 17
--        just today's test noise on one account? ───────────────────────────
SELECT user_id, count(*) AS produced_24h
FROM public.processed_news
WHERE created_at > now() - interval '24 hours'
GROUP BY user_id
ORDER BY produced_24h DESC
LIMIT 10;
