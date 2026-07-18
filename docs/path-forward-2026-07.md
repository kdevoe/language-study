# Path Forward — July 2026
A prioritized roadmap based on a full review of the 16 open GitHub issues, the codebase, and the shipped state of the app as of 2026-07-13.

> **Status update (2026-07-18): Phases 0–1 shipped.**
> - 0.1 ✔ — the stray branch turned out to be already merged (#107); #73 closed (#71/#72 still to close as shipped in #97)
> - 0.2 ✔ #118 · 0.3 ✔ #126 (Sentry live in prod, DSN in Vercel env) · 0.4 ✔ #119 (closes #54) · 0.5 ✔ #125 (SW + update banner + offline kuromoji)
> - 0.6 ◐ — `daily-feed` confirmed still deployed; cron verification + deletion pending (manual)
> - 1.1 ✔ #123 (closes #103) · 1.2 ✔ #124 · 1.3 ✔ #127 · 1.4 ✔ #121 (adds `npm run test:furigana`, 46 asserts)
> - Pending manual steps: `supabase functions deploy process-article` and `deploy dictionary-lookup`; beta users hard-refresh once for the first SW.
> - **Next: Phase 2** — #38 BYOC, then #10 topics.

## Where the app stands
The **Word Mastery Loop is complete**. Phases A–E of `word-mastery-loop-plan.md` all shipped: canonical entry-id keying (#39), FSRS-6 engine (#67), intake queue with calendar-day pacing (#68, #106), flashcard UI (#70), reader⇄flashcard one-schedule convergence (#71 via PR #97), pre-due review floor in articles (#72/#51), and the study dashboard (#73). On the content side, source-fullness ranking (#49/#57), topic clustering (#18), server-side JIT buffer (#31), concept clusters (#101), and the controlled-vocabulary lexicon (#105) are live — a real N4 reader's struggling-word share dropped from 39% to ~10%.

The core promise — _read natural news adapted to you, and have every word you meet feed a real SRS_ — works end to end. What follows is (0) hardening debt that puts that at risk, (1) the highest-leverage quality work, (2) content breadth, and (3) new learning dimensions.

* * *
## Phase 0 — Housekeeping & hardening (days)
Small items, but each protects work already shipped.
### 0.1 Merge the open branch, close stale issues
- `fix/mastery-tap-no-fast-track` is 2 commits ahead of main and unmerged — PR it.
  
- **Close #71, #72, #73** — all shipped in PR #97 (merged) but left open. If #71's remaining gap matters (a just-read word can still appear in today's deck — intentional under Policy F), re-file it as a narrow follow-up instead.
  
### 0.2 Validate Gemini output before persisting (production risk, not in any issue)
`process-article` persists Gemini's blocks with **no schema validation** (`supabase/functions/process-article/index.ts:611-619`). The eval harness validates (`parseBlocks`, `scripts/eval-article-rewrite.mjs:204-221`); production doesn't. One malformed generation writes a broken article to `processed_news` that crashes the client tokenizer — and the JIT buffer will happily serve it. Port `parseBlocks`-style validation into the edge function; on failure, mark the slot `failed` (the buffer already handles that state).
### 0.3 Add error monitoring (not in any issue)
There is zero telemetry — `console.error` only. Every past PWA incident (dead taps from quota, stale-cache breakage) required getting a device console from a user. With beta users on installed PWAs, Sentry's free tier (or similar) would surface these in hours instead of days. Wire it into `invokeEdgeFn` failures, the localStorage quota catch (`store.ts:1363-1367`), and a top-level React error boundary.
### 0.4 Bound localStorage for real (#54)
`wordDatabase` is unbounded (~4 MB at 10k words) and quota errors are swallowed, silently losing a session's grades. This exact failure class already wedged the iOS PWA once. Do the issue as written: cap `readArticleIds`/`dismissedArticleIds` to a recent window, and on `QuotaExceededError` evict-and-retry once instead of only logging.
### 0.5 PWA update hygiene (not in any issue)
`manifest.json` exists but there is **no service worker**. Installed-PWA users have repeatedly ended up on stale builds with no way to recover short of reinstalling. Add a minimal SW (vite-plugin-pwa) with a version-check + "update available" reload prompt. Bonus: precache the 17 MB kuromoji dictionary for offline flashcards.
### 0.6 Finish the JIT migration
`daily-feed` is deprecated but still deployed, and per `task.md` the overnight pg_cron for `ensure-buffer` hasn't been verified live. Verify the cron, then delete `daily-feed`.

* * *
## Phase 1 — Learning-loop quality (1–3 weeks)
The flashcards and articles work; this phase is about making them _converge on the same words_.
### 1.1 Concept↔SRS strong matching (#103) — the headline item
Already well-scoped in the issue and it's the right next move: for each article concept, first ask "does the reader have a _studied_ word that means this?" via a reverse `user_word_progress ⋈ jmdict_senses` query with synonym expansion. This fixes three real problems at once: the JLPT-tag gate hiding the reader's own words, actively-studied words being excluded from clusters, and the review floor being topic-blind. A due word met in a _relevant_ sentence is the single best reinforcement the app can offer — and it advances FSRS so the word may never need a flashcard.
### 1.2 Close the local-only word gap (extends #54/#41)
~577 surface-keyed words with no `jmdictEntryId` never sync — lost on reinstall, invisible to #103's join, ineligible for flashcards (`deck.ts:98-100` requires `jlptLevel`). Two-part fix: (a) a one-time re-resolution pass that retries JMDict linking for surface-keyed records (many will resolve now that lookup is better), and (b) sync the irreducible remainder under their surface key so at least they round-trip.
### 1.3 Production token/cost logging (not in any issue)
The lexicon path injects up to 4000 words (~9k tokens) per article and nobody measures actual prompt sizes or per-article cost in production. Log token usage in `process-article` (the API returns it) so lexicon creep and cost regressions are visible instead of theoretical.
### 1.4 Small correctness items (batch into one PR)
- **Furigana-map unit tests**: `buildFuriganaMap` (`dictionary-lookup/index.ts:16-73`) does proportional multi-kanji splitting with zero tests; wrong furigana corrupts both reading and SRS keying. Add a fixture table of known-hard words (heteronyms, jukujikun).
  
- **Intake RPC failure visibility**: `fetchIntakeCandidates` failures are a silent `console.warn` (`store.ts:1280`) — the day's unseen-foundation slots just vanish. Retry once, and surface via 0.3's monitoring.
  
- **New-card interval preview**: `Flashcards.tsx:125` previews a fresh-card model while the stored state carries a promotion seed — align what the pills show with what grading will actually do.
  

* * *
## Phase 2 — Content breadth: the "natural content" promise (weeks)
Today the only input is random news headlines. For a learner, _choosing_ what to read is half the motivation.
### 2.1 Bring Your Own Content (#38) — cheapest big win
The pipeline is already content-agnostic (`processArticleOnDemand` exists; `process-article` accepts a raw snippet). This is mostly a paste-text UI + a `source_type` so BYOC articles don't count against the news buffer cap. Enormous value-per-effort: lyrics, blog posts, emails, book passages — all with full personalization and SRS tracking.
### 2.2 Customizable topics (#10) — easy engagement win
Replace hardcoded `FEED_TOPICS` with user-managed interests synced to preferences. Small, and directly improves how "natural" the content feels to each user.
### 2.3 Magazines tab (#58), then RSS management (#11)
Long-form full-text sources (Guardian Open Platform, MIT TR full feeds) are a genuinely richer substrate than 800-char teasers, but this needs the open design questions answered first (char-cap/chunking above `TOTAL_SOURCE_CHAR_CAP=7000`, resumable reading position). Do it after BYOC proves out the long-form Reader UX. #11 (user-managed RSS) folds naturally into whichever of #10/#58 lands first — consider closing it as absorbed.

* * *
## Phase 3 — New learning dimensions (months)
### 3.1 Grammar (#43) — the biggest missing pillar
Vocabulary has a full loop; grammar has one cached Gemini sentence per word. The issue's investigation is solid: seed a `grammar_points` table from Hanabira (MIT/CC), build a rule matcher over the **existing kuromoji token stream** (POS + `conjugated_form` are already there) for the top ~100 N5–N4 points, highlight matches in the Reader with a tap-for-explanation box, Gemini fallback constrained to catalog IDs. Long-term: grammar points enter SRS like words. This is the feature that turns "I can decode this sentence's words" into "I understand this sentence."
### 3.2 Audio & listening (not in any issue — recommended before #12)
The app is 100% visual; listening/pronunciation is absent. Before the full podcast feature (#12), add cheap TTS: a speaker button in WordModal and on flashcards (browser `speechSynthesis` has decent ja-JP voices at zero cost; upgrade path to an edge TTS later). Hearing every studied word is table stakes for a language app and de-risks #12.
### 3.3 Sentence-translation peek (#7)
Pre-generate sentence translations during processing and show them as a double-tap peek. Nice polish once Phase 1–2 are in.
### 3.4 Daily podcast (#12)
Furthest out; revisit after 3.2 establishes the audio plumbing and listening-vs-reading mastery is designed.

* * *
## Ops track (parallel, as-needed)
- **#9 (beta/UAT environment)** — becomes important the moment prompt changes can regress live users; the eval harness covers the rewrite prompt but nothing covers DB migrations. Do a lightweight version: second Supabase project + Vercel preview env vars.
  
- **#6 (dev mode / feature flags)** — do the minimal slice when Phase 2 lands (sandbox mode so you can test BYOC/magazines without polluting your own SRS); skip the full flag system until there's a second developer or real staged rollouts.
  
## Additional UX ideas (not in any issue, low cost)
- **Post-article recap**: after "finish article," show the 3–5 new/review words just encountered — a natural reinforcement moment the SRS data already supports.
  
- **Onboarding lexicon seed**: new users have <300 known words so the lexicon path never activates. A 2-minute "which of these do you know?" self-test at onboarding could seed confirmed-known words and give day-one readers the good pipeline.
  
- **Streak surfacing**: `reviewsByDay` already powers a heatmap; a simple current-streak number on the Study tab is nearly free and meaningfully sticky.
  

* * *
## Suggested sequence (TL;DR)
| Order | Item | Why now |
| --- | --- | --- |
| 1   | Phase 0 (merge, validate Gemini output, Sentry, #54, SW, cron) | Protects everything already shipped |
| 2   | #103 concept↔SRS matching | Highest-leverage article quality; already scoped |
| 3   | Local-only word gap + Phase 1 correctness batch | Data integrity for everything downstream |
| 4   | #38 BYOC + #10 topics | Cheapest path to "learn from content _you_ care about" |
| 5   | #43 grammar (start: top 100 rules) | The missing learning pillar |
| 6   | TTS → #58 magazines → #7 peek → #12 podcast | Breadth once the core is deep |
