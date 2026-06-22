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
 * In-SRS surfacing order — "most useful word wins" for slicing the article palette.
 *
 * Confirmed-familiar words sort first (#25): they're verified-easy backbone material,
 * strictly better than below-level words the user has never seen, so the KNOWN cap drops
 * the guesses before the verified words. Within the confirmed group, strongest evidence
 * leads — easiest-for-the-user (lowest numeric difficulty) then most-often-seen.
 *
 * Everything else (and the tiebreak among confirmed words) falls back to frequency:
 * common first, then most-frequent (lowest freq_rank, nulls last), then easier
 * (higher jlpt_level) first. Returns a standard Array.sort comparator result.
 *
 * Note: only confirmed-easy words ever land in the KNOWN bucket, so promoting them here
 * reorders the backbone only — the review/new buckets keep their frequency ordering.
 */
export function compareSurfacing(a: WordSignal, b: WordSignal): number {
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

/**
 * Assign a word to the article palette bucket for a reader at `userJlpt`:
 * - confirmed-easy            → known (the backbone the article is built on)
 * - confirmed hard/medium     → review (resurface for reinforcement)
 * - easier than the reader    → known (assumed-known, never explicitly tracked)
 * - at the reader's level, untracked → new (a fresh introduction)
 * - otherwise                 → null (not placed)
 *
 * NOTE (#22/#25): this is the *current* coarse, mastery-bucket logic, lifted verbatim
 * from process-article so behavior is preserved by the extraction. Those follow-ups
 * replace it with the richer metric (numeric difficulty + JLPT proximity + frequency
 * weighting) — they change THIS function, and every consumer inherits the change.
 */
export function classifyBucket(w: WordSignal, userJlpt: number): PaletteBucket {
  if (w.mastery === 'easy') return 'known';
  if (w.mastery === 'hard' || w.mastery === 'medium') return 'review';
  if (w.jlptLevel !== null && w.jlptLevel > userJlpt) return 'known';
  if (w.jlptLevel === userJlpt && !w.mastery) return 'new';
  return null;
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
