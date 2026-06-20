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

**📍 You are here (2026-06-20):**
- Goals 1–3 are **in flight** via the content/word-selection plan (Tier 0–1 shipped; Tier 2 keystone #25 is next-up).
- Goals 4–5 (prompt/model optimization, flashcards) are **greenfield** — no implementation exists, and the only issue (#8) is a high-level epic assuming an SRS engine we haven't built. This doc opens those workstreams and lists the **new issues to create**.

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

## Phase A — Foundation correctness (Goal 1: assign JLPT right · Goal 2: track right)
*Status: detailed in [`content-and-word-selection-plan.md`](./content-and-word-selection-plan.md) Tier 3. Listed here because everything downstream inherits its data.*

Garbage-in guard: if JLPT/entry resolution is wrong **or reads aren't counted**, the SRS schedule, the LLM palette, and the flashcard deck all inherit the error. Do this alongside/ahead of Phase D.

- [ ] **#39 — Unify entry resolution (displayed vs stored JLPT) + canonical `times_seen` keying** 🔴 *(do early — foundational)* — homographs must resolve to one canonical `entry_id` so the badge, SRS seed, and palette read the same entry; stop the server's first-match Pass-3 linking from overriding the client's disambiguation; align NULL-JLPT handling (client "hard" vs server "ignored"). **Now also absorbs the `times_seen` under-count fix (folded in from #74):** the same word fragments across key spaces — passive reads key by kuromoji `lemma`, clicks by JMDict `details.word`, sync by `entry_id` (`Reader.tsx:231/308/340`, `tokenizer.ts:123`, `store.ts:313`), and entry_id-less tokens never sync — so all tracking must key on one canonical `entry_id`. Distinct from #41 (sync/display layer).
- [ ] **#37 — JMDict sense miss (手当て → "salary")** 🟢 — prefer the entry whose kanji form exactly matches the surface; consider context-disambiguating the sense.
- [ ] **#41 — Sync gap: remote progress doesn't hydrate locally** 🟡 — Option B (server-side aggregate query for the Progress page) first, Option A (full per-field reconcile across devices) as follow-up. Required so the flashcard deck and Progress page reflect *all* tracked words, not just locally-seen ones.
- ✅ **Shipped 2026-06-19:** `seedDifficulty` null-JLPT default 9→6; no grading off un-enriched tokens; persist-v4 re-seed migration.

**Phase-A exit:** a word shows one consistent, correct N-badge everywhere; a cleared device hydrates its full vocabulary after sync; mastery accrues against one entry_id per word.

---

## Phase B — SRS-driven word selection for the LLM (Goal 3)
*Status: detailed in [`content-and-word-selection-plan.md`](./content-and-word-selection-plan.md) Tier 2. The keystone (#25) is the project's current next-up.*

Build these as **one series around a shared `priorityScore(word, user)`**, not three disconnected PRs (#25 widens the data select that #51 needs).

The LLM palette is the first consumer of the **in-SRS Word Priority Metric** defined in [Cross-cutting subsystem — Word prioritization & intake](#cross-cutting-subsystem--word-prioritization--intake). #25/#22 stand that scorer up server-side — **build it as a reusable module** (#69) so the intake queue (Phase D) and flashcard deck (Phase E) share one implementation.

- [ ] **#69 Extract the Word Priority Metric into a shared scoring module** 🟡 — one function combining SRS signal + level fit + frequency, callable from `process-article`, the intake-promotion job, and the deck. Prevents three drifting copies of "which word matters."
- [ ] **#25 — Prefer confirmed-familiar over assumed-from-level words** 🟡 *(keystone)* — widen the server `user_word_progress` select to include numeric `difficulty` + `times_seen`; rank verified-easy words ahead of never-seen below-level guesses in the KNOWN backbone.
- [ ] **#22 — Prioritize unknown vocab by JLPT proximity + difficulty + frequency** 🟡 — replace hard `>`/`===`/`<` bucketing with the metric: **difficult at-or-below-level words first, frequency weighted in, above-level stretch words ranked below in-reach ones** (revises #22's upward tilt). Widen `jmdict_vocab_candidates` to expose words 1–2 levels harder *and* to carry `freq_rank` + per-user `difficulty` into the ranker; handle NULL JLPT explicitly (lowest).
- [ ] **#51 — Topic-independent review slot** 🟡 *(best reinforcement ROI)* — always reserve 1–2 review slots for the most-stuck words regardless of article topic. **This is the no-engine interim** that delivers most of the flashcard "feed due words" benefit *before* Phase D exists; once FSRS lands, the staleness heuristic here upgrades to true `due_at` ordering (see Phase E).

**Phase-B exit:** the article backbone is anchored by words the user has actually confirmed; stretch words near the user's level surface as "new"; stuck words resurface even off-topic.

---

## Phase C — Prompt & model optimization (Goal 4) — **NEW workstream**

No prompt-eval harness exists and models are unpinned. Make model choice data-driven, then optimize prompts against a fixed yardstick.

- [ ] **#64 Audit & pin LLM model versions across edge functions** 🟢
  - Pin every model string used in `supabase/functions/*` (`gemini-3-flash-preview` in process-article + dictionary-lookup grammar; `openai/gpt-oss-20b`; `llama-3.3-70b-versatile`) to explicit, reproducible versions; centralize them in one constants module per function.
  - Correct the stale "Gemini 2.0-flash" reference in `CLAUDE.md`.
  - **Acceptance:** no unpinned `-preview`/floating model strings; a single place to bump each model.
- [ ] **#65 Build a process-article eval harness + investigate latest Gemini flash** 🟡
  - Investigate model availability — **specifically whether a newer flash (e.g. `gemini-3.5-flash`) exists** and is appropriate; record current options for flash vs pro.
  - Capture a fixed set of ~15–20 real source articles + user profiles (varied JLPT/RTK/intensity) as a golden eval set.
  - Score rewrites on: factual fidelity to source, JLPT-appropriateness, palette adherence (known/review/new ratios actually hit), furigana/markup cleanliness, plus cost + latency.
  - Compare flash (current) vs newer-flash vs pro on the same set.
  - **Acceptance:** a repeatable harness produces a per-model scorecard; we choose flash-vs-pro **per task** (cheap tasks stay on Groq/flash) from data, not vibes.
- [ ] **#66 Restructure the article-rewrite prompt** 🟡
  - Tighten the `process-article` rewrite prompt: palette injection format, GOLDEN-RULE fidelity guardrail, kanji/vocab "preference mode" instructions, JSON-schema robustness. Consider native structured-output/JSON-schema mode over free-form array parsing.
  - Every change measured against #65's harness — no blind prompt edits.
  - **Acceptance:** measurable lift on the eval scorecard (palette adherence + fidelity) at equal-or-lower cost.

**Phase-C exit:** model versions are reproducible; the flash-vs-pro question is answered with numbers; prompt changes are regression-guarded.

---

## Phase D — Real SRS scheduling engine + intake queue (Goal 5 foundation) — **NEW workstream**

The decision: a genuine FSRS/SM-2 layer with `due_at` + intervals, on top of (not replacing) the existing `difficulty` signal, **plus the intake queue that gates words into it**. This is what makes "study what's due today," "feed due words to the LLM," and "pace new words" possible.

- [ ] **#67 SRS scheduling layer (FSRS/SM-2)** 🔴
  - **Schema:** extend `user_word_progress` (or a new `srs_state` table) with scheduling fields — interval, `due_at`, stability/ease (FSRS) or EF (SM-2), `last_reviewed_at`, lapse count. Add a `srs_review_log` append-only table (word_id, rating, scheduled_interval, reviewed_at) for auditability and future FSRS optimization.
  - **Algorithm:** implement the chosen scheduler (recommend **FSRS** — better retention modeling, open-source params) as a pure function `schedule(state, rating, now) → newState`. Keep `difficulty` (1–10) as a *seed/prior* into initial stability so existing tracking isn't thrown away.
  - **Migration:** backfill `due_at`/interval for existing rows from current `difficulty` + `last_seen_at` (mature/easy words → longer initial intervals; hard → due soon).
  - **Reader integration (soft-bump):** a read-past on a due word counts as a "Good"-ish pass (extends interval); a lookup counts as "Again/Hard" (resets/shortens). This subsumes today's ±1/+2 nudge with schedule-aware logic.
  - **Decisions to confirm at build time:** FSRS vs SM-2; new table vs extend; how aggressively read-past advances the schedule vs explicit flashcard grades.
  - **Acceptance:** every *active* word has a `due_at`; reviewing/reading an active word reschedules it; a "due today" query returns the right set; existing difficulty data is preserved as the seed.
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
Phase A (correct data) ──┬─► Phase B (SRS→LLM selection)      [in flight]
                         │
                         └─► Phase D (FSRS engine) ──► Phase E (flashcards)
                                                          ▲
Phase C (prompt/model) ───────────[parallel]──────────────┘ (independent; improves output quality throughout)
```

- **A is prerequisite** for D and E (and improves B): correct entry-resolution/JLPT before you schedule, queue, or feed words.
- **The Word Priority Metric (#69) is the shared spine.** Born in Phase B (#25/#22) but built as a module so the intake queue (#68) and deck (#70/#72) reuse it. Note the two distinct orderings it serves: **intake = level↑ then freq↑ (foundation-first)**; **in-SRS surfacing = SRS + level-fit + freq**.
- **B is already underway** — finish the #25→#22→#51 series; #51 is the bridge that delivers due-word-feeding value *before* D ships.
- **C is independent** and can run in parallel anytime; do **#64 pinning** first (cheap), then the **#65 eval harness** before any prompt or model change.
- **D before E** — the engine **and intake queue (#68)** are the flashcard foundation. **#72** is where #51's interim heuristic graduates to real due-dates.

### Recommended order
**#64 (pin) → finish B (#69 metric → #25 → #22 → #51) + A (#39 canonical key / counts reads right → #37 → #41) → #65 (eval) → #67 (FSRS) → #68 (intake queue) → #66 (prompt) → #70→#71→#72→#73 (flashcards).**

Rationale: cheapest reproducibility win first; finish the in-flight selection refactor on correct data while extracting the shared metric; stand up the eval harness so model/prompt changes are measured; build the engine, then the intake queue that paces words into it; then the deck. Prompt restructure (#66) slots in once the harness exists and can run alongside D.

---

## New issues to create

| Ref | Title | Size | Phase |
|-----|-------|------|-------|
| [#64](https://github.com/kdevoe/language-study/issues/64) | Audit & pin all LLM model versions across edge functions (+ fix stale CLAUDE.md "Gemini 2.0-flash") | 🟢 | C |
| [#65](https://github.com/kdevoe/language-study/issues/65) | process-article eval harness + investigate latest Gemini flash (3.5?) for flash-vs-pro decision | 🟡 | C |
| [#66](https://github.com/kdevoe/language-study/issues/66) | Restructure & optimize the article-rewrite prompt (measured against #65) | 🟡 | C |
| [#69](https://github.com/kdevoe/language-study/issues/69) | Extract the Word Priority Metric into a shared scoring module (SRS + level + frequency) | 🟡 | B (shared) |
| [#67](https://github.com/kdevoe/language-study/issues/67) | SRS scheduling engine: FSRS/SM-2 due-dates + intervals + review log atop existing difficulty | 🔴 | D |
| [#68](https://github.com/kdevoe/language-study/issues/68) | Word intake queue + daily new-word limit, foundation-first promotion (level↑ then freq↑) | 🔴 | D |
| [#70](https://github.com/kdevoe/language-study/issues/70) | Flashcard study UI (Zen front/back/reveal, Again/Hard/Good/Easy) wired to #67 | 🔴 | E |
| [#71](https://github.com/kdevoe/language-study/issues/71) | Reader ↔ flashcard synergy: converge read-past and graded reviews on one SRS state | 🟡 | E |
| [#72](https://github.com/kdevoe/language-study/issues/72) | Feed due words into article generation (upgrade #51 staleness → real due_at) | 🟡 | E |
| [#73](https://github.com/kdevoe/language-study/issues/73) | Study dashboard: due/new/learning health + daily goal on Progress page | 🟢 | E |

**Existing issues this plan organizes:** #39 (now also absorbs the #74 `times_seen` fix), #37, #41 (Phase A) · #25, #22, #51 (Phase B) · #8 (epic that Phases D+E fulfill; decompose into #67, #68, #70–#73).

---

## TL;DR
Five goals are one loop, held together by a **shared Word Priority Metric** (SRS + level + frequency) and a **foundation-first intake queue** (level↑ then freq↑, paced by a daily new-word cap) that stops every-word-on-sight overwhelm. Goals 1–3 are already being built (Phase A/B via the content plan — finish #25→#22→#51 on correct #39/#37/#41 data). Goals 4–5 are new: pin models, build an eval harness and check for a newer flash, restructure the prompt (Phase C); then build a **real FSRS due-date engine + intake queue** (Phase D) and the **flashcard deck** on top of it (Phase E), at which point reading, scheduling, the deck, and article word-selection all share one SRS state.

---
comments:
  c1:
    body: ok
    by: user
    at: 2026-06-20T18:31:22.611Z
