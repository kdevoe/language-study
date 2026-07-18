# Intake v2 — needs-first promotion, triage gate, Easy-refund (spec)
Companion to `docs/srs-usage-audit-2026-07-18.md`. That audit found the flashcard system starved and mis-fed: the 3/day intake lane spends most slots on N5 words already known (14 of 24 promotions first-graded "Easy", no refund), while the words with demonstrated need — common N3 and unrated-but-common words looked up 3–6 times — sit unreachable behind roughly 900 rare N5/N4 dictionary candidates (about 10 months at 3/day). Vocabulary growth has consequently stalled: known-word additions fell from ~500/week (mid-June) to ~70/week.

This spec changes **which words win daily intake slots and what a slot costs**. It does NOT touch FSRS scheduling math, reader_skip credit (Finding 1 — separate design), or article generation.
## Goals
1. Daily intake slots buy _genuinely new_ vocabulary, ranked by expected real-world encounters, not curriculum position.
  
2. A slot is only consumed by a word that turns out to need studying.
  
3. Words with demonstrated struggle (repeat lookups, hard mastery) reach the deck within days, not months.
  
4. Bottom-up foundation filling survives as a minority lane, not the sole order.
  
## Non-goals
- No change to `reader_skip`/`reader_click` grading or the pre-due surfacing window (audit Finding 1; needs its own design).
  
- No change to deck session UX beyond cards appearing mid-session after a refund.
  
- No server-side promotion job; promotion stays client-side in `promoteIntakeQueue`.
  

* * *
## Change 1 — Lane-based promotion order
**Where**: `src/services/intake.ts` (`selectPromotions`, `compareIntakeItem`), `src/services/store.ts` (`promoteIntakeQueue` builds `IntakeItem`s), `supabase/functions/_shared/wordPriority.ts` (`compareIntake` mirror — keep the copies in sync as today).

Replace the single foundation-first sort with three lanes, allocated per day (cap N, default still `new_words_per_day`; recommend raising the default to 5 in `user_preferences` — see Rollout):

| lane | share of cap | eligibility | order |
|---|---|---|---|
| **S — struggle** | ceil(40%) | queued, `timesSeen ≥ 2`, and (`lookupCount ≥ 2` or `mastery === 'hard'`) | `lookupCount` desc → `timesSeen` desc → `freqRank` asc |
| **F — frequency** | ceil(40%) | queued or triaged, `jlptLevel` between user level −1 and 5 (N4 user → N5..N3), `freqRank ≤ 12` | `freqRank` asc → `jlptLevel` desc |
| **Fo — foundation** | remainder (≥1 when cap ≥ 3) | current rules (easiest JLPT first) | current `compareIntakeItem` |

Allocation for cap 5 → S:2, F:2, Fo:1. Cap 3 → S:1, F:1, Fo:1. A lane that can't fill its share spills unused slots to the next lane (S → F → Fo → S); total promoted never exceeds cap.

Notes:

- `IntakeItem` gains `lookupCount: number` and `mastery: MasteryLevel | null` (both read off the existing `WordData` when building `queuedItems`).
  
- Lane S deliberately has **no JLPT ceiling and no JLPT requirement** — need is demonstrated by history, and several top struggle words are JLPT-unrated (支援, 奴隷, 遺伝子). It still requires ≥2 real encounters so a one-off rare word can't jump in.
  
- Lane F's `freqRank ≤ 12` keeps it to genuinely common words (bands are JMDict nf ranks; 12 ≈ top ~6k). The level floor (user level −1) stops N2/N1 abstractions from entering via frequency alone.
  
- De-dup by `entryId` across lanes (first lane wins), same as today's map.
  
### 1a — Lookup counting (new signal)
`WordData` has no lookup counter today (`streak` resets on lookup but the count is lost). Add:

- `WordData.lookupCount?: number` — incremented in `recordWordSeen` when `withoutLookup === false` (the exact branch that currently logs the `lookup` study event and resets streak).
  
