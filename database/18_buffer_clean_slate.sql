-- ============================================================
-- 18_buffer_clean_slate.sql  (issue #31)
-- One-time reset: existing processed_news history was backfilled to 'ready' by
-- migration 16, which makes the JIT buffer look permanently full (audit showed
-- 756 ready rows for the one user → deficit always 0 → nothing ever produced,
-- and Step 4 would surface 2-month-old articles as "fresh"). Reset history to
-- 'read' so the buffer starts empty and the JIT produces genuinely fresh articles.
-- ============================================================
-- APPLY MANUALLY, ONCE, as the LAST schema step before enabling the JIT
-- (order: 16 → 17 → 18 → deploy functions → set JIT_ENABLED=true).
--
-- ⚠️  DO NOT re-run after the JIT is live: it would mark freshly-produced 'ready'
-- buffer rows as 'read' and empty the live buffer. The created_at guard below
-- limits the blast to rows that predate go-live as a safety net, but treat this
-- as a one-shot regardless.
--
-- The old read/unread truth lived in client localStorage (readArticleIds), which
-- SQL cannot see, so a perfect reconcile is impossible — clean slate is the only
-- option that guarantees "fresh, never stale leftovers" (issue #31 goal).

UPDATE public.processed_news
   SET status  = 'read',
       read_at = COALESCE(read_at, created_at)
 WHERE status = 'ready'
   AND created_at < '2026-06-14T00:00:00Z';  -- guard: only pre-go-live history

-- ── Verify (expect 0 ready, everything moved to read) ────────────────────────
--   SELECT status, count(*) FROM public.processed_news GROUP BY status;
--   -- expect: read = (former ready count), ready = 0
