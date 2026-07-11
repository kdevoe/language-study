# Word Mastery Loop — North-Star Plan

**Theme:** Close the loop between reading and study. Words encountered in articles get the **right JLPT level**, are **tracked in a real SRS**, that SRS **drives which words the LLM puts in the next article**, and the same SRS **powers a flashcard deck** — whose reviews feed back into tracking. One loop, five goals.

```
        ┌─────────────────────────────────────────────────────────┐
        ▼                                                         │
  Read article ──► Track word (correct JLPT + SRS schedule) ──► SRS state
        ▲                                                         │
        │                                                         ├─► picks REVIEW/NEW words for the next article (LLM palette)
        │                                                         │
  Flashcard review ◄────────────────── due-today deck ◄──────────┘
        │
        └─► grades feed back into the same SRS state
```

**How to use this doc:** This is the **umbrella/north-star**. It sequences five workstreams (A–E) and points at the tactical docs/issues that carry the detail. It does **not** re-spec work already detailed in [`content-and-word-selection-plan.md`](./content-and-word-selection-plan.md) — Phases A and B *are* that doc's Tier 2–3, referenced here so the whole arc reads as one story. Phases C, D, E are new and specified here.

**Legend:** 🟢 cheap / high-leverage · 🟡 medium · 🔴 large · ✅ done · [/] in progress · [ ] not started

