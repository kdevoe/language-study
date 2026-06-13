# Yūgen News - Task Breakdown

- [x] Project Setup
  - [x] Initialize Vite React TypeScript project
  - [x] Setup global CSS with typography-first variables (Noto Serif JP/Shippori Mincho, earthy tones)
  - [x] Configure routing and base layouts
- [x] Core UI Components
  - [x] Minimalist Top Navigation ("読書家" theme)
  - [x] Reader Component (Invisible UI, pure text focus)
  - [x] Furigana Component (Always, Never, Dynamic display)
  - [x] Context Bottom Sheet/Modal (Word details, Kanji RTK, Grammar)
  - [x] "Yūgen" Context Box (for highlighting grammar/keywords)
- [x] Logic & State
  - [x] Diagnostic Onboarding Quiz (JLPT & RTK baseline)
  - [x] Progress Persistence Service (LocalStorage or IndexedDB for mastery: unseen, hard, ok, known)
  - [x] RTK Scheduler (moves 3 new Kanji to "Study List" every 24h)
- [x] Data Integration
  - [x] RSS/NewsAPI Fetching Logic
  - [x] Mock or real LLM Service for summarizing/rewriting articles (introducing 10% new content)
- [/] Polish & Testing
  - [/] Ensure "Zen-like" aesthetics (animations, typography)
  - [ ] Final visual QA against reference images
- [x] DB incident: app-wide lookup/processing timeouts (2026-05-31, resolved)
  - Root cause (two compounding afternoon changes, fine in the morning):
    1. PR #26 Progress `get_unseen_common_words` — full-corpus query that
       refetch-stormed and ran unbounded (acute trigger).
    2. PR #24 `freq_rank` backfill left ~31.5k dead tuples in `jmdict_entries`,
       sitting just under autovacuum's 20% trigger so it never cleaned —
       bloating every corpus read on the cache-starved free-tier instance (drag).
    - NOT the plan tier: it ran fine before either change shipped.
  - [x] Optimize get_unseen_common_words RPC (order+limit before per-row LATERAL lookups) — database/14
  - [x] Frontend: send only active-level seen words; stop refetch-on-every-word; add RPC timeout
  - [x] Surface silent failures (article tap banner, lookup timeout message)
  - [x] Confirmed FK indexes from database/06 exist in prod (all present)
  - [x] Reclaimed jmdict_entries bloat: VACUUM (FULL, ANALYZE) → 0 dead tuples
  - [x] import_word_frequency.cjs now prints a VACUUM reminder after backfill
  - Recurrence (same day): lookups kept timing out after the above. 24h Observability
    showed an idle DB that spiked Disk IOPS into the instance ceiling + 13MB/s network
    only on app use. Cause: PR #23 removed the skip-if-cached guard in `loadGlobalCache`,
    so `fetchCachedArticlesFromSupabase` ran `select('*')` over the user's ENTIRE
    `processed_news` history (full `content` JSONB) on every session change. The cold
    read pegged IOPS and starved concurrent word lookups into statement timeouts.
  - [x] Bound it: fetch only `id, content` for the 30 most recent articles
    (order by created_at desc). Older articles still open on demand via
    fetchProcessedArticleById. Keeps PR #23's server-completion behavior.
  - [ ] Only if spikes recur under real concurrent load: revisit `jmdict_vocab_candidates`
        (full jmdict_senses scan w/ ILIKE ANY on gloss, runs per process-article) or
        bump compute. Not needed as of resolution.
- [x] Client-side morphological tokenization (kuromoji) — 2026-06-07
  - Replaces buggy LLM tokenization (Gemini Pass 2 + exact-surface Pass 3) that
    split words at arbitrary boundaries (鎮める → 鎮 read ちん, wrong meaning, no JLPT).
  - [x] Phase 1: `src/services/tokenizer.ts` (kuromoji singleton, inflection merge,
        okurigana alignment, content-word classification) + dict self-hosted under
        `public/kuromoji-dict/` (~17 MB, SW/HTTP cached). Shared kana helpers in
        `src/services/furigana.ts`. kuromoji lazy-imported → its own 29 KB-gz chunk.
        Verified: 鎮めて→lemma 鎮める/furi しず; した→する; 〜ている stays split.
  - [x] Phase 2: `src/services/enrich.ts` (`enrichArticle`) — tokenize → batch
        `lookupLemmasBatch` by lemma → attach reading/meaning/JLPT/furigana. Reader
        renders raw text first, swaps in enriched blocks, caches them. Lemma-keyed
        SRS so conjugations collapse and the end-of-article sweep agrees.
  - [x] Phase 3: process-article stores raw `{type, text}` paragraphs; Pass 2/3 deleted
        (one fewer Gemini call, no linking queries). Old content[] articles auto-heal.
  - [x] Phase 4: POS-ranked disambiguation (replaces first-entry-wins), JLPT fallback
        ladder (kanji_jlpt → freq_rank, shown as `≈Nx`), THIRD_PARTY_LICENSES (NAIST
        IPADIC + Apache-2.0) + Settings acknowledgement.
  - [x] Furigana: multi-kanji compounds shown as one reading over the group (大統領 →
        だいとうりょう), not dumped on the first kanji; per-kanji RTK kept. Accuracy
        harness in scripts/furigana-accuracy.mjs (gold set + corpus scan).
  - [x] Heteronyms: curated watchlist (src/data/heteronyms.ts) of ambiguous-reading
        words; enricher batches them into one context-aware LLM call via the
        dictionary-lookup edge fn (type:'readings'), overrides only with an
        in-candidate hiragana reading, caches result. Needs edge fn redeploy.
  - [x] Per-kanji furigana: new `alignReading` (furigana.ts) replaces `alignOkurigana`
        at all call sites. Dictionary-driven backtracking aligner (kana = literal
        anchor, kanji = kanjidic readings + rendaku/gemination variants) finds the
        unique per-kanji split (病院→びょう/いん); falls back to whole-word reading on
        ambiguity or a known jukujikun. Fixes the okurigana-anchor blank bug
        (手当て→て/あ/て, was 手当→""). Data: `src/data/kanjiReadings.ts` +
        `src/data/jukujikun.ts`, generated by scripts/build-furigana-data.mjs from
        kanjidic2 + JmdictFurigana, lazy-loaded (~118 KB gz, own chunks, no LFS).
        Measured 0.004% wrong / 91.6% correct split over 206k words
        (scripts/furigana-align-accuracy.mjs). TOKENIZER_VERSION 3→4 to re-enrich
        cached articles.
