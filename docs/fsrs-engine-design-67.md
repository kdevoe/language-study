# #67 — FSRS Scheduling Engine: Design Doc
**Phase D, Goal 5 foundation.** Add a genuine spaced-repetition layer (`stability` + `due_at` + intervals + a review log) _on top of_ — not replacing — the existing `difficulty` (1–10) signal. This is the prerequisite for the intake queue (#68), the flashcard deck (#70), and feeding real due-dates into article generation (#72, which upgrades #51's staleness heuristic).

> **Status:** ✅ **implemented** (2026-07-11). Decisions locked in review: FSRS + wrapped `ts-fsrs` (D1), extend-table + `srs_review_log` (D2), **read-past always advances the schedule with an early-review-diminished gain** (D3, revised from the original conservative proposal). `requestRetention` = **0.85**; easy words keep long (~40-day) initial intervals; test tooling = standalone `scripts/` runner.
>
> **As-built notes / deviations:**
> - **Module lives at `src/services/srs.ts`, not `supabase/functions/_shared/`.** #67's only consumer is the browser (`store.applyDifficultyEvent`), and `_shared` uses Deno/esm.sh URL imports while the browser bundle uses npm — mixing runtimes for a browser-only feature isn't worth it. The pure seed/mapping is isolated so #72 can share it edge-side (via esm.sh) when it needs it, exactly as `wordPriority.ts`'s header anticipates.
> - **`enable_short_term: false`** → the lifecycle is just `new → review` (no sub-day learning/relearning steps, which don't fit an article-reading cadence). A lapse shows up as collapsed stability + `lapses++` while the card stays `review`; urgency lives in `due_at`, not a status label. `SrsStatus` keeps all four values for a future flashcard mode that might enable short-term steps.
> - Verified: 18/18 `scripts/test-srs.mjs`, `tsc -b`, full `vite build` (ts-fsrs bundles), zero new lint errors.

* * *
## 1. What exists today (grounded baseline)
A read of the current code establishes exactly what we're building on:

- `user_word_progress` (`database/08_srs_schema.sql`) — PK `(user_id, word_id)`. Columns: `mastery_level` (`unseen|hard|medium|easy`), `times_seen`, `streak`, `last_seen_at`, `created_at`. **No scheduling fields.**
  
- `difficulty smallint` **1–10** added in `database/11_difficulty.sql` — _"now the source of truth for SRS"_, `mastery_level` derived from it (1–3 easy / 4–7 medium / 8–10 hard). 1 = easiest **for the user**, 10 = hardest.
  
- `study_history` (`08_srs_schema.sql`) — append-only-ish audit log: `action ∈ (seen|lookup|mastery_change)`, `metadata jsonb`. Written on every grade via `logStudyEventToSupabase` (`api.ts`).
  
- **The nudge state machine** — `applyDifficultyEvent(word, 'skip'|'click', jlpt)` in `store.ts:408`. First contact seeds from `seedDifficulty(jlpt, userLevel) = clamp(6 + (userLevel − jlpt)·2, 1, 10)`; `skip` = seed−1, `click` = raw seed. Repeat: `click` = +2, `skip` = −1. **Daily dedup:** ≤1 passive adjustment/word/day, except a `click` may override an earlier same-day `skip` once. `mastery` re-derived via `bucketForDifficulty`.
  
- **Reader hooks** (`Reader.tsx`) — read-past fires `applyDifficultyEvent(key,'skip')` after 500 ms on-screen (`gradeWordByKey`, ~line 137); lookup fires `applyDifficultyEvent(key,'click')` (`handleWordClick` ~332, `handleDictionaryLookup` ~364/437). Only dictionary-linked words are graded. Canonical `entry_id` keying (#39) means one record per word.
  
- **Sync** (`api.ts`) — `fetchUserWordProgress` (paginated 1000/page) maps `difficulty/times_seen/streak/last_seen_at`; `upsertWordProgressToSupabase` / `…Batch` write the full row (must include `difficulty` or it nulls out). Client `WordData` (`store.ts:114`) is the mirror; **persist version 5**.
  
- `wordPriority.ts` — `compareStuck()` (line ~167) already carries the marker comment: _"interim staleness heuristic; #72 swaps primary key for true_ `due_at` _once FSRS lands (#67)."_ `WordSignal` reads `difficulty/timesSeen/lastSeenAt/jlptLevel/freqRank`. **This is the exact plug point.**
  
- **Scheduling code today: none.** No `due_at`, `interval`, `stability`, `ease` anywhere.
  

The key semantic fact: **the app's** `difficulty` **(1–10, user-perceived) is NOT FSRS's difficulty**. FSRS maintains its own `D` (card inherent difficulty) and `S` (stability, in days). They point the same direction (higher = harder) but are updated by different logic. We keep both; the app's `difficulty` seeds the FSRS state and remains the coarse signal `wordPriority` already reads.

* * *
## 2. Three decisions to lock 🔒
### 🔒 DECISION 1 — FSRS vs SM-2
**Recommend: FSRS (v6-style).** Better retention modeling, open-source default weights, `stability` maps cleanly to "how long until due," and it's the algorithm #72/#73 will report on. SM-2's single ease-factor is coarser and we'd likely migrate to FSRS later anyway.

_Implementation:_ use the maintained `ts-fsrs` library (dependency-light, runs in both Vite/browser **and** Deno edge — important because #72 schedules server-side) wrapped behind **our own** pure `schedule()`, so we own the seed/mapping + soft-bump logic but lean on a maintained implementation for the algorithm's correctness. ✅ approved.
### 🔒 DECISION 2 — New table vs extend `user_word_progress`
**Recommend: extend** `user_word_progress` **with scheduling columns, + one new append-only** `srs_review_log` **table.** Word progress is already exactly 1 row per `(user, word)` and the whole sync path upserts that row — extending keeps fetch/upsert one round-trip and avoids a join on every article generation. The review log is genuinely append-only and high-volume, so it earns its own table (and enables future FSRS weight optimization). `study_history` stays as the coarse UX audit log; `srs_review_log` is the precise scheduler-input log (rating + before/after state). ✅ approved.
### 🔒 DECISION 3 — How aggressively does a Reader read-past advance the schedule? ✅ RESOLVED (revised)
**North star (per review): reading a word in natural context should push its due date out, so the flashcard deck stays as small as possible.** In-context reading is the primary study mode; flashcards are the fallback for words reading alone isn't reinforcing. So a read-past **always** advances the schedule — but the size of the push is governed by FSRS's own math, which makes it self-limiting rather than gameable:

- **read-past (`skip`) → rating "Good" (3), always** (still subject to the existing once-per-word-per-day dedup). Capped at "Good," never "Easy" — passive recognition-in-context isn't free recall.
- **FSRS makes the push proportional to how due the word was.** A successful review yields a large stability gain when retrievability `R` is low (you recalled something you were about to forget → big information gain) and a **small** gain when `R` is high (you just saw it → little gain). So reading a word the day after you saw it barely moves its due date; reading one that's at/near due moves it a lot. This is exactly "some benefit for early reads, big benefit for due reads" — with no special-casing and no way to inflate intervals by re-scrolling (daily dedup + diminishing early-review gain both bound it).
- **lookup (`click`) → rating "Again" (1)** — a lapse (they didn't know it); resets/shortens the interval.
- Explicit flashcard grades (Phase E) always apply, full Again/Hard/Good/Easy.

This keeps read and deck converging on one SRS state (#71): every in-context read legitimately extends the schedule, so words the user keeps meeting while reading naturally graduate out of the due deck. `srs_review_log.source` still distinguishes `reader_*` from `flashcard` for later analysis.

*(Dropped from the original draft: the "not-yet-due read → record exposure only, no reschedule" rule. Reading now always reschedules — the early-review-diminished gain replaces that guard.)*

* * *
## 3. Schema (assumes Decisions 1 & 2 as recommended)
New migration `database/23_fsrs_scheduling.sql`:

```sql
-- 23. FSRS scheduling layer on top of user_word_progress.
-- `difficulty` (1..10, user-perceived) stays the coarse signal + seed.
-- These fields are the real spaced-repetition schedule. NULL = not yet on a schedule
-- (word is queued/unscheduled — the intake gate is #68's job).
alter table public.user_word_progress
  add column if not exists stability        double precision,          -- FSRS S, in days
  add column if not exists fsrs_difficulty   double precision           -- FSRS D, 1..10 (algorithm-managed; distinct from `difficulty`)
    check (fsrs_difficulty is null or (fsrs_difficulty between 1 and 10)),
  add column if not exists due_at            timestamptz,               -- next review; the "what's due" key
  add column if not exists last_reviewed_at  timestamptz,               -- last scheduler event (≠ last_seen_at, which is any exposure)
  add column if not exists interval_days     double precision,          -- convenience mirror of the scheduled gap (derivable from S)
  add column if not exists reps              integer default 0,         -- successful reviews
  add column if not exists lapses            integer default 0,         -- Again-after-review count
  add column if not exists srs_status        text                       -- FSRS card lifecycle
    check (srs_status is null or srs_status in ('new','learning','review','relearning'));

-- "What's due today" — the query the deck (#70) and #72 hang off.
create index if not exists idx_uwp_due on public.user_word_progress(user_id, due_at)
  where due_at is not null;

-- Precise, append-only scheduler-input log (distinct from the coarse study_history UX log).
create table if not exists public.srs_review_log (
  id                 uuid default gen_random_uuid() primary key,
  user_id            uuid references auth.users not null,
  word_id            text not null,
  rating             smallint not null check (rating between 1 and 4), -- 1=Again 2=Hard 3=Good 4=Easy
  source             text not null check (source in ('reader_skip','reader_click','flashcard')),
  stability_before   double precision,
  stability_after    double precision,
  difficulty_before  double precision,
  difficulty_after   double precision,
  scheduled_days     double precision,   -- interval assigned by this review
  elapsed_days       double precision,   -- actual gap since last_reviewed_at
  reviewed_at        timestamptz default now() not null
);
alter table public.srs_review_log enable row level security;
create policy "Users can manage own srs review log"
  on public.srs_review_log for all using (auth.uid() = user_id);
create index if not exists idx_srs_review_log_user_word on public.srs_review_log(user_id, word_id);
```

> DB migrations are applied by hand in Supabase (per project convention) — this file is authored, not auto-run.

* * *
## 4. The pure scheduler — `schedule()`
Module `src/services/srs.ts` (as-built; the design originally proposed `_shared/` — see status note above for why it landed browser-side). Wraps `ts-fsrs` behind a pure, app-shaped surface:

```ts
export type Rating = 1 | 2 | 3 | 4; // Again | Hard | Good | Easy
export type SrsStatus = 'new' | 'learning' | 'review' | 'relearning';

export interface SrsState {
  stability: number | null;        // S, days (null = never scheduled)
  fsrsDifficulty: number | null;   // D, 1..10
  dueAt: number | null;            // ms epoch
  lastReviewedAt: number | null;   // ms epoch
  reps: number;
  lapses: number;
  status: SrsStatus;
}

export interface Scheduled extends SrsState {
  intervalDays: number;            // gap assigned this review
}

// Pure: no clock reads inside — `now` is injected (keeps it testable + resume-safe).
export function schedule(
  state: SrsState | null,
  rating: Rating,
  now: number,
  params?: FsrsParams,          // default weights + requestRetention (0.85)
): Scheduled;
```

**Behavior:**

- `state == null` (first-ever review) → FSRS "new-card" init: `S0`/`D0` from the default weights for the given `rating`. But most existing words won't hit this path — they arrive pre-seeded by the backfill (§5).
  
- Otherwise compute elapsed days = `(now − lastReviewedAt)/86.4e6`, retrievability `R`, then FSRS-6 update of `S` and `D`; `Again` increments `lapses` and sets `status='relearning'`.
  
- Next `intervalDays = I(S, requestRetention)`; `dueAt = now + intervalDays·day`.
  
- **Pure** (no `Date.now()` inside) so it's unit-testable with fixed clocks and safe under Claude Code's resume constraints.
  

The FSRS-6 equations (retrievability `R = (1 + F·t/S)^C`, interval `I = S/F·(rr^{1/C} − 1)`, stability-on-success/failure, difficulty update) come from `ts-fsrs`'s default parameter set — we don't re-derive weights in-house; we own only the wrapper, the seed mapping, and the soft-bump rating translation.

**Reader soft-bump adapter** (encodes Decision 3), also in `srs.ts`:

```ts
// Translate a Reader event into an FSRS rating. Read-past ALWAYS reschedules (D3);
// FSRS's elapsed-time math makes an early read a small push and a due read a big one.
export function ratingForReaderEvent(event: 'skip' | 'click'): Rating {
  return event === 'click' ? 1 : 3;   // lookup = Again (lapse); read-past = Good (never Easy)
}
```

The self-limiting behavior lives entirely in `schedule()` (via the `elapsed_days → R → stability` update), not in a due-gate here — so the adapter is a trivial mapping and the "don't over-credit re-scrolls" guarantee comes from FSRS + the caller's daily dedup, exactly as D3 argues.

* * *
## 5. Backfill / migration of existing rows
We can't replay history, so we synthesize a plausible FSRS state from the two signals we have: `difficulty` **(1–10) and** `last_seen_at`**.** Goal: _mature/easy words get long initial intervals (due later); hard words come due soon._

Proposed seed (constants to calibrate at build time against real row distribution):

```
fsrs_difficulty_0 = difficulty                    -- same 1..10 scale, same direction — clean carry-over
stability_0(d)    = S_MAX * ((10 - d) / 9)^k + S_MIN   -- d=1 (easy) → ~S_MAX; d=10 (hard) → ~S_MIN
                    -- e.g. S_MIN≈0.5d, S_MAX≈21d, k≈1.5 (tunable)
due_at            = last_seen_at + I(stability_0)  -- already-overdue hard words → due immediately (correct)
srs_status        = 'review'    (difficulty ≤ 7)  |  'relearning' (difficulty 8–10)
reps = 0, lapses = 0                               -- unknown history; start counters fresh
```

- Rows with `difficulty IS NULL` (unseen) stay **unscheduled** (`due_at` null) — they belong in #68's intake queue, not on a review schedule.
  
- Runs as SQL in the same migration file (a bulk `update`), mirroring how `11_difficulty.sql` backfilled. **Note (memory): bulk backfill under autovacuum's 20% trigger can bloat** — for a large table, batch the update.
  
- `created_at`/`last_seen_at` preserved; nothing destructive.
  

* * *
## 6. Client + sync wiring
- `WordData` (`store.ts:114`) gains: `stability?`, `fsrsDifficulty?`, `dueAt?` (ms), `lastReviewedTs?`, `reps?`, `lapses?`, `srsStatus?`. **Persist bump v5 → v6** with a no-op-safe migration (existing words simply have `undefined` schedule until first backfill/sync brings it down).
  
- `applyDifficultyEvent` stays (it still maintains the coarse `difficulty` the palette reads) but gains a scheduling arm: after the nudge, map the event via `ratingForReaderEvent(...)`, run `schedule(prevState, rating, now)`, merge the new fields into the record, and write an `srs_review_log` row. The existing daily-dedup guard still gates passive reads to one/day (so re-scrolls don't stack). This _subsumes_ the ±1/+2 as the coarse companion to the real schedule, exactly as the plan intends.
  
- `api.ts` — `upsertWordProgressToSupabase` / `…Batch` payloads extend to the new columns; `fetchUserWordProgress` maps them back (incl. `due_at → dueAt` ms). New `logSrsReviewToSupabase(...)`. Pagination unchanged.
  
- `wordPriority.ts` — add `dueAt`/`stability` to `WordSignal` and a `compareByDue` that ranks genuinely-due words first, `stability` ascending as tiebreak. **We do NOT rewire** `compareStuck`**'s callers in this PR** — that's #72's job; #67 only _provides_ the due-date and the comparator so #72 is a small swap. (Keeps #67 scoped to the engine.)
  

* * *
## 7. Acceptance criteria (from the plan) + how we verify
| Criterion | Verification |
|---|---|
| Every *active* word has a `due_at` | Post-backfill query: `count(*) where difficulty is not null and due_at is null` = 0 |
| Reviewing/reading an active word reschedules it | Unit: `schedule()` with fixed clocks; integration: read-past a due word → `due_at` advances, `srs_review_log` row written |
| A "due today" query returns the right set | `idx_uwp_due` range query returns expected fixtures |
| Existing `difficulty` preserved as the seed | Migration keeps `difficulty`; `fsrs_difficulty_0 = difficulty`; no column dropped |
| Read-past ≠ flashcard double-count (#71 preview) | Existing daily-dedup gates read-past to 1/day; log `source` distinguishes `reader_*` vs `flashcard` |
| Early read pushes due-date less than a due read (D3) | Unit: same `schedule(Good)` from higher `R` (small elapsed) yields smaller stability gain than from lower `R` |

**Tests:** `schedule()` is pure → straightforward unit tests with injected `now` (Again/Hard/Good/Easy paths, lapse counting, first-review init, monotonic interval growth on repeated Good, early-vs-due-read gain). Per the review, test tooling is my call: a small **standalone `scripts/` runner (Node/`tsx`)** in the spirit of the eval harness — no new framework dependency, matches how this repo already does throwaway-free verification.

* * *
## 8. Out of scope for #67 (explicit handoffs)
- **Intake queue /** `queued`**→**`active` **gate + daily new-word cap** → **#68**. #67 backfills all currently-graded words as active; the queue is a separate PR.
  
- **Flashcard UI + real Again/Hard/Good/Easy buttons** → **#70**. #67 exposes `schedule()`; the deck consumes it.
  
- **Feeding due words into article generation** (rewiring `compareStuck` callers) → **#72**. #67 ships `dueAt` + `compareByDue`; #72 flips the switch.
  
- **Study dashboard** (due/new/learning counts) → **#73**.
  

* * *
## 9. Proposed build order (once decisions confirmed)
1. `srs.ts` — `schedule()` + `ratingForReaderEvent()` + weights, with the standalone test runner (pure, no app deps — lowest risk first).
  
2. `database/23_fsrs_scheduling.sql` — columns + `srs_review_log` + index + backfill.
  
3. `api.ts` — extend upsert/fetch payloads + `logSrsReviewToSupabase`.
  
4. `store.ts` — `WordData` fields, persist v6, scheduling arm in `applyDifficultyEvent`.
  
5. `wordPriority.ts` — `dueAt`/`stability` on `WordSignal` + `compareByDue` (provide only; #72 wires).
  
6. Browser-test the read→reschedule loop end to end.
  

* * *
## 10. Decisions — RESOLVED (2026-07-11 review)
1. **D1** FSRS, wrapping `ts-fsrs` behind our own `schedule()` ✅ · **D2** extend `user_word_progress` + new `srs_review_log` ✅ · **D3** read-past always advances the schedule, capped at "Good," push self-limited by FSRS early-review math ✅ (revised from the conservative draft).
2. **`requestRetention` = 0.85** (gentler than the 0.9 standard — passive reading is a big share of reviews).
3. **Backfill:** easy words keep long (~3-week) initial intervals (`S_MAX ≈ 21d`).
4. **Test tooling:** standalone `scripts/` runner (Node/`tsx`), no new framework.
