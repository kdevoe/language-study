// Word intake queue selection (#68, v2 docs/intake-v2-spec.md) — the pure promotion logic.
//
// Encountering a word no longer grades it on sight. Instead words WAIT in an intake
// queue (unscheduled) until a daily cap promotes a few of them into active FSRS
// scheduling (src/services/srs.ts).
//
// v1 promoted strictly foundation-first (easiest JLPT level, then most common), mixing
// in never-met dictionary words. Once the common N5 words were known, "next N5 word"
// meant the rare tail (字引, 伯父さん), a third of the slots went on words already
// known, and the N4/N3 words actually met in articles waited behind it all. v2 gives
// every candidate ONE score from the signals we have — need (lookups, hard, asked
// for), exposure (times met, how recently), usefulness (frequency) and fit to the
// WORKING LEVEL (the easiest level that isn't mostly solid yet) — and promotes the
// top `cap`. Never-met dictionary candidates compete too, with no need/exposure
// score, so they only win when nothing met in reading is as useful.
//
// This module is intentionally pure (no store/Supabase/clock access) so the ordering
// is unit-testable with a standalone runner, mirroring how srs.ts is tested.

/** A virtual unseen-foundation candidate row from the get_intake_candidates RPC. */
export interface IntakeCandidate {
  entryId: string;
  jlptLevel: number | null;
  freqRank: number | null;
  word: string;
  reading: string;
  meaning: string;
}

/**
 * One word competing for promotion. `key` is the store key of an already-encountered
 * queued record, or null for a virtual unseen-foundation candidate (materialised into
 * a record only if it wins a promotion slot). `candidate` carries the display fields
 * needed to build that record.
 *
 * `jlptLevel` must be the dictionary's OWN level (null when JLPT never rated the
 * word) — not a level guessed from kanji or frequency, which is how fragments such
 * as 見 and 社 used to win slots.
 */
export interface IntakeItem {
  key: string | null;
  entryId: string;
  jlptLevel: number | null;
  freqRank: number | null;
  timesSeen: number;
  /** Times the learner looked the word up (study_history). */
  lookupCount?: number;
  /** ms epoch of the last encounter; 0/undefined = never met. */
  lastSeenTs?: number;
  mastery?: string | null;
  /** Display form, for the junk gate. */
  surface?: string;
  pos?: string[];
  candidate?: IntakeCandidate;
}

/** Per-level progress from the intake_level_progress RPC. */
export interface LevelProgress {
  level: number;
  total: number;
  solid: number;
}

/** A level counts as filled once this share of its words is solid (easy). */
export const WORKING_LEVEL_FILLED = 0.8;
/** JMDict nf frequency bands run 1 (most common) … 48. */
const FREQ_BANDS = 48;

/**
 * The working level: the easiest JLPT level (5 → 1) whose solid share is below
 * WORKING_LEVEL_FILLED. With no progress data, fall back to the user's own level.
 */
export function workingLevel(progress: LevelProgress[], userLevel: number | null): number {
  const byLevel = new Map(progress.map((p) => [p.level, p]));
  if (byLevel.size === 0) return userLevel ?? 5;
  for (let level = 5; level >= 1; level--) {
    const p = byLevel.get(level);
    if (!p || p.total === 0) continue;
    if (p.solid / p.total < WORKING_LEVEL_FILLED) return level;
  }
  return 1;
}

const DIGITS = /[0-9０-９]/;
const KATAKANA = /[ァ-ヶ]/;
const AFFIX_POS = /^(suf|pref|ctr)$|suffix|prefix|counter/i;

/**
 * Words that shouldn't spend a slot: dates and numbers (１２月), affixes and
 * counters (屋, 杯), and unranked katakana compounds (西アフリカ).
 */
export function isJunk(item: IntakeItem): boolean {
  const s = item.surface ?? item.candidate?.word ?? '';
  if (DIGITS.test(s)) return true;
  if ((item.pos ?? []).some((p) => AFFIX_POS.test(p))) return true;
  if (KATAKANA.test(s) && item.freqRank == null) return true;
  return false;
}

