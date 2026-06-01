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
- [/] DB performance: Progress "discover" query overload (2026-05-31)
  - [x] Optimize get_unseen_common_words RPC (order+limit before per-row LATERAL lookups) — database/14
  - [x] Frontend: send only active-level seen words; stop refetch-on-every-word; add RPC timeout
  - [x] Surface silent failures (article tap banner, lookup timeout message)
  - [ ] Monitor DB IOwait/memory post-fix (was ~74% IOwait, ~1% free RAM on small tier);
        upgrade compute one tier if spikes persist when visiting Progress
  - [ ] Confirm FK indexes from database/06 exist in prod (verification query in database/14)
