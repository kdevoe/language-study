-- ============================================================
-- 16_server_jit_buffer.sql
-- Server-side JIT article buffer (issue #31) — lifecycle columns on
-- processed_news so ensureBuffer() can account for the buffer and the client
-- can surface only fresh, unread articles.
-- ============================================================
-- APPLY MANUALLY in the Supabase SQL editor (migrations in this repo are not
-- auto-deployed). Safe to run repeatedly — ADD COLUMN IF NOT EXISTS, a guarded
-- CHECK constraint, and CREATE INDEX IF NOT EXISTS.
--
-- WHY: production (Gemini + upsert) is already server-side, but ORCHESTRATION
-- lived in a client React effect that dies with the tab. Moving the buffer
-- invariant ("every user always has N unread processed articles") server-side
-- needs a lifecycle on each row:
--
--   status        pending | ready | read | dismissed | failed
--     pending   — slot CLAIMED before process-article runs; counts toward the
--                 buffer so concurrent/duplicate triggers can't double-produce.
--     ready     — produced and unread; this is what the client surfaces.
--     read      — opened (mark-read-on-open); removed from the buffer.
--     dismissed — swiped away after being produced; removed from the buffer.
--     failed    — process-article errored, or a stale pending was reclaimed.
--                 Still counts toward the daily cap so failures can't loop.
--   read_at / dismissed_at — when the transition happened (observability + cross-device).
--   retry_count — per-article produce attempts; caps retry of a failing headline.
--
-- created_at (already on the table) doubles as the production ledger timestamp
-- for the rolling-24h daily cap (M = 15) — no separate ledger table needed.

-- ── Lifecycle columns ────────────────────────────────────────────────────────
-- ADD COLUMN ... DEFAULT in PG 11+ is metadata-only (no table rewrite). The
-- NOT NULL DEFAULT 'ready' backfills every existing row to 'ready' — exactly the
-- desired "existing processed articles are immediately consumable" backfill.
ALTER TABLE public.processed_news
  ADD COLUMN IF NOT EXISTS status       text        NOT NULL DEFAULT 'ready',
  ADD COLUMN IF NOT EXISTS read_at      timestamptz,
  ADD COLUMN IF NOT EXISTS dismissed_at timestamptz,
  ADD COLUMN IF NOT EXISTS retry_count  integer     NOT NULL DEFAULT 0;

-- Guarded CHECK (ALTER ... ADD CONSTRAINT is not itself idempotent).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'processed_news_status_check'
  ) THEN
    ALTER TABLE public.processed_news
      ADD CONSTRAINT processed_news_status_check
      CHECK (status IN ('pending', 'ready', 'read', 'dismissed', 'failed'));
  END IF;
END $$;

-- Explicit backfill (redundant with the column default above, but makes the
-- intent unambiguous and is a no-op on a fresh apply).
UPDATE public.processed_news SET status = 'ready' WHERE status IS NULL;

-- ── Indexes ──────────────────────────────────────────────────────────────────
-- Buffer accounting (ready + pending) AND the client ready-surface query both
-- filter user_id + an ACTIVE status. A partial index keeps it tiny: read/
-- dismissed/failed rows accumulate forever but never need to be in here, so the
-- index stays proportional to the live buffer (~N per user), not to history.
CREATE INDEX IF NOT EXISTS idx_processed_news_user_status_active
  ON public.processed_news (user_id, status)
  WHERE status IN ('pending', 'ready');

-- Rolling-24h daily-cap count (circuit breaker): count rows this user PRODUCED
-- in the last 24h regardless of status, so this is a full (user_id, created_at)
-- index, not partial.
CREATE INDEX IF NOT EXISTS idx_processed_news_user_created
  ON public.processed_news (user_id, created_at DESC);

-- ── RLS note ─────────────────────────────────────────────────────────────────
-- The existing policy "Users can manage own news" (database/00, FOR ALL USING
-- auth.uid() = user_id) already covers the client's direct status UPDATE on
-- open/dismiss — no new policy needed. ensureBuffer/process-article use the
-- service-role key and bypass RLS. The status CHECK constrains values to the
-- five-state set; we intentionally do not lock down which transitions a client
-- may make (clients already have full manage rights on their own rows).

-- ── Verify (run after applying; expect the 4 columns, the constraint, both indexes) ──
--   SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'processed_news'
--     AND column_name IN ('status','read_at','dismissed_at','retry_count');
--
--   SELECT conname FROM pg_constraint WHERE conname = 'processed_news_status_check';
--
--   SELECT indexname FROM pg_indexes
--   WHERE schemaname = 'public'
--     AND indexname IN (
--       'idx_processed_news_user_status_active',
--       'idx_processed_news_user_created'
--     );
--
--   -- Confirm every existing row backfilled to 'ready':
--   SELECT status, count(*) FROM public.processed_news GROUP BY status;
