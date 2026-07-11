// Word Priority Metric — the single shared scorer for "which word matters" (#69).
//
// Three signals decide a word's priority: SRS state, JLPT level, and natural
// frequency. They combine into TWO distinct orderings for two moments in a word's
// life. This module is the one place that logic lives, so the LLM article palette
// (process-article), the intake-promotion job (#68), and the flashcard deck (#70/#72)
// never drift into separate copies.
//
//   1. Intake (pre-SRS)   — which queued words enter active study, and in what order.
//                            Foundation-first: easiest JLPT level first, then most
//                            common first. NO SRS signal yet (the word isn't scheduled).
//   2. In-SRS surfacing   — which active words to weave into the next article / order
//                            the deck. Layers the SRS signal (mastery today; due-ness
//                            once #67 lands) on top of level-fit + frequency.
//
// JLPT numbering convention (matches jmdict_entries.jlpt_level): 5 = N5 (easiest) …
// 1 = N1 (hardest); null = untagged/rare. "Easier" therefore means a HIGHER number.
//
// This file is intentionally dependency-free and DOM/Deno-agnostic so it stays
// portable. (When the frontend deck in Phase E needs it, decide then whether to share
// this source across the Vite/Deno module boundary or call an edge function — see #70.)

/** Per-user mastery bucket from `user_word_progress.mastery_level`. */
export type Mastery = 'easy' | 'medium' | 'hard' | null | undefined;

/** Palette bucket a word is assigned to for article generation. `null` = not placed. */
export type PaletteBucket = 'known' | 'review' | 'new' | null;

/**
 * The signals the metric reads about one word. Callers map their own row shape
 * (e.g. a `jmdict_vocab_candidates` row + a `user_word_progress` lookup) onto this,
 * so the metric stays decoupled from any specific query.
 */
export interface WordSignal {
  /** Canonical JMDict entry id. */
  entryId: string;
  /** 5 = N5 (easiest) … 1 = N1 (hardest); null = untagged/rare. */
  jlptLevel: number | null;
  /** 1 = most common; null = rare/unranked. */
  freqRank: number | null;
  /** JMDict "common" flag — a coarser commonness signal than freq_rank. */
  isCommon: boolean;
  /** Per-user SRS mastery; undefined/null = never tracked. */
  mastery?: Mastery;
  /**
   * Per-user numeric difficulty (1 = easiest for this user … 10 = hardest); the SRS
   * source of truth that `mastery` is derived from. null/undefined = never tracked.
   */
  difficulty?: number | null;
  /** How many times this user has encountered the word. null/undefined = never tracked. */
  timesSeen?: number | null;
  /**
   * ISO-8601 timestamp of the user's last encounter (`user_word_progress.last_seen_at`).
   * null/undefined = never tracked. Used for staleness ordering (#51).
   */
  lastSeenAt?: string | null;
  /**
   * ISO-8601 next-review time (`user_word_progress.due_at`) from the FSRS engine (#67).
   * null/undefined = not yet scheduled. Kept as a string so it compares chronologically
   * without date parsing (module stays Date-free). Consumed by #72.
   */
  dueAt?: string | null;
  /** FSRS stability in days; lower = more fragile memory. null = unscheduled. (#67) */
  stability?: number | null;
}

/**
 * Confirmed-familiar = the user has actually interacted with the word and it graded out
 * easy (real evidence), as opposed to "assumed-from-level" words inferred easy purely
 * from JLPT level with no interaction history. Only these ever feed the KNOWN backbone
 * as verified vocabulary (#25).
 */
export function isConfirmedFamiliar(w: WordSignal): boolean {
  return w.mastery === 'easy';
}

const FREQ_RANK_RARE = Number.POSITIVE_INFINITY; // null freq_rank sorts last (rarest)

