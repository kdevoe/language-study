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

/** Why a word's schedule last moved: a passive read-past (`skip`), an in-context
 * lookup (`click`), an explicit modal set (`manual`), or a flashcard grade
 * (`flashcard`). Ordered weakest→strongest as a study signal. */
export type AdjustReason = 'skip' | 'click' | 'manual' | 'flashcard';

/**
 * Shared daily-dedup gate for the read⇄flashcard loop (#71). The reader and the
 * flashcard deck advance the *same* FSRS schedule, so a word must not be counted
 * twice in one day just because it was both read and reviewed. This is the one
 * rule both paths consult, given the word's last same-day adjustment:
 *
 *   • At most one *passive* read advances the schedule per day — re-scrolling the
 *     same article, or seeing a word across several articles, doesn't stack.
 *   • A lookup (`click`) may override an earlier same-day read-past (`skip`) once:
 *     a lookup is harder evidence the word isn't known than a silent read-past.
 *   • A passive read NEVER stacks on top of a same-day *deliberate* review — a
 *     flashcard grade (`flashcard`) or an explicit modal set (`manual`), nor on a
 *     prior lookup. Reading a word you already studied today is not a new review.
 *
 * Deliberate reviews (flashcard/manual) are not throttled here: the deck only ever
 * surfaces a word once per day, so a graded review can't stack on itself, and a
 * lookup after a grade is caught by the same-day guard below. Returns whether a
 * reader `event` should advance the schedule today.
 */
export function readerEventMayAdvance(
  event: 'skip' | 'click',
  lastAdjustedDay: string | undefined,
  lastAdjustReason: AdjustReason | undefined,
  today: string,
): boolean {
  if (lastAdjustedDay !== today) return true;
  return event === 'click' && lastAdjustReason === 'skip';
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

// ── Re-seeding the back-catalog forward (study-pacing flood fix) ──────────────
// The original seed anchored `dueAt` at `last_seen_at` — for a back-catalog seeded
// all at once, every interval had already elapsed, so the whole history came due
// simultaneously (see docs/study-pacing-flood-fix.md). The forward re-seed fixes
// two things: it anchors at `now` (nothing is retroactively overdue), and it boosts
// stability by real EXPOSURE history — a word met across many distinct days is far
// more established than a once-seen word at the same `difficulty`, so it earns a
// long interval and rarely resurfaces instead of joining a daily flood.

/** Multiplier applied to the ±spread window, so an identical-stability cohort doesn't all land on one day. */
const RESEED_SPREAD = 0.15;      // ±15%
/** How much each distinct spaced exposure grows stability (conservative default; see audit). */
const RESEED_BOOST_K = 0.2;
/** Never re-seed a word due sooner than this — seed-on-sight `difficulty` is unreliable. */
const RESEED_MIN_INTERVAL_D = 3;

export interface ReseedOptions {
  boostK?: number;          // exposure→stability growth (default RESEED_BOOST_K)
  minIntervalDays?: number; // floor on the seeded interval (default RESEED_MIN_INTERVAL_D)
  spreadFraction?: number;  // 0..1 deterministic jitter (e.g. hash of the word key); 0.5 = no shift
}

/**
 * Estimated stability (days) for a re-seeded word: the difficulty seed grown by how
 * many distinct times it was seen. `distinctExposures` is the count of separate
 * study/read days (WordData.uniqueDaysSeen.length), the real spacing signal.
 */
export function estimateStability(difficulty: number, distinctExposures: number, boostK = RESEED_BOOST_K): number {
  const base = seedStability(difficulty);
  const extra = Math.max(0, (distinctExposures ?? 0) - 1);
  return base * (1 + boostK * extra);
}

/**
 * Build a forward-anchored `SrsState` from a word's `difficulty` + exposure history.
 * `dueAt = now + interval(S_est)`, floored and jittered so a large cohort spreads
 * across days instead of piling onto one. Deterministic: pass `spreadFraction` (a
 * stable per-word value) rather than reading a clock or RNG. Enters as `review`,
 * `reps: 0` (never actually graded) — mirroring seedSrsFromDifficulty's lifecycle.
 */
export function seedForwardFromHistory(
  difficulty: number,
  distinctExposures: number,
  now: number,
  opts: ReseedOptions = {},
): SrsState {
  const boostK = opts.boostK ?? RESEED_BOOST_K;
  const minInterval = opts.minIntervalDays ?? RESEED_MIN_INTERVAL_D;
  const stability = estimateStability(difficulty, distinctExposures, boostK);
  const fsrsDifficulty = clamp(difficulty, 1, 10);
  const base = Math.max(minInterval, scheduler.next_interval(stability, 0));
  // spreadFraction 0.5 → no shift; 0 → −RESEED_SPREAD; 1 → +RESEED_SPREAD.
  const jitter = opts.spreadFraction == null ? 1 : 1 + RESEED_SPREAD * (2 * clamp(opts.spreadFraction, 0, 1) - 1);
  const intervalDays = Math.max(minInterval, base * jitter);
  return {
    stability,
    fsrsDifficulty,
    dueAt: now + intervalDays * DAY_MS,
    lastReviewedAt: now,
    reps: 0,
    lapses: 0,
    status: 'review',
  };
}
