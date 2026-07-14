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
        - [x] Verified on Vercel preview, then SHIPPED to prod (PR #44 → main 0213b73,
              deploy success). JIT_ENABLED=true confirmed live before merge.
        - [ ] Post-ship: clear stale client localStorage for the true fresh experience;
              consider JIT_DAILY_CAP 30 → 15.
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
  - [x] HOTFIX (2026-06-13): buffer-wedge deadlock. Server had 2 `ready` articles
        (healthy, under cap) but the feed showed nothing new. Cause: loadHub
        re-filtered server `ready` rows through the LOCAL seen set; swiping a raw
        headline before it's processed only wrote localStorage (no DB row), so the
        buffer re-produced that story → it landed `ready` but was hidden as "seen"
        → buffer stuck full at N → server stopped producing. Fix: (1) App.tsx
        loadHub trusts server `ready` status, no longer seen-filters the buffer;
        (2) api.markArticleConsumed writes a dismissed/read TOMBSTONE when no live
        buffer row matched, so ensure_buffer_claim's ON CONFLICT never re-produces
        a swiped raw headline. Self-heals existing stuck buffers on next open.
  - [/] Step 5: overnight cron — pg_cron + pg_net → ensure-buffer for active users
        (study_history in last 14 days), service-role key via Vault. Retire daily-feed.
        Cron adds overnight/daily-fresh seeding + bootstrap for non-opening users
        (event-driven app-open/read/dismiss refill already shipped in Steps 3/4).
        - [x] database/19_overnight_cron.sql (manual-apply): enables pg_cron+pg_net;
              jit_refill_active_users(active_days,max_users,timeout) reads the PUBLIC
              anon key from Vault (jit_anon_key) + hardcoded public URL, fans out ONE
              pg_net POST/active user to ensure-buffer (idempotent, fire-and-forget);
              nightly cron 'jit-overnight-refill' @ 09:00 UTC; defensively unschedules
              any daily-feed pg_cron job. ensure-buffer keeps verify_jwt=true; anon key
              is just the gateway pass (body userId is authoritative).
        - [x] daily-feed/index.ts marked DEPRECATED (banner); pg_cron schedule removed
              by 19. Dashboard-scheduled daily-feed (if any) must be disabled by hand.
        - [ ] APPLY (your steps): (1) select vault.create_secret('<ANON_KEY>','jit_anon_key');
              (2) run database/19 in SQL editor; (3) smoke-test select jit_refill_active_users().
        - [ ] After cron verified live: delete the daily-feed Edge Function deployment.
- [x] Progress bucketing + sync fixes (2026-06-27): words wrongly in "Other"/Ungraded
      and lost on reinstall. Investigation traced one symptom to four distinct issues:
  - Root symptom: common N5–N4 words sat in Progress "Other" because their cached
    record had `jlptLevel == null`. JLPT data existed in JMDict the whole time
    (verified: 会社=N5, 道=N5, …); records stored read-past as "Implicitly parsed
    context" were never backfilled (write-once + jlptLevel never persisted).
  - [x] PR #85 — JLPT backfill (drains "Other") + seed difficulty for seen-but-
        ungraded words. `fetchJlptByEntryIds` (official→kanji→freq, shared
        fetchKanjiJlpt/deriveJlpt); Reader self-heals null jlptLevel on grade.
  - [x] PR #86 — reconcile locally-graded words up to the server (fill server nulls,
        never overwrite) + harden upsertWordProgressBatch (bad lastSeenTs no longer
        aborts the whole batch).
  - [x] PR #87 — rehydrate the word cache from the server after a wipe
        (`fetchDetailsByEntryIds`): Progress survives reinstall/cleared cache. Sync
        previously only UPDATED existing local words, never ADDED server-only ones.
  - [x] PR #88 — ROOT CAUSE of the partial restore: `fetchUserWordProgress` had no
        pagination, so PostgREST silently capped it at ~1000 rows. A 2210-word
        account only synced ~1000 — which throttled SRS sync, backfill, reconcile,
        AND rehydration. Now pages via `.range()`. (Affected any 1000+ word account.)
  - Verified end-to-end: Progress "Other" 1297→342; server ungraded 331→0
    (2210/2210 graded); reinstall rebuilds ~2200 words.
  - [ ] Known gap: words with no jmdictEntryId (proper nouns / tokenizer fragments,
        ~577) are never synced, so a reinstall still loses them. Future work: back
        them up via a string word_id (the table already allows it).