- Column `lookup_count integer default 0` on `user_word_progress`; ride the existing `upsertWordProgressToSupabase` field mapping and the rehydrate path (`syncSrsWithSupabase` must carry it — remember the rehydrate-all-fields lesson from #75).
  
- **Migration** `database/26_lookup_count.sql` (applied by hand, per convention): add column + one-time backfill from `study_history`: `update user_word_progress p set lookup_count = h.n from (select word_id, count(*) n from study_history where action = 'lookup' group by word_id) h where p.word_id = h.word_id and p.user_id = <user>` (write it generically with a join on user_id). ~536 lookup events land on ~370 words; cheap.
  
### 1b — Deck eligibility for JLPT-unrated words
**Where**: `src/services/deck.ts` (`isEligible`), and the mirror-gate inside `promoteIntakeQueue` ("Only deck-eligible words … may compete").

Current gate `jlptLevel != null` exists to keep kuromoji fragments/junk out of the deck, but it also blacklists real JMDict words that JLPT never rated — including 3 of the top 5 struggle words. Relax to:

```ts
isEligible(e) := e.jlptLevel != null || (e.freqRank != null && hasJmdictEntry)
```

(`hasJmdictEntry` ≈ `jmdictEntryId != null` on the store side; in `deck.ts` add `jmdictEntryId` — or a boolean — to `DeckEntry`.) Junk fragments have neither a JLPT level nor a freq_rank/entry link, so the original purpose survives. Foundation-lane ordering still requires a JLPT level; unrated words enter only via lanes S/F where frequency or history orders them.
## Change 2 — Triage gate on virtual candidates
**Where**: `src/services/store.ts` (`promoteIntakeQueue`), `Flashcards.tsx` Discover flow (no change — it already exists), `gradeDiscoverWord` (no change).

Today `promoteIntakeQueue` merges the _virtual_ unseen-foundation candidates (`fetchIntakeCandidates`) directly into the promotion pool, so never-triaged, never-encountered dictionary words win slots — half of all slot-consuming promotions to date, and the source of the known-N5-word waste (Discover-Easy already routes known words to SRS for free, but only for words that pass through Discover).

New rule: **virtual candidates cannot win a promotion slot.** The promotion pool is only words with evidence: encountered while reading (`queued` row with `timesSeen ≥ 1`) or Discover-triaged medium/hard (which creates a `queued` row via `gradeDiscoverWord` — already implemented). Delete the `candidateItems` fetch from `promoteIntakeQueue`.

Fallback: if the evidence pool has fewer eligible words than the day's cap (fresh account, or a user who triages nothing), fill remaining Fo-lane slots from virtual candidates as today. This keeps the cold-start path alive.

Discover becomes the _only_ entry point for unseen-foundation words, which is what its UI already communicates. No Discover changes needed; the existing `fetchIntakeCandidates` batch keeps serving it.
## Change 3 — Easy first-grade refund + top-up
**Where**: `src/services/store.ts` (`reviewWord`, `promoteIntakeQueue`), `src/components/Flashcards.tsx` (deck refresh), store persistence (two new daily stamps).

`reviewWord` already computes `isNewCard = promotedTs != null && reps === 0` and grades new cards from a fresh FSRS card. Add, when `isNewCard && rating === 4` (Easy):

1. **Refund**: write the graded word with `promotedTs: null` (instead of keeping the stamp). Everything else about the grade stands — the word stays `active`, keeps its long Easy first interval, logs to `srs_review_log` as today. The existing upsert mapping already syncs `promotedTs: null` → `promoted_at = null`, so the cross-device cap count (which counts today's synced `promotedTs` stamps) self-corrects.
  
2. **Top-up**: call `promoteIntakeQueue(now, { topUp: true })`. The `topUp` flag skips the once-per-day `lastIntakePromotionTs` early-return but keeps every other guard: it recomputes `promotedToday` (now one lower), promotes at most `cap − promotedToday` words through the same lane logic, and re-stamps. The refunded word's meaning/reading are already enriched, so the replacement card appears in the current deck session via the existing `selectDeck` recompute in `Flashcards.tsx` (it reads `wordDatabase` reactively; verify the memo dependency includes the promoted word's arrival).
  
3. **Pull budget**: bound top-ups at `4 × cap` refunds per local day (`refundsToday` counter + `lastRefundDay` stamp in the store, persisted). Refunds past the budget still clear `promotedTs` (the word still exits for free — that's the honest record) but trigger no top-up, so a known-word-dense queue can't turn one session into a marathon. Counter resets on calendar-day change, same `sameLocalDay` convention as the promotion stamp (rolling-window drift lesson from #97).
  

Scope guards:

- Refund applies **only** to the first-ever grade of a new card (`reps === 0`). Easy on any later review refunds nothing.
  
- Refund applies only to rating 4. An Easy _triage_ in Discover already bypasses slots entirely (`gradeDiscoverWord` → `keep-active`, `promotedTs: null`) — unchanged.
  
- Known incentive distortion (grading Good to end the session sooner) is accepted for a single-user beta; the triage gate (Change 2) is the primary filter and should make refunds rare.
  
## Hygiene fixes bundled with this work
1. `intake_status` **NULL on new rows** (236 rows drifted since #68): every client write path that can create a `user_word_progress` row must send `intakeStatus: 'queued'` when the local record has none. Audit callers of `upsertWordProgressToSupabase`; the known offender is the plain seen/lookup sync path which omits the field entirely. One-time repair is the idempotent backfill already in `database/24_intake_queue.sql` — re-run it.
  
2. **Unpersisted flashcard grade** (大西洋: rated Again, `srs_status` still NULL): `reviewWord` writes the local record unconditionally but the upsert can fail silently. Add the same retry/latch used by other sync paths, or at minimum log loudly. Investigate whether the word was surface-keyed (pre-#39 record) so the upsert targeted a row the entry-id-keyed audit didn't find.
  
## Acceptance criteria
- Over the first week after ship (cap 5): ≥ 60% of slot-consuming promotions come from lanes S+F; zero promotions of never-encountered, never-triaged words while the evidence pool is non-empty.
  
- 支援, 権利, 機関 (or whatever the top repeat-lookup queued words are at ship time) are active with near due dates within 3 days.
  
- A new card first-graded Easy: `promoted_at` is NULL server-side afterwards, `srs_review_log` shows the grade, and a replacement new card was promoted the same day (visible as a same-day `promoted_at` stamp on another word).
  
- No day mints more than `new_words_per_day` _retained_ (non-refunded) promotions, cross-device.
  
- `lookup_count` on `user_word_progress` matches `study_history` lookup counts after backfill (spot-check top 20).
  
## Test plan
- Extend `scripts/test-intake.mjs` (pure-logic runner): lane allocation and spill (cap 3/5, empty lanes), struggle eligibility (lookupCount vs hard mastery), de-dup across lanes, virtual-candidate exclusion + cold-start fallback, unrated-word eligibility.
  
- Extend `scripts/test-deck.mjs`: relaxed `isEligible` (unrated + freqRank in; fragments still out), refunded card's replacement appears as `kind: 'new'`.
  
- New cases in `scripts/test-srs.mjs` or a small runner for `reviewWord` refund: first-grade-Easy clears `promotedTs`, later-review Easy does not, budget stops top-up at 4×cap.
  
- Manual pass via the `verify` skill: Discover-triage a word medium → next day it competes; grade a new card Easy → replacement card appears in-session.
  
## Rollout
1. Apply `database/26_lookup_count.sql` by hand (column + backfill), re-run the `24_intake_queue.sql` backfill for the NULL rows. Both idempotent.
  
2. Ship the client changes behind nothing — single-user beta, no flag needed. (If a kill-switch is wanted: `newWordsPerDay = 0` already pauses intake.)
  
3. Recommend bumping `new_words_per_day` 3 → 5 in Settings after ship; with lanes 2/2/1 that is ~14 struggle + ~14 frequency + ~7 foundation words/week versus ~21 mostly-known words/week today.
  
4. Re-run the audit scripts after one week (they live in the session scratchpad; consider committing `scripts/audit-srs-usage.cjs` from them) and check the acceptance criteria, especially the vocabulary growth curve (`known` additions/week) turning back up.
  
## Open questions
1. Should lane F also draw from _virtual_ candidates at the user's exact level (common N4 words never yet encountered)? Current spec says no (evidence only, Discover is the entry point) — but if Discover usage lapses, lane F thins out. Alternative: let lane F use virtual candidates at `freqRank ≤ 6` only.
  
2. `new_words_per_day` semantics change slightly: it now counts _retained_ promotions. Rename in Settings copy ("new words to learn per day")?
  
3. Struggle-lane threshold (`lookupCount ≥ 2`) vs the audit's ≥3 cohort: 2 catches words earlier at the cost of some noise; revisit after a week of data.
