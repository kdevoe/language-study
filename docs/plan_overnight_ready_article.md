# Plan: Server-side JIT article production (issue #31)
**Branch:** `feat/server-side-jit-buffer` (rebased on `origin/main` @ `fab7a7d`) **Goal:** A fresh, unread processed article is **always ready on open** — first open, mid-day reopen, any device — **no spinner**. Server owns production via an idempotent `ensureBuffer(userId)`; client becomes a pure consumer. Guardrails land **before** any trigger.

> The standalone design doc was never committed; this file reconstructs it from the issue spec + a read of the live code, and is the plan of record.

* * *
## What the code actually shows (grounding)
| Area | Reality on `main` | Implication |
|---|---|---|
| Client JIT | `App.tsx:290-317` — React effect, "1 ahead", dies with tab, can be killed mid-run | Retire; keep on-tap fallback in `handleSelectArticle` (`App.tsx:330-`) |
| Mark-read | `App.tsx:335` `markArticleRead` on **open**; store arrays `readArticleIds`/`dismissedArticleIds` (`store.ts:90-91,190-199`), localStorage only | Must also write **server-side** + trigger refill |
| Feed build | `loadHub` (`App.tsx:131-151`) = raw `fetch-raw-news` only, filtered by local seen-set | Ready processed articles invisible → inject them at top |
| Cache hydrate | `fetchCachedArticlesFromSupabase` (`api.ts:137-155`) selects `id, content`, no `status`/`created_at` filter | Add `status`/`created_at`; only surface `ready` |
| **ID scheme** | `fetch-raw-news` = `stableId(url)` FNV-1a (`fetch-raw-news/index.ts:33-40`); `daily-feed` = `title.slice(0,15)-url` (`daily-feed/index.ts:52`) | **They differ.** `ensureBuffer` must use the `fetch-raw-news` id, or `ready` rows never match feed cards |
| `process-article` | Takes `{userId, articleId, title, snippet, sources}`, upserts `processed_news`, no status field (`process-article/index.ts:363-380`) | Set `status='ready'` on success; caller (`ensureBuffer`) owns the `pending`→`ready` transition |
| `processed_news` | `id text pk, user_id, title, content jsonb, metadata jsonb, created_at` + RLS own-rows (`00_full_schema.sql:18-33`) | Add status/read_at/dismissed_at/retry_count |
| Disk-IOPS history | `fetchCachedArticlesFromSupabase` capped to 30 to avoid IOPS spikes (`api.ts:128-135`) | Keep ready-surface query tiny + indexed |

**Design decision (ID):** `ensureBuffer` does **not** re-derive `stableId`. It calls `fetch-raw-news` (service-role) to get raw cards that already carry the correct id, picks ones not already in `processed_news` for that user, and passes that card's `id` as `articleId` to `process-article`. One source of truth for ids, zero drift risk.

* * *
## Locked invariants (from issue, restated for implementation)
- **N = 2** unread processed per user. **Buffer = ready + pending** (in-flight counts).
  
- **One entrypoint** `ensureBuffer(userId)`, idempotent, under `pg_advisory_xact_lock(hashtext(userId))`.
  
- **Deficit computed once**, produce ≤ `N − buffer`, **no internal loop**.
  
- **Hard daily cap M = 15** produced/user/rolling-24h — circuit breaker in the same txn.
  
- **Failures →** `failed` (not reverted to deficit); per-article `retry_count` cap; stale `pending` reclaimed but still counts toward daily cap.
  
