# Study-pacing flood fix — findings & recommendation

**Symptom:** opening the Study tab for the first time shows **1206 cards due** (deck reads local `wordDatabase`; server has more — see below). Expected: a gentle, paced deck.

## Root cause

Not the intake queue. The FSRS seed migration (`database/23_fsrs_scheduling.sql`, mirrored client-side in `store.ts` v6 persist migration) anchored every already-graded word's due date at:

```
dueAt = last_seen_at + interval(difficulty)      ← anchored in the PAST
```

Because the whole back-catalog was seeded at once from old `last_seen_at` timestamps, every word's interval had already elapsed → everything came due simultaneously. Compounding it: FSRS's seed-on-sight (`#67`) had already auto-graded a `difficulty` onto **every dictionary word ever read**, and the `#68` intake queue **grandfathered all of them as `active`** (design decision D2, `docs/intake-queue-design-68.md:56`). So the "active study" pool is really "every word I've ever read," not "words I chose to study."

## Real data (audit — `scripts/audit-reseed.cjs`, read-only, service role)

| metric | value |
|---|---|
| total `user_word_progress` rows | **2626** |
| active (deck-eligible pool) | 2626 |
| **due right now** | **1400** |
| never deliberately promoted (grandfathered) | 2620 / 2626 |
| difficulty 7–10 (auto-"hard", mostly seen once/twice) | **1243** |

The difficulty 7–10 mass is the load driver: seed-on-sight marks any word above your JLPT level as hard → tiny seeded interval → slams due immediately.

## Why the original plan (send `timesSeen ≤ 1` to the queue, forward-reseed the rest) isn't enough

It still leaves **1667 words active → ~162 reviews/day** steady-state. A daily cap wouldn't save it: if true demand (162/day) exceeds the cap, the overdue pile grows forever ("review hell"). **A cap only works if the active pool is small enough that demand ≤ cap.**

## Policy sweep (forward-reseed, conservative estimate, 3-day interval floor)

`rev/day` = steady-state review demand Σ(1/interval). `cap OK?` = smallest daily cap that ≥ demand (sustainable — the pile drains).

| policy | active | queue | rev/day | median interval | sustainable cap |
|---|---:|---:|---:|---:|---|
| A. `timesSeen≥2` (original plan) | 1667 | 959 | ~162 | 25d | >50/day ❌ |
| B. `timesSeen≥2 AND difficulty≤6` | 1002 | 1624 | ~22 | 57d | 30/day |
| **C. `timesSeen≥3 AND difficulty≤5`** | **729** | **1897** | **~11** | **90d** | **20/day** ✅ |
| D. `timesSeen≥5 AND difficulty≤5` | 567 | 2059 | ~6 | 115d | 10/day |
| E. `difficulty≤4 AND timesSeen≥3` | 635 | 1991 | ~7 | 98d | 10/day |

**The "easy N5 words I already know" you were worried about are safe under B–E:** `difficulty≤4` words are overwhelmingly N5 (332) / N4 (187). Forward-reseeding gives them 90–115-day intervals, so they surface rarely — they neither flood the deck nor get dragged back through the 3/day queue.

## Decision (settled with the user): Policy F — "flashcards augment reading"

The guiding principle: **flashcards serve reading, not the reverse.** They drill words you *need but haven't mastered*; they don't mirror everything you've read. That yields a clean split by the app's own mastery buckets:

- **Easy (difficulty ≤ 3)** → stay on the FSRS schedule but **forward-reseeded far out** (`seedForwardFromHistory`: anchored at now, stretched by exposure history). Reading pushes them further, so they rarely surface. Maintenance, not drilling. → **683 words, ~10 rev/day, 98-day median interval.**
- **Medium+ (difficulty ≥ 4)** → back to the intake **queue**, dripping into active study at the daily cap (3/day, foundation-first). → 1943 words, a prioritized reservoir (not a backlog to force-drain).
- **Graduate when easy** — automatic: a drilled word that grades down to easy naturally earns a long interval and joins the far-out pool. No extra code.

### Why no hard daily review cap (reversed from an earlier draft)

We considered an Anki-style N/day ceiling. **Rejected:** a hard cap that hides genuinely-due cards doesn't reduce work, it *defers* it into an invisible backlog — the exact "review hell" we're avoiding. The right cap is a **small natural inflow**, achieved by (a) the reseed keeping the active pool tiny and far-out, and (b) the pre-due window below. The deck shows *every* genuinely-due card. (The `reviewCap` primitive in `deck.ts` remains as a latent, default-**off** safety valve — nothing wires it.)

### Pre-due surfacing window (the primary inflow reducer)

A word becomes reviewable in the **reader** for a window *before* it's due, proportional to its interval (`PREDUE_FRACTION = 0.12` → a 2-month card gets ~a week; clamped to 1–21 days). `process-article` surfaces in-window words (most-urgent first) into the article's review slots; reading past one advances FSRS and pushes `due_at` out, so **it may never reach the flashcard deck.** Long-interval words enter their window early enough (in absolute days) to actually be reinforced. Implemented in `_shared/wordPriority.ts` (`preDueUrgency` / `selectPreDueFloor`) + `process-article/index.ts`.

### What "Rebalance Flashcard Deck" does (Settings → Advanced — one-shot, self-hides)

This is a **one-time correction**, not a recurring knob: the flood is a legacy artifact of #67 seed-on-sight + #68 grandfather, and it can't recur (new words enter the queue; reading no longer auto-activates). The button lives in Advanced Settings and **disappears once run** (gated on `lastStudyPacingResetTs`).

1. For each **active** word: easy → forward-reseed far out; medium+ → `queued` + cleared schedule (difficulty/mastery kept for re-promotion).
2. Clears `lastIntakePromotionTs` so the next open promotes a fresh batch; stamps `lastStudyPacingResetTs`.
3. Batched Supabase sync (writes nulls, so cleared schedules persist cross-device).

## Status of implementation — ✅ built & tested (branch `feat/reader-flashcard-synergy-71`)

- ✅ Read-only audit + policy sweep (`scripts/audit-reseed.cjs`).
- ✅ Forward-reseed estimator (`srs.ts: seedForwardFromHistory`); reclassification policy (`pacing.ts`); latent review-cap primitive (`deck.ts`).
- ✅ `resetStudyPacing` store action + `resetStudyPacingBatch` sync + Settings "Rebalance Flashcard Deck" button (with confirm). **Nothing runs until you click it** — no live data was mutated.
- ✅ Pre-due surfacing window (`wordPriority.ts` + `process-article/index.ts`).
- ✅ Tests: `test-srs` (36), `test-deck` (32), `test-pacing` (15), `test-wordpriority` (25), `test-intake` (14) all green; frontend `tsc` clean.
- ⏳ Not done: apply nothing to prod yet. To activate: deploy `process-article` (`supabase functions deploy process-article`), then click **Settings → Rebalance Flashcard Deck**. No new DB column needed (reuses existing `user_word_progress` scheduling columns).
