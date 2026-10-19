// Word intake queue selection (#68, v2 docs/intake-v2-spec.md) — the pure promotion logic.
//
// Encountering a word no longer grades it on sight. Instead words WAIT in an intake
// queue (unscheduled) until a daily cap promotes a few of them into active FSRS
// scheduling (src/services/srs.ts).
//
// v1 promoted strictly foundation-first (easiest JLPT level, then most common), mixing
// in never-met dictionary words. Once the common N5 words were known, "next N5 word"
// meant the rare tail (字引, 伯父さん), a third of the slots went on words already
// known, and the N4/N3 words actually met in articles waited behind it all. v2 splits
// the day's cap into three lanes around a WORKING LEVEL (the easiest level that isn't
// mostly solid yet):
//   S  struggle  — words looked up again and again (or marked hard), any level
//   M  met       — common words at the working level or one above, met in reading
//   Fo foundation — the working level's remaining frequency-ranked words
// Never-met dictionary candidates (get_intake_candidates) only fill slots the evidence
// pool can't — a cold-start fallback; Discover is how never-met words come in.
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
/** Lane M only takes genuinely common words (JMDict nf bands; 12 ≈ top ~6k). */
export const COMMON_FREQ_MAX = 12;

export type Lane = 'S' | 'M' | 'Fo' | 'cold';

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
 * counters (屋, 杯), and unranked katakana compounds (西アフリカ). Everything else
 * is judged by the lanes' level and frequency rules.
 */
export function isJunk(item: IntakeItem): boolean {
  const s = item.surface ?? item.candidate?.word ?? '';
  if (DIGITS.test(s)) return true;
  if ((item.pos ?? []).some((p) => AFFIX_POS.test(p))) return true;
  if (KATAKANA.test(s) && item.freqRank == null) return true;
  return false;
}

/** How the day's cap splits: S 40%, M 40%, Fo the rest (at least one when cap ≥ 3). */
export function laneShares(cap: number): { S: number; M: number; Fo: number } {
  if (cap <= 0) return { S: 0, M: 0, Fo: 0 };
  if (cap === 1) return { S: 0, M: 1, Fo: 0 };
  if (cap === 2) return { S: 1, M: 1, Fo: 0 };
  let S = Math.ceil(cap * 0.4);
  let M = Math.ceil(cap * 0.4);
  while (S + M > cap - 1) { if (S >= M) S--; else M--; }
  return { S, M, Fo: cap - S - M };
}

/**
 * v1's foundation-first order, still used inside the foundation lane and for the
 * cold-start fallback: easiest JLPT level first (higher number), then most common
 * (lowest freq_rank; nulls last). Unknown level sorts last. Tiebreak: a word the user
 * has actually encountered edges out a never-seen candidate.
 */
export function compareIntakeItem(a: IntakeItem, b: IntakeItem): number {
  const la = a.jlptLevel ?? Number.NEGATIVE_INFINITY; // unknown level = hardest, last
  const lb = b.jlptLevel ?? Number.NEGATIVE_INFINITY;
  if (la !== lb) return lb - la; // easier (higher number) first
  const fa = a.freqRank ?? Number.POSITIVE_INFINITY;
  const fb = b.freqRank ?? Number.POSITIVE_INFINITY;
  if (fa !== fb) return fa - fb; // most common (lowest rank) first
  return (b.timesSeen ?? 0) - (a.timesSeen ?? 0); // encountered edges out never-seen
}

const freq = (i: IntakeItem) => i.freqRank ?? Number.POSITIVE_INFINITY;

/** Lane S: met at least twice and looked up at least twice (or marked hard); any level. */
export function isStruggle(i: IntakeItem): boolean {
  if (i.key == null || i.timesSeen < 2) return false;
  if (i.jlptLevel == null && i.freqRank == null) return false;
  return (i.lookupCount ?? 0) >= 2 || i.mastery === 'hard';
}
function compareStruggle(a: IntakeItem, b: IntakeItem): number {
  const d = (b.lookupCount ?? 0) - (a.lookupCount ?? 0);
  if (d !== 0) return d;
  if (a.timesSeen !== b.timesSeen) return b.timesSeen - a.timesSeen;
  return freq(a) - freq(b);
}

/** Lane M: met in reading, common, at the working level or one harder. */
export function isMetAtLevel(i: IntakeItem, w: number): boolean {
  return i.key != null && i.timesSeen >= 1
    && (i.jlptLevel === w || i.jlptLevel === w - 1)
    && i.freqRank != null && i.freqRank <= COMMON_FREQ_MAX;
}
function compareMet(a: IntakeItem, b: IntakeItem): number {
  if (freq(a) !== freq(b)) return freq(a) - freq(b);
  return (b.jlptLevel ?? 0) - (a.jlptLevel ?? 0); // working level before the one above
}

/** Lane Fo: a queued word at the working level with a frequency rank. */
export function isFoundation(i: IntakeItem, w: number): boolean {
  return i.key != null && i.jlptLevel === w && i.freqRank != null;
}

export interface PromotionPick extends IntakeItem {
  lane: Lane;
}

/**
 * Choose up to `cap` words to promote this cycle. Fills lanes S, M, Fo to their
 * shares; a lane that can't fill its share spills to the others (S → M → Fo order).
 * Virtual candidates (never met, never triaged) only fill what's still empty after
 * that, at the working level — the cold-start path. De-dupes by entryId (a local
 * record beats a candidate naming the same entry) and skips junk. Returns [] for cap<=0.
 */
export function selectPromotions(
  queued: IntakeItem[],
  candidates: IntakeItem[],
  cap: number,
  working: number,
): PromotionPick[] {
  if (cap <= 0) return [];
  const local = new Map<string, IntakeItem>();
  for (const item of queued) if (!local.has(item.entryId) && !isJunk(item)) local.set(item.entryId, item);
  const pool = [...local.values()];

  const lanes: Record<Exclude<Lane, 'cold'>, IntakeItem[]> = {
    S: pool.filter(isStruggle).sort(compareStruggle),
    M: pool.filter((i) => isMetAtLevel(i, working)).sort(compareMet),
    Fo: pool.filter((i) => isFoundation(i, working)).sort(compareIntakeItem),
  };
  const shares = laneShares(cap);
  const taken = new Set<string>();
  const out: PromotionPick[] = [];
  const take = (lane: Exclude<Lane, 'cold'>, n: number) => {
    for (const i of lanes[lane]) {
      if (n <= 0 || out.length >= cap) return;
      if (taken.has(i.entryId)) continue;
      taken.add(i.entryId);
      out.push({ ...i, lane });
      n--;
    }
  };
  take('S', shares.S);
  take('M', shares.M);
  take('Fo', shares.Fo);
  for (const lane of ['S', 'M', 'Fo'] as const) take(lane, cap - out.length);

  if (out.length < cap) {
    const cold = candidates
      .filter((c) => !local.has(c.entryId) && !taken.has(c.entryId) && !isJunk(c)
        && c.jlptLevel === working && c.freqRank != null)
      .sort(compareIntakeItem);
    for (const c of cold) {
      if (out.length >= cap) break;
      taken.add(c.entryId);
      out.push({ ...c, lane: 'cold' });
    }
  }
  return out;
}
