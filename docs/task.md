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
  - [ ] Only if spikes recur under real concurrent load: revisit `jmdict_vocab_candidates`
        (full jmdict_senses scan w/ ILIKE ANY on gloss, runs per process-article) or
        bump compute. Not needed as of resolution.