/**
 * KNOWN-backbone order — "safest, most useful word wins" for slicing the backbone.
 *
 * Confirmed-familiar words sort first (#25): they're verified-easy backbone material,
 * strictly better than below-level words the user has never seen, so the KNOWN cap drops
 * the guesses before the verified words. Within the confirmed group, strongest evidence
 * leads — easiest-for-the-user (lowest numeric difficulty) then most-often-seen.
 *
 * Everything else (and the tiebreak among confirmed words) falls back to frequency:
 * common first, then most-frequent (lowest freq_rank, nulls last), then easier
 * (higher jlpt_level) first. Returns a standard Array.sort comparator result. Also used
 * as the frequency tiebreaker inside compareByProximity (its confirmed-familiar branch is
 * inert for the review/new buckets, which hold no verified-easy words).
 */
export function compareKnown(a: WordSignal, b: WordSignal): number {
  const ca = isConfirmedFamiliar(a);
  const cb = isConfirmedFamiliar(b);
  if (ca !== cb) return ca ? -1 : 1;
  if (ca && cb) {
    const da = a.difficulty ?? FREQ_RANK_RARE; // missing difficulty = least-confirmed, last
    const db = b.difficulty ?? FREQ_RANK_RARE;
    if (da !== db) return da - db; // easier for the user first
    const ta = a.timesSeen ?? 0;
    const tb = b.timesSeen ?? 0;
    if (ta !== tb) return tb - ta; // more interaction evidence first
  }
  if (a.isCommon !== b.isCommon) return a.isCommon ? -1 : 1;
  const fa = a.freqRank ?? FREQ_RANK_RARE;
  const fb = b.freqRank ?? FREQ_RANK_RARE;
  if (fa !== fb) return fa - fb;
  return (b.jlptLevel ?? 0) - (a.jlptLevel ?? 0); // easier (higher number) first
}

const STRETCH_PENALTY = 100; // above-level "stretch" words rank after every in-reach word

/**
 * JLPT-proximity rank for an UNKNOWN / not-yet-mastered word, relative to a reader at
 * `userJlpt` (#22). Lower = higher priority. A word at the reader's level ranks highest;
 * easier in-reach words follow; words harder than the reader ("stretch") rank after all
 * in-reach words, closest-harder first with priority decreasing as they get harder.
 * Untagged level (null) sorts last. Numbering: 5 = N5 easiest … 1 = N1 hardest.
 *
 * Examples (reader N4 → userJlpt 4): at-level N4 → 0; easier N5 → 1; stretch N3 → 101;
 * harder stretch N2 → 102 — so an unknown N3 outranks an unknown N2.
 */
export function proximityRank(w: WordSignal, userJlpt: number): number {
  if (w.jlptLevel === null) return Number.POSITIVE_INFINITY;
  const easierBy = w.jlptLevel - userJlpt; // >= 0 at the reader's level or easier
  if (easierBy >= 0) return easierBy; // in-reach: at-level (0) first, then easier
  return STRETCH_PENALTY + (userJlpt - w.jlptLevel); // harder: after in-reach, closest first
}

/**
 * In-SRS surfacing order for the REVIEW and NEW buckets: rank unknown words by JLPT
 * proximity to the reader (#22), then fall back to frequency. Returns a comparator bound
 * to `userJlpt` for Array.sort.
 */
export function compareByProximity(userJlpt: number): (a: WordSignal, b: WordSignal) => number {
  return (a, b) => {
    const pa = proximityRank(a, userJlpt);
    const pb = proximityRank(b, userJlpt);
    if (pa !== pb) return pa - pb;
    return compareKnown(a, b); // frequency tiebreaker
  };
}

/**
 * Assign a word to the article palette bucket for a reader at `userJlpt`:
 * - confirmed-easy             → known (the backbone the article is built on)
 * - confirmed hard/medium      → review (resurface for reinforcement)
 * - easier than the reader     → known (assumed-known, never explicitly tracked)
 * - at the reader's level OR a stretch harder, untracked → new (#22: stretch words used
 *                                 to be dropped; they're now surfaced, ranked by
 *                                 proximityRank so the closest-harder lead)
 * - untagged level (null)      → null (rare/untagged — not suggested to learners)
 *
 * The *ordering* within each bucket comes from compareKnown (KNOWN) and compareByProximity
 * (REVIEW/NEW); this function only decides placement. How far above-level a stretch word
 * may reach is bounded upstream by the jmdict_vocab_candidates query (user_jlpt - 2).
 */
