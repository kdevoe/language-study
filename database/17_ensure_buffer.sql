-- ============================================================
-- 17_ensure_buffer.sql
-- Server-side JIT buffer, part 2 (issue #31): per-user composite PK + the
-- atomic claim RPC that ensureBuffer() calls under a per-user advisory lock.
-- ============================================================
-- APPLY MANUALLY in the Supabase SQL editor. Idempotent: guarded PK swap +
-- CREATE OR REPLACE FUNCTION. Apply AFTER database/16.
--
-- WHY (PK): processed_news.id is derived from the STORY (title15-stableId(url)),
-- so the same story yields the SAME id for every user. Under the old id-only PK,
-- two users could not both hold their own personalized rewrite of one story —
-- the second upsert overwrote the first (latent multi-user bug) — and the JIT's
-- per-user `pending` INSERT would hit a cross-user duplicate-key error. Articles
-- are unique PER USER, so the key must be (user_id, id). The id still equals the
-- raw feed-card id, so the client matches processed↔raw by simple id equality.
--
-- WHY (RPC): supabase-js issues each statement as a separate PostgREST request —
-- it cannot hold a transaction, so pg_advisory_xact_lock + count + claim cannot
-- be atomic from Deno. The whole cost-critical decision lives here instead, in
-- ONE transaction under the lock. The Edge Function calls this once, then does
-- the slow Gemini work (process-article) OUTSIDE the lock for the claimed slots.

-- ── Composite primary key (user_id, id) ──────────────────────────────────────
-- Safe to build: under the old global-id PK, duplicate (user_id, id) pairs
-- cannot exist. drop-if-exists + add makes this idempotent (a re-run drops the
-- composite and rebuilds it). No FK references processed_news, so nothing breaks.
ALTER TABLE public.processed_news DROP CONSTRAINT IF EXISTS processed_news_pkey;
ALTER TABLE public.processed_news ADD PRIMARY KEY (user_id, id);

-- ── ensure_buffer_claim: atomic per-user buffer claim ────────────────────────
-- Returns jsonb: { buffer, produced24h, deficit, reclaimed, claimed: [{id,title}] }
-- The Edge Function produces (process-article) only the rows in `claimed`.
CREATE OR REPLACE FUNCTION public.ensure_buffer_claim(
  p_user_id         uuid,
  p_candidates      jsonb,            -- [{id text, title text}], in priority order
  p_n               int DEFAULT 2,    -- target buffer depth (N)
  p_m               int DEFAULT 15,   -- hard daily cap (M)
  p_reclaim_minutes int DEFAULT 5     -- stale-pending reclaim window
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reclaimed int  := 0;
  v_buffer    int  := 0;
  v_produced  int  := 0;
  v_deficit   int  := 0;
  v_claimed   jsonb := '[]'::jsonb;
  v_len       int  := COALESCE(jsonb_array_length(p_candidates), 0);
  i           int  := 0;
  v_elem      jsonb;
  v_id        text;
  v_title     text;
BEGIN
  -- Serialize ALL production decisions for this user. Released at txn end, so
  -- concurrent/duplicate triggers (open+read, multi-tab, multi-device) queue
  -- here and each sees the others' claimed `pending` rows → no double-produce.
  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text));

  -- Guardrail #4: an orphaned `pending` (producer crashed/killed before flipping
  -- the row ready/failed) would occupy a buffer slot forever and deadlock refills.
  -- Reclaim → failed so the slot frees; it still counts toward the daily cap
  -- (created_at within 24h), so a crash-loop can't run up Gemini cost.
  UPDATE processed_news
     SET status = 'failed'
   WHERE user_id = p_user_id
     AND status = 'pending'
     AND created_at < now() - make_interval(mins => p_reclaim_minutes);
  GET DIAGNOSTICS v_reclaimed = ROW_COUNT;

  -- Guardrail #1: buffer = ready + (fresh) pending. In-flight slots count.
  SELECT count(*) INTO v_buffer
    FROM processed_news
   WHERE user_id = p_user_id AND status IN ('ready', 'pending');

  -- Guardrail #3: hard daily cap — everything produced in the rolling 24h,
  -- regardless of final status (failed included), so failures can't loop.
  SELECT count(*) INTO v_produced
    FROM processed_news
   WHERE user_id = p_user_id AND created_at > now() - interval '24 hours';

  -- Guardrail #2: bounded deficit, computed ONCE. No internal loop.
  v_deficit := least(p_n - v_buffer, p_m - v_produced);

  IF v_deficit > 0 THEN
    -- Claim up to v_deficit candidates we don't already have a row for. The
    -- composite-PK ON CONFLICT skips any story this user already holds in ANY
    -- status (ready/pending/read/dismissed/failed) — so we never re-produce a
    -- story they've seen, dismissed, or failed, and never double-claim.
    WHILE i < v_len AND jsonb_array_length(v_claimed) < v_deficit LOOP
      v_elem  := p_candidates -> i;
      i       := i + 1;
      v_id    := v_elem ->> 'id';
      v_title := v_elem ->> 'title';
      CONTINUE WHEN v_id IS NULL;

      INSERT INTO processed_news (id, user_id, title, status)
      VALUES (v_id, p_user_id, v_title, 'pending')
      ON CONFLICT (user_id, id) DO NOTHING;

      IF FOUND THEN
        v_claimed := v_claimed || jsonb_build_array(
          jsonb_build_object('id', v_id, 'title', v_title)
        );
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'buffer',      v_buffer,
    'produced24h', v_produced,
    'deficit',     greatest(v_deficit, 0),
    'reclaimed',   v_reclaimed,
    'claimed',     v_claimed
  );
END;
$$;

-- Only the Edge Function (service-role key) calls this.
GRANT EXECUTE ON FUNCTION public.ensure_buffer_claim(uuid, jsonb, int, int, int)
  TO service_role;

-- ── Verify (run after applying) ──────────────────────────────────────────────
--   -- composite PK present:
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'public.processed_news'::regclass AND contype = 'p';
--   -- expect: PRIMARY KEY (user_id, id)
--
--   -- dry-run the claim with no candidates (reclaims + reports, claims nothing).
--   -- Replace the uuid with a real user_id from processed_news:
--   SELECT public.ensure_buffer_claim(
--     (SELECT user_id FROM processed_news LIMIT 1),
--     '[]'::jsonb
--   );
--   -- expect: {"buffer":N,"produced24h":...,"deficit":...,"reclaimed":0,"claimed":[]}