**📍 You are here (2026-07-05):**
- **Phase A is complete** — #39 (canonical entry-id keying, PR #90), #37 (JMDict sense display), and #41 (sync/hydration, done across #85-88 + the ungraded-local merge fix) all shipped. Word tracking is now one record per canonical `entry_id`, and the Progress page / server sync agree.
- **Phase B is complete and deployed** — the shared Word Priority Metric (#69) and all three consumers shipped: prefer confirmed-familiar backbone (#25), JLPT-proximity + stretch words (#22), and the topic-independent review floor (#51). Article word-selection now reads one shared scorer — and, post-#39, on de-fragmented data.
- **Phase C is complete** — models pinned + upgraded to `gemini-3.5-flash` (#64 ✅); the **eval harness (#65 ✅)** ships — `scripts/eval-article-rewrite.mjs` scores rewrites on a frozen golden set (`scripts/eval-fixtures/`) via the extracted, shared prompt module, with EVAL-001 as an automated regression. Its verdict: **flash beats/ties `gemini-3.1-pro-preview` on every axis at ~half latency/cost → stay on flash**. The **prompt restructure (#66 ✅)** then closed the one remaining gap: a surgical GOLDEN-RULE anti-fabrication edit lifted factual fidelity **4.00 → 5.00** at equal-or-lower cost, measured against the harness (see [`phase-c-eval-notes.md`](./phase-c-eval-notes.md)).
- Goals 4–5's remainder (eval/prompt, then the real SRS engine + flashcards) are the open frontier: **Phase C** (#65/#66) can run anytime; **Phase D** (#67 FSRS engine + #68 intake queue) is the next big build, with **Phase E** (flashcards) on top.

> **➡️ NEXT UP: Phase D #68 (intake queue).** #67 (FSRS engine) shipped 2026-07-11 — words now carry a real `due_at`/stability schedule seeded from `difficulty`, and in-context reads advance it (see [`fsrs-engine-design-67.md`](./fsrs-engine-design-67.md)). The frontier is now the foundation-first intake queue + daily new-word cap that gates words into that schedule.
>
> **Scope note (2026-07-05, discovered during #39):** #39's original spec also targeted a *server-side* Pass 3 that first-match-linked JMDict entries and could override the client's disambiguation (Concern B). **That server pass has since been removed** — all tokenization + entry-linking is now client-side (kuromoji + `enrich.ts`, which attaches `jmdict_entry_id` at enrich time). So Concern B was moot; #39 shipped as purely the client-side canonical-keying fix (which also absorbed the folded-in #74 `times_seen` work).

**Two decisions locked (2026-06-20):**
1. **SRS foundation → real FSRS/SM-2 due-dates.** We add a genuine scheduling layer (intervals + `due_at`) on top of the existing `difficulty` signal — not a pseudo-due hack. This is the prerequisite for the flashcard deck (Phase D → E).
2. **Model → investigate before committing.** Audit/pin current versions, **check whether a newer Gemini flash (e.g. 3.5-flash) is available**, and decide flash-vs-pro per task against an eval harness rather than upgrading blind.

---

## Current-state findings (why this plan exists)

A fresh read of the code (2026-06-20) established the baseline:

- **JLPT assignment** is a 3-tier hierarchy: official `jmdict_entries.jlpt_level` → kanji-derived (`kanji_jlpt`, hardest kanji wins) → frequency fallback (`freqRankToJlpt`). It's mostly sound, but **entry-resolution divergence** between client and server means the JLPT a user *sees* can differ from the one the server *uses* (#39), and homographs can track mastery against the wrong entry (#39, #37).
- **SRS today is NOT spaced repetition.** `user_word_progress` has `mastery_level`, `difficulty` (1–10), `times_seen`, `streak`, `last_seen_at` — **no `due_at`, no interval, no ease/stability, no review log.** Progression is a static ±1 (read-past) / +2 (lookup) nudge with daily dedup. Words resurface *opportunistically* when an article's topic happens to match — not on a schedule. (This is the gap Phase D fills.)
- **Word→LLM selection** already consults SRS `mastery_level` to bucket a topic-keyed palette (known/review/new) in `process-article`, but uses hard JLPT cutoffs and only the coarse bucket (not numeric `difficulty`/`times_seen`). #25/#22/#51 fix this.
- **Model reality:** article rewriting and grammar lookups run on **`gemini-3-flash-preview`** (unpinned), keyword extraction + readings/translation on Groq **`openai/gpt-oss-20b`**, news clustering on Groq **`llama-3.3-70b-versatile`**. *(Note: `CLAUDE.md` still says "Gemini 2.0-flash" — stale; worth correcting.)* No prompt-eval harness exists; no model versions are pinned.
- **Flashcards:** none. Zero existing UI/quiz/deck code. Word-progress data *is* fully queryable (store `wordDatabase` + `fetchUserWordProgress`), so the deck has a backend to read from once a scheduler exists.
- **Intake:** none. The app grades **every** word on sight (immediate `seedDifficulty` + `applyDifficultyEvent` on read) — there is no queue, no daily-new cap, nothing holding words back. This is the "overwhelm" gap below.
- **Tracking has no canonical key.** The same word is counted under different identifiers by path — kuromoji `lemma` on passive reads, JMDict `details.word` on clicks, `entry_id` on sync (`Reader.tsx:231/308/340`, `store.ts:313`) — so one word fragments into several records, and entry_id-less tokens never sync. Since `times_seen` feeds intake ordering, difficulty, and staleness, this corrupts the SRS foundation. Same root cause as the entry-resolution problem, so it's folded into #39 as a `times_seen` acceptance criterion (fix early, Phase A).

---

## Cross-cutting subsystem — Word prioritization & intake

Three signals — **SRS state, JLPT level, natural frequency** — are being combined to decide which words matter when. That's enough complexity to be its **own subsystem**, not logic scattered through palette construction. It splits into **two orderings** for **two moments in a word's life**, sharing a common *level + frequency* foundation. *(Likely graduates to its own design doc once it firms up; built as a reusable module so Phases B, D, E all call one scorer.)*

### 1. Intake queue (pre-SRS) — which words enter the system, and in what order

Today the app grades every word on sight, which floods the user. Instead, encountering a word puts it in a **dynamic intake queue** — seen, recorded, *waiting*, but not yet on a review schedule. **Nothing is discarded**; words that aren't ready yet wait their turn in an ordered queue.

- **Promotion ordering = JLPT level first, then frequency.** Lowest level band promotes first — **build a strong N5/N4 foundation before reaching into higher levels** — and within a level, most-frequent-in-normal-text first (`jmdict_entries.freq_rank`). So the common, low-level backbone is mastered before harder/rarer words ever enter active study.
- **Daily new-word limit (Anki-style).** A configurable cap (*N new words/day*) promotes the top-of-queue words into active SRS each day, so intake is paced and never overwhelming. Surfaced in Settings.
- **Re-encountering a queued word** records exposure (feeds `times_seen`/recency, can nudge queue position) but starts **no** interval schedule until promotion.

### 2. Word Priority Metric (in-SRS) — which active words to surface

For words already promoted, a single comparable **priority score** decides which to weave into the next article and how to order the flashcard deck. It layers the SRS signal on top of the same level + frequency foundation:

- **SRS signal** — due-ness / `difficulty` / lapses. Stuck and due words rank up.
- **Level fit** — *difficult words at or below the reader's level rank highest; above-level stretch words rank below in-reach ones* (revises #22's earlier upward tilt).
- **Natural frequency** — common words favored at every level.

**Consumers:** the LLM article palette (Phase B) and the flashcard deck ordering (Phase E) read the **same** scorer, so "what to study" is consistent everywhere.

**Shared foundation:** both orderings rest on **level + frequency**. Intake uses *only* those two (foundation-first; no SRS signal yet because the word isn't scheduled); the in-SRS metric adds due-ness/difficulty on top.

---

## Phase A — Foundation correctness (Goal 1: assign JLPT right · Goal 2: track right) — ✅ COMPLETE (2026-07-05)
*Status: shipped. Detailed in [`content-and-word-selection-plan.md`](./content-and-word-selection-plan.md) Tier 3.*

Garbage-in guard: if JLPT/entry resolution is wrong **or reads aren't counted**, the SRS schedule, the LLM palette, and the flashcard deck all inherit the error. Phase B (#25/#51) ranks on `times_seen`/`difficulty`/`last_seen_at`, so this foundation now feeds shipped features de-fragmented data — and it's the prerequisite for Phase D's per-word FSRS schedule.

- ✅ **#39 — Canonical `entry_id` keying (PR #90)** 🔴 — all word tracking (the `wordDatabase` key, grade/click dedup sets, and the Supabase `word_id`) now keys on one canonical `entry_id` resolved at enrich time, so conjugations and kana/kanji variants collapse into one record and the local key equals the server `word_id`; surface/lemma became display-only (new `WordData.surface`). Added a `mergeWordData`/`mergeWordRecords` collapse path and a v5 persist migration (browser-tested). Absorbed the folded-in #74 `times_seen` under-count fix. **The server-side Pass-3 override (original Concern B) turned out to be already removed** — linking is client-side now — so #39 shipped as purely client-side keying.
- ✅ **#37 — JMDict sense display (手当て → "salary")** 🟢 — 手当/手当て is one entry (`1598240`) with senses [salary…][medical care/treatment][preparation]; the modal flattened glosses and showed only sense 1. Now `summarizeSenses` leads a polysemous word with one gloss per sense ("salary; medical care; advance preparation") so the treatment sense surfaces; single-sense words keep their first-few synonyms.
- ✅ **#41 — Sync/hydration gap** 🟡 — resolved across #85 (JLPT backfill → words leave Progress "Other"), #86 (local→server grade reconcile), #87 (rehydrate the cache from the server after a wipe), #88 (paginate `fetchUserWordProgress` past the 1000-row cap), plus a merge fix so a server grade reaches an already-used device even when it didn't bump `last_seen_at`. *Deferred as future work (not part of #41's acceptance): full per-field cross-device reconcile (original "Option A"); and local-only words with no `entry_id` still can't rehydrate (inherent — no server row).*
- ✅ **Shipped 2026-06-19:** `seedDifficulty` null-JLPT default 9→6; no grading off un-enriched tokens; persist-v4 re-seed migration.

**Phase-A exit (met):** a word shows one consistent, correct N-badge everywhere; a cleared device hydrates its full vocabulary after sync; mastery accrues against one entry_id per word.

---

## Phase B — SRS-driven word selection for the LLM (Goal 3) — ✅ COMPLETE (2026-06-22)
*Status: shipped and deployed. All four items below merged; `process-article` now reads one shared scorer (`supabase/functions/_shared/wordPriority.ts`). Detail in [`content-and-word-selection-plan.md`](./content-and-word-selection-plan.md) Tier 2.*

Build these as **one series around a shared `priorityScore(word, user)`**, not three disconnected PRs (#25 widens the data select that #51 needs).

The LLM palette is the first consumer of the **in-SRS Word Priority Metric** defined in [Cross-cutting subsystem — Word prioritization & intake](#cross-cutting-subsystem--word-prioritization--intake). #25/#22 stand that scorer up server-side — **build it as a reusable module** (#69) so the intake queue (Phase D) and flashcard deck (Phase E) share one implementation.

- ✅ **#69 Extract the Word Priority Metric into a shared scoring module** 🟡 — `_shared/wordPriority.ts`: one place combining SRS signal + level fit + frequency, callable from `process-article` (and ready for the intake job + deck). Prevents three drifting copies of "which word matters."
- ✅ **#25 — Prefer confirmed-familiar over assumed-from-level words** 🟡 *(keystone)* — widened the server `user_word_progress` select to include numeric `difficulty` + `times_seen`; verified-easy words now rank ahead of never-seen below-level guesses in the KNOWN backbone.
- ✅ **#22 — Prioritize unknown vocab by JLPT proximity + difficulty + frequency** 🟡 — replaced hard `>`/`===`/`<` bucketing with `proximityRank`: at-level highest, easier in-reach next, above-level stretch ranked below in-reach (decreasing with hardness). Widened `jmdict_vocab_candidates` to expose words 1–2 levels harder (migration `database/22_vocab_candidates_stretch.sql`); NULL JLPT handled explicitly (lowest).
- ✅ **#51 — Topic-independent review slot** 🟡 *(best reinforcement ROI)* — reserves up to 2 review slots for the most-stuck words (by `compareStuck` staleness heuristic) regardless of article topic. **The no-engine interim** delivering most of the flashcard "feed due words" benefit *before* Phase D; once FSRS lands, the staleness ordering upgrades to true `due_at` (#72).

**Phase-B exit:** the article backbone is anchored by words the user has actually confirmed; stretch words near the user's level surface as "new"; stuck words resurface even off-topic.

---

## Phase C — Prompt & model optimization (Goal 4) — **NEW workstream**

No prompt-eval harness exists and models are unpinned. Make model choice data-driven, then optimize prompts against a fixed yardstick.

- ✅ **#64 Audit & pin LLM model versions across edge functions** 🟢 *(done 2026-06-21)*
  - Centralized every model string in `supabase/functions/_shared/models.ts` (single bump point per model); imported across process-article, dictionary-lookup, fetch-raw-news.
  - **Upgraded** Gemini from the floating `gemini-3-flash-preview` alias to stable `gemini-3.5-flash` (verified live on both call paths). Groq IDs are themselves the version. Corrected the stale "Gemini 2.0-flash" reference in `CLAUDE.md`.
  - **Acceptance met:** no floating `-preview` strings; one place to bump each model.
- ✅ **#65 Build a process-article eval harness + investigate latest Gemini flash** 🟡 *(done 2026-07-05 — harness + golden set + flash-vs-pro verdict landed)*
  - ✅ **Model investigation** — recorded the July-2026 landscape in [`phase-c-eval-notes.md`](./phase-c-eval-notes.md), with ids confirmed via the harness's `--list-models`: `gemini-3.5-flash` is GA/pinned ($1.50/$9); there is **no `gemini-3.5-pro` or `gemini-3.1-pro` id** (3.1 Pro ships only as `-preview`), so the real flash-vs-pro target is `gemini-3.1-pro-preview`. Aliases + prices live at the top of the harness.
  - ✅ **Prompt extracted** to `supabase/functions/_shared/rewritePrompt.ts` (byte-identical) so the harness tests the shipped prompt; `process-article` now imports it. De-risks #66.
  - ✅ **Golden set + harness** — `scripts/eval-fixtures/*.json` (7 fixtures, N5–N2, incl. EVAL-001 as a `mustNotContain` regression) with a **frozen palette** so the harness makes no Supabase/Groq calls; `scripts/eval-article-rewrite.mjs` scores deterministic axes (JSON validity, markup cleanliness, paragraph count, yugen-box, palette adherence via kuromoji, regressions) + an LLM judge (Gemini 3.1 Pro, configurable) for fidelity/JLPT-fit/naturalness, plus cost + latency; emits a per-model scorecard + JSON report.
  - ✅ **Flash-vs-pro run + verdict (2026-07-05)** — full-coverage scorecard (7 fixtures, judge = `gemini-3.1-pro-preview`): **flash ties or beats `gemini-3.1-pro-preview` on every axis** (fidelity 4.00 vs 3.57, naturalness 4.86 vs 4.57, equal JLPT-fit + 100% deterministic) at **~half the latency and ~46% the cost** → **stay on `gemini-3.5-flash`**. Recorded in [`phase-c-eval-notes.md`](./phase-c-eval-notes.md).
  - ⏳ **Optional follow-up:** grow the golden set toward ~15–20 real cases as failures surface (the set is designed to grow; not blocking).
  - **Acceptance (met):** a repeatable harness produces a per-model scorecard, and the flash-vs-pro call is made **from data** — cheap tasks stay on flash/Groq. flash's fidelity 4.00 (not 5.00) is the headroom #66 targets against this same harness.
- ✅ **#66 Restructure the article-rewrite prompt** 🟡 *(done 2026-07-06)*
  - The #65 baseline localized the entire remaining gap to one failure mode: flash **padded thin sources by fabricating** (invented quotes/reactions, editorial conclusions) to hit the paragraph target — worst on the N2 fixtures (EVAL-006/007 fidelity 2). Every other axis was already at ceiling.
  - **Surgical, not a restructure:** one GOLDEN-RULE edit in `_shared/rewritePrompt.ts` — forbids invented facts/quotes/reactions/sentiment + editorial conclusions, and makes fidelity override length (*write fewer paragraphs before padding*). Palette/kanji/vocab/JSON blocks left byte-identical (they were maxed; touching them is pure regression risk). The rule is general, not fixture-tuned — can't overfit.
  - **Result (measured on the harness):** factual fidelity **4.00 → 5.00** (EVAL-006/007 2→5), at **equal-or-lower cost** ($0.0039→$0.0037) and latency (11.3s→10.5s); JLPT/JSON/markup/paragraphs still 100%. Accepted side-effects (logged): naturalness 4.86→4.57 (~0.3 judge wobble on N4/N5 text), EVAL-006 review words 2/2→1/2.
  - **Acceptance (met):** measurable fidelity lift at equal-or-lower cost, every change gated by #65's harness — no blind prompt edits.

**Phase-C exit:** model versions are reproducible; the flash-vs-pro question is answered with numbers; prompt changes are regression-guarded.

---

## Phase D — Real SRS scheduling engine + intake queue (Goal 5 foundation) — **NEW workstream**

The decision: a genuine FSRS/SM-2 layer with `due_at` + intervals, on top of (not replacing) the existing `difficulty` signal, **plus the intake queue that gates words into it**. This is what makes "study what's due today," "feed due words to the LLM," and "pace new words" possible.

- ✅ **#67 SRS scheduling layer (FSRS)** 🔴 *(done 2026-07-11 — see [`fsrs-engine-design-67.md`](./fsrs-engine-design-67.md))*
  - **Schema** (`database/23_fsrs_scheduling.sql`): extended `user_word_progress` with `stability`, `fsrs_difficulty`, `due_at`, `last_reviewed_at`, `interval_days`, `reps`, `lapses`, `srs_status` + a `idx_uwp_due` partial index; added the append-only `srs_review_log` table (rating + before/after state + source). One-time SQL backfill seeds a schedule from `difficulty` + `last_seen_at`.
  - **Algorithm** (`src/services/srs.ts`): pure `schedule(state, rating, now)` wrapping `ts-fsrs` (FSRS-6, `request_retention` 0.85, deterministic); `ratingForReaderEvent` + `seedSrsFromDifficulty` seed initial stability from the coarse `difficulty` so existing tracking is preserved. 18/18 unit tests (`scripts/test-srs.mjs`, `npm run test:srs`).
  - **Reader integration:** `store.applyDifficultyEvent` gained a scheduling arm — read-past → "Good", lookup → "Again"; **reading always advances the schedule** (D3, revised in review) with the push self-limited by FSRS's early-review math, so in-context reading shrinks the flashcard deck. Persist bumped v5→v6 (eager client seed). Sync extended (`api.ts`): scheduling columns + `logSrsReviewToSupabase`.
  - **#72 hook provided (not wired):** `wordPriority.ts` gained `dueAt`/`stability` on `WordSignal` + a `compareByDue` comparator; #72 flips `compareStuck`'s callers over to it.
  - **Acceptance (met):** every active word gets a `due_at`; reading/reviewing reschedules it + writes a review-log row; the `idx_uwp_due` "due today" query is in place; `difficulty` preserved as the seed. **Decisions:** FSRS; extend-table + review-log; read-past always advances (early gain diminished).
  - **Deploy note:** `database/23_fsrs_scheduling.sql` must be applied by hand in Supabase (migrations are manual); run `vacuum analyze user_word_progress` after the bulk backfill.
- [ ] **#68 Word intake queue + daily new-word limit (foundation-first promotion)** 🔴
  - Add an intake queue so encountered-but-unscheduled words **wait** instead of being graded on sight. Model as a `status` on `user_word_progress` (`queued` → `active`) or a dedicated queue table.
  - **Promotion ordering: JLPT level ascending, then `freq_rank` ascending** (lowest level + most common first) — the foundation-first rule. Lower levels are fully drained before higher levels start promoting.
  - **Daily new-word limit:** a configurable cap promotes the top-of-queue words into active scheduling each day; expose it in Settings (Anki "new cards/day" analog). A daily promotion job (or on-open client pass) does the promoting.
  - **Behavior change:** reading a *queued* word records exposure (`times_seen`/recency, queue-position nudge) but starts no interval; only *active* words get FSRS scheduling + soft-bump. Migrate today's graded-on-sight rows into `queued`/`active` sensibly (e.g. already-mastered → active, the long tail → queued by the foundation-first order).
  - **Acceptance:** new words enter active study only at the daily cap, lowest-level-most-frequent first; the deck and LLM never see a word before it's promoted; the backlog waits in a visible, ordered queue.

**Phase-D exit:** the app has a real spaced-repetition schedule (queryable as "what's due," with an audit log) **and** a paced, foundation-first intake queue feeding it under a daily cap.

---

## Phase E — Flashcard system (Goal 5) — **NEW workstream, decomposes #8**

`#8` is a good epic but bundles UI + algorithm + reader-synergy + article-feed + dashboard. With Phase D providing the engine, decompose #8 into shippable slices. Recommend **keeping #8 as the tracking epic** and opening focused children:

- [ ] **#70 Flashcard study UI** 🔴
  - Zen-minimalist front/back/reveal card; **Again / Hard / Good / Easy** rating buttons wired to Phase D's `schedule()`; micro-animations for transitions.
  - New `'flashcards'` tab: extend `activeTab` union (`App.tsx:20`), add a `BottomNav` entry (`BottomNav.tsx:10-14`), branch in the content switch (`App.tsx:632-651`). No nested hub/reading state needed.
  - Deck source = Phase D "due today" + new-word intake, reading from `wordDatabase` / `fetchUserWordProgress`.
  - **Acceptance:** a user can study a due deck; each rating reschedules the word and writes a review-log row.
- [ ] **#71 Reader ↔ flashcard synergy (formalize soft-bump)** 🟡
  - Ensure reading a due word in an article and grading it on a flashcard converge on the *same* SRS state (no double-counting; daily dedup respected). Mostly a Phase-D integration test + reconciliation, surfaced as its own slice because it's the loop's hinge.
  - **Acceptance:** reading a due word advances its schedule; it then appears less often / later in the deck, and vice versa.
- [ ] **#72 Feed due words into article generation** 🟡
  - Upgrade #51's staleness heuristic to true **`due_at` ordering**: the topic-independent review slot pulls genuinely-due words. This is #8's "feed Due words as priority targets," now backed by a real engine.
  - **Acceptance:** words due for review preferentially appear in the next generated article's review palette.
- [ ] **#73 Study dashboard** 🟢
  - Deck health (due / new / learning counts), daily-goal/heatmap, on the existing Progress page (which Phase A/#41 already makes accurate).
  - **Acceptance:** the dashboard reflects the real due-queue and review history.

**Phase-E exit:** the loop is closed — read ⇄ schedule ⇄ deck ⇄ article selection all share one SRS state.

---

## Dependencies & sequencing

```
Phase A (correct data) ──┬─► Phase B (SRS→LLM selection)      ✅ both done
                         │
                         └─► Phase D (FSRS engine) ──► Phase E (flashcards)
                                                          ▲
Phase C (prompt/model) ───────────[parallel]──────────────┘ (independent; improves output quality throughout)
```

- **A is ✅ complete** (2026-07-05) — #39 canonical keying + #37 sense display + #41 sync/hydration. It's the prerequisite for D and E (and retroactively de-noised B): tracking is now one record per canonical entry_id.
- **The Word Priority Metric (#69) is the shared spine.** Born in Phase B (#25/#22) but built as a module so the intake queue (#68) and deck (#70/#72) reuse it. Note the two distinct orderings it serves: **intake = level↑ then freq↑ (foundation-first)**; **in-SRS surfacing = SRS + level-fit + freq**.
- **B is ✅ complete** (2026-06-22) — the #69→#25→#22→#51 series shipped and deployed; #51's staleness heuristic is the bridge delivering due-word-feeding value until D's real `due_at` lands (#72).
- **C is ✅ done** (independent workstream) — #64 pinned the models, #65's harness settled flash-vs-pro from data, and #66's harness-gated prompt edit lifted fidelity to 5.00.
- **D before E** — the engine **and intake queue (#68)** are the flashcard foundation. **#72** is where #51's interim heuristic graduates to real due-dates.

### Recommended order
~~#64 (pin)~~ ✅ → ~~B (#69 metric → #25 → #22 → #51)~~ ✅ → ~~A (#39 canonical key → #37 → #41)~~ ✅ → ~~C (#65 eval → #66 prompt)~~ ✅ → ~~#67 (FSRS)~~ ✅ → **NEXT: #68 (intake queue)** → #70→#71→#72→#73 (flashcards).

Rationale: cheapest reproducibility win first; finish the in-flight selection refactor on correct data while extracting the shared metric; stand up the eval harness so model/prompt changes are measured; build the engine, then the intake queue that paces words into it; then the deck. Prompt restructure (#66) slots in once the harness exists and can run alongside D.

---

## New issues to create

| Ref | Title | Size | Phase | Status |
|-----|-------|------|-------|--------|
| [#64](https://github.com/kdevoe/language-study/issues/64) | Audit & pin all LLM model versions across edge functions (+ fix stale CLAUDE.md "Gemini 2.0-flash") | 🟢 | C | ✅ done |
| [#65](https://github.com/kdevoe/language-study/issues/65) | process-article eval harness + investigate latest Gemini flash (3.5?) for flash-vs-pro decision | 🟡 | C | ✅ done |
| [#66](https://github.com/kdevoe/language-study/issues/66) | Restructure & optimize the article-rewrite prompt (measured against #65) | 🟡 | C | ✅ done |
| [#69](https://github.com/kdevoe/language-study/issues/69) | Extract the Word Priority Metric into a shared scoring module (SRS + level + frequency) | 🟡 | B (shared) | ✅ done |
| [#67](https://github.com/kdevoe/language-study/issues/67) | SRS scheduling engine: FSRS due-dates + intervals + review log atop existing difficulty | 🔴 | D | ✅ done |
| [#68](https://github.com/kdevoe/language-study/issues/68) | Word intake queue + daily new-word limit, foundation-first promotion (level↑ then freq↑) | 🔴 | D | not started |
| [#70](https://github.com/kdevoe/language-study/issues/70) | Flashcard study UI (Zen front/back/reveal, Again/Hard/Good/Easy) wired to #67 | 🔴 | E | not started |
| [#71](https://github.com/kdevoe/language-study/issues/71) | Reader ↔ flashcard synergy: converge read-past and graded reviews on one SRS state | 🟡 | E | not started |
| [#72](https://github.com/kdevoe/language-study/issues/72) | Feed due words into article generation (upgrade #51 staleness → real due_at) | 🟡 | E | not started |
| [#73](https://github.com/kdevoe/language-study/issues/73) | Study dashboard: due/new/learning health + daily goal on Progress page | 🟢 | E | not started |

**Existing issues this plan organizes:** ✅ #39 (absorbed the #74 `times_seen` fix), #37, #41 (Phase A) · #25, #22, #51 (Phase B) · #8 (epic that Phases D+E fulfill; decompose into #67, #68, #70–#73).

---

## TL;DR
Five goals are one loop, held together by a **shared Word Priority Metric** (SRS + level + frequency) and a **foundation-first intake queue** (level↑ then freq↑, paced by a daily new-word cap) that stops every-word-on-sight overwhelm. **Phase A is ✅ done** — canonical entry_id keying (#39), sense display (#37), and sync/hydration (#41), so tracking is one record per word on correct data. **Phase B is ✅ done** — the shared metric (#69) and all three consumers (#25/#22/#51) ship, so article word-selection reads one scorer. **Phase C is ✅ done** — models pinned + upgraded to `gemini-3.5-flash` (#64), the eval harness (#65) settled flash-vs-pro from data, and the prompt restructure (#66) lifted rewrite fidelity 4.00 → 5.00 on that harness. Still open: the **real FSRS due-date engine + intake queue** (Phase D), then the **flashcard deck** on top (Phase E) — at which point reading, scheduling, the deck, and article word-selection all share one SRS state.

---
comments:
  c1:
    body: ok
    by: user
    at: 2026-06-20T18:31:22.611Z