export function classifyBucket(w: WordSignal, userJlpt: number): PaletteBucket {
  if (w.mastery === 'easy') return 'known';
  if (w.mastery === 'hard' || w.mastery === 'medium') return 'review';
  if (w.jlptLevel === null) return null; // untagged/rare — don't suggest
  if (w.jlptLevel > userJlpt) return 'known'; // easier than the reader → assumed-known
  return 'new'; // at the reader's level or a stretch harder, never tracked
}

/**
 * "Most-stuck" order for the topic-independent review floor (#51): surface the review
 * words the user is most neglecting, regardless of the article's topic. Stalest first
 * (oldest `last_seen_at`; never-seen sorts first), then hardest (highest difficulty),
 * then least-seen. ISO-8601 timestamps compare chronologically as plain strings, so no
 * date parsing is needed (keeps the module Date-free and portable).
 *
 * This is the interim staleness heuristic; #72 swaps the primary key for true `due_at`
 * once the FSRS engine (#67) lands — callers keep using this comparator either way.
 */
export function compareStuck(a: WordSignal, b: WordSignal): number {
  const la = a.lastSeenAt ?? ''; // never-seen / unknown = stalest, sorts first
  const lb = b.lastSeenAt ?? '';
  if (la !== lb) return la < lb ? -1 : 1; // older timestamp first
  const da = a.difficulty ?? 0;
  const db = b.difficulty ?? 0;
  if (da !== db) return db - da; // hardest first
  return (a.timesSeen ?? 0) - (b.timesSeen ?? 0); // least-seen first
}

/**
 * Due-date order for the in-SRS review floor, backed by the real FSRS schedule (#67).
 * Genuinely-due words first (soonest `due_at` ahead of later ones); never-scheduled
 * words (null due_at) sort last. Ties break by lower stability (more fragile memory
 * first), then fall back to the staleness heuristic. dueAt is an ISO-8601 string so it
 * compares chronologically without date parsing (module stays Date-free).
 *
 * #67 provides this comparator; #72 is where compareStuck's callers switch over to it,
 * so the topic-independent review slot pulls genuinely-due words instead of merely stale
 * ones. Not yet wired to a caller.
 */
export function compareByDue(a: WordSignal, b: WordSignal): number {
  const da = a.dueAt ?? '￿'; // unscheduled sorts last (all ISO chars < ￿)
  const db = b.dueAt ?? '￿';
  if (da !== db) return da < db ? -1 : 1; // sooner due first
  const sa = a.stability ?? Number.POSITIVE_INFINITY;
  const sb = b.stability ?? Number.POSITIVE_INFINITY;
  if (sa !== sb) return sa - sb; // more fragile (lower stability) first
  return compareStuck(a, b);
}

/**
 * Intake (pre-SRS) foundation-first order: easiest JLPT level first (higher number),
 * then most common first. Words with an unknown level sort last (treated as hardest/
 * rarest). No SRS signal — queued words aren't scheduled yet. Ready for #68's
 * daily-promotion job; not yet wired to a caller.
 */
export function compareIntake(a: WordSignal, b: WordSignal): number {
  const la = a.jlptLevel ?? Number.NEGATIVE_INFINITY; // unknown level = hardest, last
  const lb = b.jlptLevel ?? Number.NEGATIVE_INFINITY;
  if (la !== lb) return lb - la; // easier (higher number) first
  const fa = a.freqRank ?? FREQ_RANK_RARE;
  const fb = b.freqRank ?? FREQ_RANK_RARE;
  return fa - fb; // most common (lowest rank) first
}
