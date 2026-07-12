# #70 — Flashcard study UI (Phase E)

**Goal:** A zen-minimalist flashcard deck that lets the user study *due* words on a real schedule. Each **Again / Hard / Good / Easy** rating reschedules the word through the FSRS engine (#67) and writes a `srs_review_log` row — closing the last leg of the Word Mastery Loop (read ⇄ schedule ⇄ **deck** ⇄ article selection).

Part of [`word-mastery-loop-plan.md`](./word-mastery-loop-plan.md) Phase E. Depends on #67 (FSRS engine) + #68 (intake queue), both shipped.

---

## What already exists (so #70 is small)

The engine was built to be flashcard-ready. **No DB migration is needed:**

- `src/services/srs.ts:schedule(state, rating, now)` — the pure scheduler. Ratings `1|2|3|4` map 1:1 to Again/Hard/Good/Easy. Deterministic (`enable_fuzz=false`, injected `now`), so we can *preview* the interval each button would assign by calling it four times.
- `database/23_fsrs_scheduling.sql` — the `srs_review_log.source` check already whitelists **`'flashcard'`** alongside `reader_skip`/`reader_click`.
- `src/services/api.ts:logSrsReviewToSupabase(...)` — already accepts `source: 'flashcard'`.
- `WordData` already carries the full schedule (`stability`, `dueAt`, `srsStatus`, `reps`, …) and the intake status (`intakeStatus`, `promotedTs`).
- `store.applyDifficultyEvent` is the exact template for the new rating action — it seeds `priorSrs`, calls `schedule()`, updates the word, and fires the upsert + review-log writes.

So #70 is: **one pure deck-selector module, one store action, one component, three lines of tab wiring.**

---

## Deck source (the core question)

The issue says *"Deck source = due today (engine) + new-word intake (queue)."* Concretely, a word is in today's deck if either:

1. **Due review** — it's `active` and its schedule has come due: `dueAt != null && dueAt <= now`.
2. **New card** — it was just promoted from the intake queue but never actually studied: `intakeStatus === 'active' && promotedTs != null && (reps ?? 0) === 0`.

Why `reps === 0` for "new": `seedSrsFromDifficulty` seeds a promoted word with a *future* `dueAt` (an easy N5 word doesn't need studying today for *recall* purposes), so a freshly promoted word would never surface under rule 1 for days. But #68's daily cap **is** the "new cards today" limit (Anki-style) — a promoted word is meant to be studyable now. `reps === 0` cleanly means "the scheduler has never advanced this word" (reading or a prior flashcard both bump `reps`), and `promotedTs != null` excludes *grandfathered* known words (the #68 migration set `intake_status='active'` but left `promoted_at` null), so we don't dump a returning user's entire back-catalog into "new."

`active` = `intakeStatus === 'active' || stability != null` (the same legacy-safe check the store already uses). **Queued words never appear** — they're not scheduled yet.

### Ordering

- **Due reviews first**, most-overdue first (`dueAt` ascending) — urgency.
- **Then new cards, foundation-first** — easiest JLPT level first, then most common (`freqRank`). This is exactly `intake.ts:compareIntakeItem`, which is already pure and client-side, so the deck reuses it rather than re-deriving the order.

**No session cap.** #68 already paces how many new words become active per day, and due reviews are whatever the schedule produced. Capping again would hide genuinely-due work. (Anki caps *new*, not reviews; our new-cap lives upstream in #68.)

The deck is snapshotted at mount (capture `now` once) so cards don't reshuffle underfoot as each rating reschedules them out.

---

## Rating → reschedule (the store action)

New action `reviewWord(key, rating, now)`, modeled on `applyDifficultyEvent`:

1. Build `priorSrs` from the stored schedule, or seed it from `difficulty` if the word somehow isn't scheduled yet (same fallback as the reader path).
2. `const sched = schedule(priorSrs, rating, now)` → write `stability/fsrsDifficulty/dueAt/lastReviewedTs/intervalDays/reps/lapses/srsStatus` back onto the word.
3. **Also nudge the coarse `difficulty`/`mastery`** — a flashcard is the strongest, most explicit difficulty signal we get. Map `Again +2, Hard +1, Good −1, Easy −2` (clamped 1–10), then `mastery = bucketForDifficulty(difficulty)`, so the Progress page reflects study. This mirrors how reader skip/click already nudge the coarse signal, and keeps the LLM palette (which reads `difficulty`) honest. *(See D3 — open for review.)*
4. Sync: `upsertWordProgressToSupabase(...)` with the SRS + difficulty fields, and `logSrsReviewToSupabase(..., { rating, source: 'flashcard', stabilityBefore/After, difficultyBefore/After, scheduledDays, elapsedDays })`.
5. Does **not** touch `lastAdjustedDay` (the reader's once-per-day passive-read dedup) — an explicit flashcard grade is intentional and independent of passive-read throttling.

---

## The component — `src/components/Flashcards.tsx`

Zen-minimalist, matching the existing typography-first aesthetic (Shippori Mincho serif, no heavy chrome, existing CSS vars).

- **Front:** the word only — kanji/surface, large serif, *no furigana* (that's the answer). A muted "tap to reveal" affordance.
- **Reveal:** reading (kana) + meaning, plus the grammar note if present. Framer Motion cross-fade/flip (already a dep, used in `Feed.tsx`).
- **Rating row (post-reveal):** **Again / Hard / Good / Easy**, each labeled with the interval that rating would assign (e.g. `Good · 4d`), computed by calling `schedule()` four times against the current card — Anki-style, and cheap since the scheduler is pure. On tap → `reviewWord` → advance.
- **Header:** `n / total` progress + a thin progress bar.
- **Empty / done states:** a calm "You're all caught up — nothing due today" (deck empty) and a "Deck complete" summary after the last card. No nagging.
- Reads `wordDatabase` from the store; deck computed via `useMemo` on mount.

---

## Tab wiring (3 edits)

- `src/App.tsx:20` — extend `activeTab` union to `'news' | 'progress' | 'settings' | 'flashcards'`; add `{activeTab === 'flashcards' && <Flashcards />}` to the content switch (App.tsx:653).
- `src/components/BottomNav.tsx` — widen the `Props` union and add a `{ id: 'flashcards', label: 'STUDY', icon: Layers }` entry (lucide `Layers` = a deck). Four tabs at 80px fit the 600px max width.

---

## Pure module + test (established pattern)

Following `intake.ts` + `scripts/test-intake.mjs`:

- `src/services/deck.ts` — pure `selectDeck(entries, now)` returning ordered keys, plus `isDue` / `isNewCard` predicates. No store/clock/Supabase access.
- `scripts/test-deck.mjs` + `package.json` `test:deck` — esbuild-bundle and assert: due-before-new ordering, most-overdue-first, foundation-first among new, queued excluded, grandfathered-known (promotedTs null, reps 0) excluded from "new", not-yet-due active excluded.

---

## Acceptance (from the issue)

> A user can study a due deck; each rating reschedules the word and writes a review-log row.

Verified by: `npm run test:deck` (green) + a browser pass (open the STUDY tab, rate a card, confirm it leaves the deck, `dueAt` moved, and a `flashcard` `srs_review_log` row was written).

---

## Open decisions (please review)

**D1 — Deck membership = due ∪ new-unstudied?** Recommended as specced above. Alternative: due-only (simpler, but freshly-promoted words wouldn't appear for days — defeats "study new words").

**D2 — Ordering: due-first, then new foundation-first, no session cap?** Recommended. Alternative: interleave new among reviews, or cap the session (rejected — #68 already paces new words).

**D3 — Should a flashcard rating also nudge the coarse `difficulty`/`mastery`, or *only* the FSRS schedule?** Recommended: nudge (Again+2/Hard+1/Good−1/Easy−2), so Progress + the LLM palette reflect study. Alternative: FSRS-only (keeps the two difficulty signals fully separate, but then a word you keep failing on flashcards still looks "easy" to the article generator).

**D4 — Front shows the word (kanji, no furigana); reveal shows reading + meaning (+ grammar)?** Recommended. This is recognition→recall (see the Japanese, produce the reading/meaning). Alternative: reverse (meaning→word) or a furigana toggle — deferrable.

**D5 — Show the per-button next-interval preview (Anki-style)?** Recommended (cheap, pure). Alternative: hide it for a cleaner face.