- **No fresh source ⇒ stop** (return buffer < N, don't hammer NewsAPI/Gemini).
  
- **Only** `processed_news` **reads/dismisses move the buffer** — dismissing a raw feed card does nothing.
  
- **Kill switch** env flag, **off by default**; one structured log line per production with reason.
  

* * *
## Step 1 — Schema migration (`database/16_server_jit_buffer.sql`, manual-apply)
Add to `processed_news`:

- `status text not null default 'ready'` — `pending | ready | read | dismissed | failed`
  
- `read_at timestamptz`, `dismissed_at timestamptz`
  
- `retry_count int not null default 0`
  
- (`created_at` already exists → reused as the production-ledger timestamp)
  

Plus:

- `check` constraint on `status` values.
  
- Backfill: existing rows → `status='ready'` (default covers it; explicit `update` for clarity).
  
- Partial index `(user_id, status)` for the buffer count + ready-surface queries.
  
- Index `(user_id, created_at)` for the rolling-24h daily-cap count.
  
- A `kill switch`: small `app_config` row or rely on an Edge env var (`JIT_ENABLED`); **env var chosen** — no schema, instant toggle, matches issue "env switch."
  

Guardrails ship first → this migration must be **applied in Supabase before** step 2 deploys.
## Step 2 — `ensureBuffer` Edge Function (all 7 guardrails, no triggers yet)
New `supabase/functions/ensure-buffer/index.ts`. Per call, single transaction:

1. If `JIT_ENABLED !== 'true'` → log + return (kill switch).
  
2. `pg_advisory_xact_lock(hashtext(userId))` — serialize per user (open+read+multi-tab races).
  
3. Count `buffer = ready + pending` for user; count `produced24h` (rows `created_at > now()-24h`).
  
4. `deficit = min(N - buffer, M - produced24h)`; if `deficit <= 0` → log no-op, return.
  
5. Reclaim stale `pending` (older than the **5-min reclaim window**) → `failed` (still counts toward daily cap). *Why this exists:* a `pending` row is claimed before `process-article` runs; if that call crashes/times out/is killed, the row is orphaned and — because `pending` counts toward the buffer — permanently occupies a slot, silently deadlocking refills (buffer looks full at N while the user has 0 readable articles). The window flips orphans to `failed` so the slot frees. 5 min = ~5–10× `process-article`'s real worst case (`EXTRACT_TIMEOUT_MS=8000` × ≤4 sources + Gemini generate, < 1 min), so it never clips a live run yet recovers quickly after a true crash.
  
6. Fetch raw candidates via `fetch-raw-news`; drop ids already in `processed_news` (any status); take `deficit`.
  
7. If none → log "no source", return (buffer may stay < N).
  
8. For each candidate: **insert** `pending` **row first** (claim slot under lock), then call `process-article`; on success it upserts `status='ready'`; on error set `status='failed'`, `retry_count+1`.
  
9. One structured log line per production: `{userId, produced, deficit, buffer, produced24h, reason}`.
  

The lock is released at txn end; `process-article` calls happen after slot-claim so a duplicate trigger sees `pending` and computes zero deficit. (Note: keep the lock-protected accounting tight; the Gemini calls themselves are the slow part — claim-then-produce means a concurrent call already sees the claimed `pending`.)

Helper extraction: put the raw-candidate fetch + id logic in `_shared/` so `ensure-buffer` and any future caller stay consistent with `fetch-raw-news`.

**Deliverable gate:** unit-exercise `ensureBuffer` directly (invoke the function) and watch logs/rows before wiring any trigger.
## Step 3 — Server-owned read/dismissed state
- `process-article` success already writes the row; `ensureBuffer` sets the lifecycle.
  
- New server writes for consumption:
  
  - **Open → read:** `markArticleRead(id)` (`store.ts:197`) also calls a server mutation setting `status='read', read_at=now()` for that user's row, then fires `ensureBuffer(userId)`.
    
  - **Dismiss → dismissed:** `dismissArticle(id)` (`store.ts:190`) sets `status='dismissed', dismissed_at=now()` **only if the row exists in** `processed_news` (guardrail #6 — raw cards no-op), then fires `ensureBuffer`.
    
- **Decided:** direct RLS table update for the status write (cheap, own-row, guarded by RLS + the status CHECK constraint), then `invokeEdgeFn('ensure-buffer')`. No bespoke `article-state` function. Guardrail #6 falls out for free — a dismiss on a raw card (no `processed_news` row) updates 0 rows and triggers nothing.
  
- Local store arrays stay as a fast cache; server is source of truth, reconciled on load.
  
## Step 4 — Client consumer
- `fetchCachedArticlesFromSupabase` (`api.ts:137`): add `status, created_at`; **only return** `ready` rows (unread), newest first. Keep the 30-row IOPS cap.
  
- `loadHub` / feed assembly (`App.tsx:131`, render `App.tsx:538`): inject `ready` processed articles **at the top** of the feed, ahead of raw cards; dedupe by id (now consistent thanks to step-2 id scheme).
  
- Call `ensureBuffer(userId)` on app open (idempotent safety net for new/drained users).
  
- **Remove** the client JIT effect (`App.tsx:290-317`) and the redundant `saveProcessedArticleToSupabase` path now that the server owns the write.
  
- **Keep** on-tap processing in `handleSelectArticle` as last-resort fallback only.
  
## Step 5 — Overnight cron (live Supabase)
- `pg_cron` job calling a wrapper that, via `pg_net`, POSTs `ensure-buffer` for each **active** user — active = has a `study_history` event in the last **14 days** (bounds overnight cost vs. churned accounts).
  
- Service-role key via **Supabase Vault**, not inline.
  
- **Retire `daily-feed` entirely** — it uses the wrong id scheme and duplicates production with none of the 7 guardrails; a second producer would violate the single-entrypoint invariant. The cron calls `ensure-buffer` instead.
  
- Ship with `JIT_ENABLED` **off** until observed behaving on the live project.
  

* * *
## Verification (maps to issue)
1. Run cron → each user has N `ready` rows.
  
2. Cold open → top card READY, no spinner, dated from latest run.
  
3. Open it → instantly `read`; logs show **exactly one** replacement; buffer back to N.
  
4. Hammer test (rapid open/dismiss + multi-tab) → never exceeds deficit, never breaches daily cap.
  
5. Cross-device: open on A → `read` on B, not re-surfaced.
  
6. Drain to 0 with no NewsAPI source → stops, no spin loop.
  
## Sequencing & safety
- Land **1 → 2** and verify `ensureBuffer` in isolation **before** 3/4 wire triggers (guardrails-first).
  
- Migration is manual-apply in Supabase (project convention) — I'll provide the SQL; you apply it.
  
- Steps 2/3/5 touch the live project (Gemini/pg_net/Vault); kill switch stays off until observed.
  
- `no test suite` in repo → verification is manual via logs + rows + `npm run build`/`lint`.
  
## Resolved decisions

1. **Daily cap M = 15.**
2. **Stale-`pending` reclaim window = 5 min** (rationale in Step 2.5).
3. **Step-3 mechanism:** direct RLS status update + separate `ensure-buffer` invoke (no bespoke function).
4. **`daily-feed`:** retire entirely; cron calls `ensure-buffer`.
5. **Active-user (cron):** `study_history` event in last 14 days.
6. **Per-user PK:** `processed_news` PK → composite `(user_id, id)` (migration 17). Article ids stay = feed-card id.
7. **Backfill correction:** migration 16's `ready` backfill poisoned the buffer; migration 18 resets history → `read` (clean slate).

## Data-reality audit (2026-06-13, `docs/audit_buffer_readiness.sql`)

Run against live data before building Steps 3–5. Findings:

- **Single-user system.** 1 user (`ed7c40b2…`), 1 with prefs, 1 active in 7d/14d. The whole 756-row corpus is the owner account (Apr 5 → Jun 13).
- **756 rows, all `ready`** (628 older than 7 days) — confirms the backfill poisoned the buffer; clean slate (migration 18) is correct.
- **`produced24h = 17`** is old client-JIT test churn on the one account, not real reading — **M=15 stays**; revisit only when real users exist.
- **`ids_shared_across_users = 0`** — PK assumption confirmed empirically.
- **Risk reframe:** blast radius is 1 user / ≤15 Gemini calls/day / behind a kill switch. Guardrails must *exist* (for scale) but live deploy/test is low-risk — no need for heavy staged ceremony.
- **Testing wrinkle:** after migration 18 those 17 rows are `read` but still count toward `produced24h` (created <24h ago), so a *same-day* live test is daily-capped. To produce on go-live day, bump `JIT_DAILY_CAP` env temporarily or test after the 24h window rolls.

---
comments:
  c1:
    body: |-
      Do 15 for the daily cap
      Explain more what hte pending reclain window is
      What do you recommend for the rest?
    by: user
    at: 2026-06-13T03:21:36.497Z
  c2:
    body: |-
      All resolved & baked into the plan:
      • M = 15.
      • Pending-reclaim window expanded in Step 2.5 — it's the staleness timeout that flips orphaned `pending` rows (process-article crashed/killed before flipping them ready/failed) back to `failed`, so they stop silently occupying a buffer slot and deadlocking refills. Set to 5 min (~5–10× process-article's real worst case).
      • Recommendations taken: Step-3 = direct RLS update + ensure-buffer invoke; daily-feed retired; cron gates on study_history activity in last 14 days.
    by: AI
    at: 2026-06-13T03:30:00.000Z
    re: c1