- [x] #67 FSRS scheduling engine (Phase D, 2026-07-11): real spaced-repetition
      due-dates on top of the coarse `difficulty` signal. Design + decisions in
      docs/fsrs-engine-design-67.md.
  - [x] src/services/srs.ts — pure `schedule(state,rating,now)` wrapping ts-fsrs
        (FSRS-6, request_retention 0.85, deterministic) + `ratingForReaderEvent`
        + `seedSrsFromDifficulty` (seeds initial stability from difficulty 1..10).
  - [x] scripts/test-srs.mjs (`npm run test:srs`) — 18/18 standalone assertions
        (esbuild-bundled, no framework): first review, monotonic growth, Again
        lapse, D3 early-vs-due gain, seed gradient.
  - [x] database/23_fsrs_scheduling.sql — scheduling columns + idx_uwp_due partial
        index + append-only srs_review_log; one-time backfill from difficulty +
        last_seen_at. APPLY BY HAND in Supabase, then vacuum analyze the table.
  - [x] store.applyDifficultyEvent scheduling arm — read-past="Good", lookup=
        "Again"; reading ALWAYS advances the schedule (push self-limited by FSRS
        early-review math → shrinks the flashcard deck). Persist v5→v6 eager seed.
  - [x] api.ts — scheduling columns in fetch/upsert (partial upsert never nulls a
        schedule) + logSrsReviewToSupabase.
  - [x] wordPriority.ts — dueAt/stability on WordSignal + compareByDue comparator
        (provided; #72 wires compareStuck's callers over to it).
  - Verified: 18/18 tests, tsc -b, full vite build (ts-fsrs bundles), 0 new lint.
  - [ ] APPLY (your step): run database/23_fsrs_scheduling.sql in the Supabase SQL
        editor, then `vacuum analyze public.user_word_progress;`.
- [/] Study-pacing flood fix — "flashcards augment reading" (see docs/study-pacing-flood-fix.md)
  - Symptom: Study tab opened to ~1400 due at once. Cause: #67 seed anchored due_at
    at last_seen_at, so the whole seed-on-sight back-catalog came due together; #68's
    D2 grandfather kept it all `active`. NOT a queue-cap bug.
  - Model (Policy F): easy (difficulty ≤ 3) → stay active, forward-reseeded FAR OUT;
    medium+ → back to the intake queue (drip 3/day). No hard review cap (it only hides
    genuinely-due cards); the natural cap is small inflow via the reseed + pre-due window.
  - [x] audit-reseed.cjs — read-only policy sweep over real data (683 easy→SRS ~10/day,
        1943→queue).
  - [x] srs.ts — seedForwardFromHistory / estimateStability (now-anchored, exposure-boosted,
        deterministic spread).
  - [x] pacing.ts — decidePacing (Policy F) + isActiveForPacing + spreadFractionForKey.
  - [x] store.resetStudyPacing + api.resetStudyPacingBatch (batched, writes nulls);
        Settings → "Rebalance Flashcard Deck" button (confirm-gated).
  - [x] deck.ts — latent, default-OFF reviewCap primitive (dueShown vs due).
  - [x] Pre-due surfacing window: wordPriority.ts (preDueUrgency / selectPreDueFloor,
        window = 12% of interval, 1–21d) + process-article/index.ts (interval_days, floor
        by pre-due urgency).
  - Verified: test-srs 36, test-deck 32, test-pacing 15, test-wordpriority 25,
        test-intake 14 — all green; tsc clean; 0 new lint.
  - [ ] ACTIVATE (your step): deploy process-article, then Settings → Rebalance Flashcard
        Deck. No new DB column (reuses user_word_progress scheduling columns).
- [x] Morning-empty-deck fix + in-card grade strip (Jul 13)
  - Symptom: 0 cards at 9:36am, then a single NEW card (出口) that was just read.
    Verified against prod data: 出口 was a WordModal mastery-tap promotion (by
    design); the daily batch never ran (rolling 24h gate — phone last promoted
    12:17pm Jul 12); and Jul 11's 3 promoted words (reps 0 server-side) were
    invisible because rehydrate dropped promotedTs/intakeStatus/schedule fields.
  - [x] store.promoteIntakeQueue — gate by LOCAL CALENDAR DAY (sameLocalDay), not
        rolling 24h; count words already promoted today (promotedTs, rides the
        sync — cross-device + manual modal promotions) against newWordsPerDay;
        only deck-eligible (JLPT-leveled) queued words may win slots.
  - [x] store.checkDailyKanji — same calendar-day gate (same drift bug).
  - [x] syncSrsWithSupabase rehydrate — carry stability/dueAt/reps/lapses/
        srsStatus/intervalDays/fsrsDifficulty/lastReviewedTs/intakeStatus/promotedTs
        so cross-device promotions surface in the deck.
  - [x] Flashcards.tsx — constant card height (min(540px,62vh) both faces); the 4
        grade buttons now live INSIDE the back face as a hairline-divided bottom
        strip (no height change on flip); empty-deck snapshot rebuilds when the
        async app-open promotion lands.
  - Verified: all 5 test runners green (122 total), tsc -b + vite build clean,
    0 new lint; Playwright walkthrough (front → flip → grade → next card).
  - [x] Grade-strip restyle (variant A): floating white capsule pills, grade color
        carried ONLY by a soft tinted shadow (no dots, no divider grid); JLPT tag
        de-pilled to plain text so it doesn't read as a fifth button.
  - [x] D3 revision (Policy F): a modal mastery-tap no longer fast-tracks a word
        into the deck. Hard/medium record the grade and STAY QUEUED (daily
        foundation-first cap seeds from the grade at promotion); EASY activates
        into far-out maintenance via decidePacing (promotedTs null → never a
        "new" card, doesn't spend a daily slot). Was how 出口 jumped the queue.
- [x] Discover mode (#113) — Study-tab triage of unseen words (Jul 14)
  - Entry: offered only once the due deck is done (empty-deck and deck-complete
    states show "Discover new words"; needs a known JLPT level). Batches of 20
    from get_intake_candidates (entry-id keyed, foundation-first: lowest JLPT
    level with unseen words, most common first) — NOT get_unseen_common_words,
    which returns no entry_id so grades couldn't sync.
  - [x] store.gradeDiscoverWord — materialises an entry-id-keyed record (same
        template as a promotion win; the flip counts as an exposure) then applies
        the Policy F split: EASY → far-out maintenance (decidePacing keep-active,
        promotedTs null — never a "new" card, no daily slot); MEDIUM/HARD →
        intake queue with the grade recorded, exits via the daily cap exactly
        like a med/hard grade from reading. Sync always writes intakeStatus
        (row doesn't exist server-side yet); logs mastery_change source:discover.
  - [x] Flashcards.tsx — shared FlipSurface extraction (due deck + Discover use
        the same card); Discover header/progress bar; Hard/Medium/Easy pills
        (captions "study soon"/"known" instead of interval previews); batch
        summary with "Discover more" / Done; graded words excluded on refetch.
  - [x] furiganaSegments fix — an EMPTY furiganaMap fell into the partial-map
        healing path (per-char identity segments), so map-less words (all
        Discover cards, promoted intake words) never showed their reading on
        reveal. Empty map now falls through to the whole-word reading fallback.
  - Verified: Playwright walkthrough (empty state → Discover → flip → grade
    Easy/Hard/Medium → store records correct: easy active/promotedTs null/due
    +40d, med/hard queued no schedule → Progress buckets show them → deck stays
    empty → re-entry excludes graded → batch summary → Done). All 5 test
    runners green (122), tsc + vite build clean, 0 new lint in touched files.
- [x] Discover polish + furigana repair (#115, Jul 14)
  - [x] Discover pills label-only (dropped "study soon"/"known" captions).
  - [x] Discover cards align furigana via alignReading (same as enrichment) and
        persist the map on the materialised record.
  - [x] Wired up loadReadingData() at app bootstrap — #36's per-kanji aligner was
        never loaded at runtime, so alignReading silently degraded to
        alignOkurigana app-wide (意味/病院 showed one grouped reading).
  - [x] One-shot "Re-align Furigana" in Settings → Advanced (mirrors Rebalance):
        recomputes the stored furiganaMap back-catalog locally (furiganaMap never
        syncs to user_word_progress); self-hides via lastFuriganaRealignTs.
