// FSRS spaced-repetition scheduler (#67) — the real due-date engine that sits on
// top of the coarse `difficulty` (1..10) signal, not replacing it.
//
// This is the one place scheduling math lives, wrapping the maintained `ts-fsrs`
// (FSRS-6) library behind a small, pure, app-shaped surface:
//
//   schedule(state, rating, now)      — advance a word's schedule by one review
//   ratingForReaderEvent(event)       — map a Reader skip/click to an FSRS rating
//   seedSrsFromDifficulty(diff, seen) — first-time seed from the existing difficulty
//
// Design decisions (see docs/fsrs-engine-design-67.md):
//   • request_retention = 0.85 (gentler than the 0.9 default — reading is a big
//     share of "reviews", so we accept slightly lower recall for a smaller deck).
//   • Reading in natural context ALWAYS advances the schedule (read-past = "Good").
//     FSRS's own elapsed-time math makes the push self-limiting: reviewing a word
//     while retrievability is still high yields a small stability gain, so an early
//     read nudges the due date a little and a due read pushes it a lot — with no
//     special-casing and no way to inflate intervals by re-scrolling.
//   • Deterministic: enable_fuzz=false and `now` is always injected, so the same
//     inputs always produce the same schedule (unit-testable, resume-safe).
//
// `fsrsDifficulty` (the FSRS "D", 1..10, algorithm-managed) is DISTINCT from the
// app's `difficulty` (1..10, user-perceived, nudged ±1/±2). They point the same
// direction but update by different logic; the app's difficulty only *seeds* D here.

import {
  fsrs,
  generatorParameters,
  createEmptyCard,
  State,
  type Card,
  type FSRS,
  type Grade,
} from 'ts-fsrs';

/** Target probability of recall at review time. Lower = longer intervals, smaller deck. */
export const REQUEST_RETENTION = 0.85;

/** 1=Again, 2=Hard, 3=Good, 4=Easy — aligned 1:1 with FSRS's grade values. */
export type Rating = 1 | 2 | 3 | 4;

/** FSRS card lifecycle, mirrored to `user_word_progress.srs_status`. */
export type SrsStatus = 'new' | 'learning' | 'review' | 'relearning';

/**
 * The persisted schedule for one word. Mirrors the scheduling columns added to
 * `user_word_progress` in database/23_fsrs_scheduling.sql. Timestamps are ms epochs
 * (the store already keeps `lastSeenTs` in ms) so nothing here reads a clock.
 */
export interface SrsState {
  stability: number;        // FSRS S, in days
  fsrsDifficulty: number;   // FSRS D, 1..10 (algorithm-managed)
  dueAt: number;            // ms epoch — next review
  lastReviewedAt: number;   // ms epoch — last scheduler event
  reps: number;             // successful reviews
  lapses: number;           // Again-after-review count
  status: SrsStatus;
}

export interface Scheduled extends SrsState {
  intervalDays: number;     // gap assigned by this review (days)
}

const DAY_MS = 86_400_000;

// One shared scheduler instance. enable_short_term=false: a word graduates straight
// to review scheduling rather than sub-day learning steps (we don't cram same-day).
const scheduler: FSRS = fsrs(
  generatorParameters({
    request_retention: REQUEST_RETENTION,
    enable_fuzz: false,
    enable_short_term: false,
  }),
);

const STATUS_TO_STATE: Record<SrsStatus, State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
};
const STATE_TO_STATUS: readonly SrsStatus[] = ['new', 'learning', 'review', 'relearning'];

function toCard(s: SrsState): Card {
  return {
    due: new Date(s.dueAt),
    stability: s.stability,
    difficulty: s.fsrsDifficulty,
    elapsed_days: 0,       // recomputed by the scheduler from last_review vs. now
    scheduled_days: 0,
    reps: s.reps,
    lapses: s.lapses,
    learning_steps: 0,
    state: STATUS_TO_STATE[s.status],
    last_review: new Date(s.lastReviewedAt),
  };
}

function fromCard(card: Card, now: number): Scheduled {
  return {
    stability: card.stability,
    fsrsDifficulty: card.difficulty,
    dueAt: card.due.getTime(),
    lastReviewedAt: now,
    reps: card.reps,
    lapses: card.lapses,
    status: STATE_TO_STATUS[card.state],
    intervalDays: card.scheduled_days,
  };
}

/**
 * Advance a word's schedule by one review. `state === null` means the word has
 * never been scheduled (first-ever review, initialised from FSRS defaults). `now`
 * is a ms epoch and is the only "clock" — the function itself is pure.
 */
export function schedule(state: SrsState | null, rating: Rating, now: number): Scheduled {
  const card = state ? toCard(state) : createEmptyCard(new Date(now));
  const { card: next } = scheduler.next(card, new Date(now), rating as unknown as Grade);
  return fromCard(next, now);
}

/**
 * Map a Reader event to an FSRS rating. Reading past a word (`skip`) is a successful
 * in-context recall → "Good" (never "Easy" — passive recognition isn't free recall);
 * looking it up (`click`) means they didn't know it → "Again" (a lapse). Read-past
 * always reschedules; the self-limiting behaviour lives in `schedule()`, not here.
 */
export function ratingForReaderEvent(event: 'skip' | 'click'): Rating {
  return event === 'click' ? 1 : 3;
}

// ── Seeding an existing word into the schedule ───────────────────────────────
// A word already tracked by `difficulty` but not yet scheduled gets a synthesised
// FSRS state so its first read/lookup advances a plausible schedule instead of
// starting from scratch. Easy words (low difficulty) seed with high stability →
// long initial interval; hard words seed short → due soon. These constants mirror
// the one-time SQL backfill in database/23_fsrs_scheduling.sql; TS is canonical.

const SEED_S_MIN = 0.5;   // days — hardest word (difficulty 10)
const SEED_S_MAX = 21;    // days — easiest word (difficulty 1); ~40d first interval at 0.85
const SEED_K = 1.5;       // curve shape: how fast stability falls as difficulty rises

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Initial stability (days) for a given app difficulty (1=easy … 10=hard). */
export function seedStability(difficulty: number): number {
  const d = clamp(difficulty, 1, 10);
  return SEED_S_MAX * Math.pow((10 - d) / 9, SEED_K) + SEED_S_MIN;
}

/**
 * Build an initial `SrsState` from a word's coarse `difficulty` and when it was last
 * seen, so an already-known word joins the schedule mid-stream rather than as brand
 * new. The due date is `lastSeenAt + interval(S0)` — an already-overdue hard word
 * comes due immediately, which is correct. Seeded words enter as `review`: with
 * short-term steps disabled the engine's lifecycle is just `new → review` (a hard
 * word's urgency is carried by its short stability / near due date, not a status
 * label), so there's no meaningful `learning`/`relearning` seed to assign.
 */
export function seedSrsFromDifficulty(difficulty: number, lastSeenAt: number): SrsState {
  const stability = seedStability(difficulty);
  const fsrsDifficulty = clamp(difficulty, 1, 10);
  const intervalDays = scheduler.next_interval(stability, 0);
  return {
    stability,
    fsrsDifficulty,
    dueAt: lastSeenAt + intervalDays * DAY_MS,
    lastReviewedAt: lastSeenAt,
    reps: 0,
    lapses: 0,
    status: 'review',
  };
}
