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
