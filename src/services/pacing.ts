// Study-pacing reclassification (the flood fix) — the pure "where does each word
// belong" policy, applied one-time by store.resetStudyPacing and unit-testable in
// isolation (mirrors deck.ts / srs.ts). See docs/study-pacing-flood-fix.md.
//
// The model (Policy F): flashcards AUGMENT reading, they don't mirror it. So of the
// back-catalog that #67 seed-on-sight dumped into active scheduling:
//   • EASY words (difficulty ≤ 3 — the app's own 'easy' mastery bucket) stay on the
//     FSRS schedule but are re-seeded FAR OUT (seedForwardFromHistory: anchored at
//     now, stretched by exposure history). Reading pushes them further, so they
//     rarely surface as flashcards — maintenance, not drilling.
//   • MEDIUM+ words go back to the intake QUEUE, to drip into active study at the
//     daily cap (foundation-first). Drilling is reserved for what you're learning.
// A word that later grades down to easy naturally earns a long interval and joins
// the far-out pool — the "graduate when easy" step is automatic in FSRS, no code.

import { seedForwardFromHistory, type SrsState } from './srs';

/** The app's `mastery==='easy'` boundary (bucketForDifficulty: difficulty ≤ 3). */
export const EASY_MAX_DIFFICULTY = 3;

/** Fields the pacing decision reads from a word (projected from WordData by the caller). */
export interface PacingInput {
  key: string;
  difficulty: number | null;
  distinctExposures: number;              // uniqueDaysSeen.length — the real spacing signal
  intakeStatus?: 'queued' | 'active';
  stability?: number | null;
}

export type PacingDecision =
  | { action: 'keep-active'; srs: SrsState }  // easy → far-out forward-reseed
  | { action: 'requeue' };                    // medium+ → back to the queue

/**
 * Deterministic [0,1) spread fraction from a word key (FNV-1a hash). Feeds
 * seedForwardFromHistory's jitter so an identical-stability cohort fans across days
 * instead of piling onto one — without a clock or RNG (resume-safe, testable).
 */
export function spreadFractionForKey(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** Active = currently in FSRS scheduling. Mirrors deck.isActive so the two agree. */
export function isActiveForPacing(i: PacingInput): boolean {
  if (i.intakeStatus === 'queued') return false;
  return i.intakeStatus === 'active' || i.stability != null;
}

/**
 * Reclassify ONE active word under Policy F. Only meaningful for active words
 * (caller gates with isActiveForPacing). A null/unknown difficulty is treated as
 * medium (6) — no evidence of ease → it belongs in the queue, not the far-out pool.
 */
export function decidePacing(i: PacingInput, now: number): PacingDecision {
  const difficulty = i.difficulty ?? 6;
  if (difficulty <= EASY_MAX_DIFFICULTY) {
    const srs = seedForwardFromHistory(difficulty, i.distinctExposures, now, {
      spreadFraction: spreadFractionForKey(i.key),
    });
    return { action: 'keep-active', srs };
  }
  return { action: 'requeue' };
}