- [/] Server-side JIT article production — always 1+ ready on open (issue #31)
  - Plan: docs/plan_overnight_ready_article.md. Server owns production via
    idempotent `ensureBuffer(userId)`; client becomes a pure consumer. N=2 buffer,
    daily cap M=15, 5-min stale-pending reclaim, kill switch off by default.
  - [x] Step 1: schema migration `database/16_server_jit_buffer.sql` (manual-apply) —
        adds status (pending|ready|read|dismissed|failed) + read_at/dismissed_at/
        retry_count to processed_news, backfills existing → ready, partial index on
        active (user_id,status) + (user_id,created_at) for the daily-cap count.
  - [/] Step 2: server JIT core (no triggers wired yet). All 7 guardrails.
        - [x] PK fix: processed_news → composite (user_id, id) so per-user articles
              don't collide on the story-derived id (database/17, manual-apply).
              process-article upsert now sets status='ready' + onConflict 'user_id,id'.
        - [x] `ensure_buffer_claim(user_id, candidates, N, M, reclaim_min)` RPC
              (database/17): advisory-lock txn → reclaim stale pending → count
              ready+pending + produced24h → bounded deficit → claim pending via
              ON CONFLICT, returns {buffer,produced24h,deficit,reclaimed,claimed}.
              (supabase-js can't hold a txn, so the locked core lives in PG.)
        - [x] `ensure-buffer` Edge Function: kill switch (JIT_ENABLED off by default,
              N=2/M=15/reclaim=5 env-overridable) → cheap pre-check (skip RSS when
              full) → fetch-raw-news candidates → RPC claim → process-article per
              slot (outside lock) → mark failed on error → one structured log line.
              JWT-derives userId (cron sends service key + body userId). deno check clean.
        - [x] Data-reality audit (docs/audit_buffer_readiness.sql): single-user
              beta (756 rows, 1 user), confirms clean-slate + M=15/N=2 + PK assumption.
        - [x] Corrective migration database/18_buffer_clean_slate.sql — resets the
              backfilled `ready` history → `read` so the buffer starts empty (16's
              `ready` backfill made deficit perpetually 0). One-shot, pre-go-live.
        - [x] APPLIED database/17 + 18, deployed ensure-buffer (v2) + process-article (v27).
        - [x] ISOLATED GATE PASSED (2026-06-13, JIT_ENABLED=true, cap bumped to 30):
              empty buffer → produced exactly 2; repeat calls → reason:full, produced:0
              (idempotent, no runaway). Guardrails #1/#2/#3/#7 + idempotency proven live.
        - [ ] In-app open test (READY card, open → read → 1 replacement). Then reset
              JIT_DAILY_CAP to 15 (bumped to 30 for the same-day test).
  - [x] Step 3: server-owned read/dismiss — api.markArticleConsumed (direct RLS
        update, .in('status',['ready','pending']) so only a live buffer row moves,
        exactly once; raw cards & already-consumed no-op = guardrail #6) + api.ensureBuffer.
        store.syncConsumed wires markArticleRead/dismissArticle to both (fire-and-forget).
  - [x] Step 4: client consumer — api.fetchReadyBufferArticles surfaces ready rows at
        TOP of feed in loadHub (fixes invisible-cached-article bug); ensureBuffer fired
        on open; fetchCachedArticlesFromSupabase now filters status='ready' (no stale
        leftovers); client JIT effect REMOVED; redundant saveProcessedArticle Supabase
        mirror REMOVED; on-tap fallback kept. build + lint clean (no new errors).
        ⚠️ MUTUALLY EXCLUSIVE with server JIT — do not merge until JIT_ENABLED=true in prod.
  - [ ] Step 5: overnight cron — pg_cron + pg_net → ensure-buffer for active users
        (study_history in last 14 days), service-role key via Vault. Retire daily-feed.