/**
 * A word the learner asked for: triaged medium/hard in Discover, or added from a
 * ハルカ offer (both go through gradeDiscoverWord). Never met in reading, unlike the
 * words Policy F requeued with a medium grade.
 */
export function isChosen(i: IntakeItem): boolean {
  return i.key != null && i.timesSeen === 0 && (i.mastery === 'medium' || i.mastery === 'hard');
}

/**
 * Can this word compete at all? It needs a frequency rank — the rare tail with none
 * (字引, 伯父さん) never earns a slot — unless the learner chose it. Junk never does.
 */
export function isEligible(i: IntakeItem): boolean {
  if (isJunk(i)) return false;
  return i.freqRank != null || (isChosen(i) && i.jlptLevel != null);
}

/** How well a word's level fits the working level W (1 = right at W). */
export function levelFit(level: number | null, w: number): number {
  if (level == null) return 0.4;          // JLPT never rated it; frequency speaks for it
  const harder = w - level;               // >0: harder than W (lower number)
  if (harder === 0) return 1;
  if (harder === 1) return 0.7;           // one level up: next in line
  if (harder < 0) return 0.5;             // easier than W: mostly filled already
  if (harder === 2) return 0.3;
  return 0.1;
}

const DAY = 86_400_000;

/**
 * The intake score: higher = promote sooner. Four parts, each a few points:
 *   need       — chosen by the learner (+8: an explicit ask outranks any inferred need),
 *                lookups (0.6 each, up to 3), marked hard (+1.5)
 *   exposure   — times met (log scale, up to 1.5), met in the last week (+1) / month (+0.5)
 *   usefulness — frequency band, most common = 3
 *   level fit  — working level = 3, one up 2.1, easier 1.5, two up 0.9
 */
export function intakeScore(i: IntakeItem, w: number, now: number): number {
  let need = 0;
  if (isChosen(i)) need += 8;
  need += Math.min(i.lookupCount ?? 0, 5) * 0.6;
  if (i.mastery === 'hard') need += 1.5;

  let exposure = Math.min(Math.log2(1 + Math.max(i.timesSeen, 0)), 3) * 0.5;
  const age = i.lastSeenTs ? now - i.lastSeenTs : Infinity;
  if (age <= 7 * DAY) exposure += 1;
  else if (age <= 30 * DAY) exposure += 0.5;

  const usefulness = i.freqRank != null ? ((FREQ_BANDS - Math.min(i.freqRank, FREQ_BANDS)) / (FREQ_BANDS - 1)) * 3 : 0;
  return need + exposure + usefulness + levelFit(i.jlptLevel, w) * 3;
}

export interface PromotionPick extends IntakeItem {
  score: number;
}

/**
 * Choose up to `cap` words to promote this cycle: every eligible word — met in
 * reading, chosen, or a never-met candidate — scored against the others, top `cap`
 * win. De-dupes by entryId (a local record beats a candidate naming the same entry).
 * Ties fall back to the more common word, then the stable entry id. Returns [] for cap<=0.
 */
export function selectPromotions(
  queued: IntakeItem[],
  candidates: IntakeItem[],
  cap: number,
  working: number,
  now: number,
): PromotionPick[] {
  if (cap <= 0) return [];
  const byId = new Map<string, IntakeItem>();
  for (const item of [...queued, ...candidates]) {
    const existing = byId.get(item.entryId);
    if (!existing || (existing.key == null && item.key != null)) byId.set(item.entryId, item);
  }
  return Array.from(byId.values())
    .filter(isEligible)
    .map((i) => ({ ...i, score: intakeScore(i, working, now) }))
    .sort((a, b) =>
      b.score - a.score
      || (a.freqRank ?? Infinity) - (b.freqRank ?? Infinity)
      || (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0))
    .slice(0, cap);
}
