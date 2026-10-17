// RTK kanji deck — pure selection and seeding logic (see docs/rtk-kanji-deck-plan.md).
//
// One card per kanji, keyword on the front. The deck holds only kanji that have been
// introduced: imported from Anki (source 'anki') or added by the daily drip in Heisig
// order (source 'yugen'). Scheduling itself is srs.ts's `scheduleKanji`; this module
// decides what's due, what's new, what to introduce next, and how an Anki card's
// SM-2 schedule maps onto an FSRS state. No clock reads: `now` is always passed in.

import type { SrsState, SrsStatus } from './srs';

const DAY_MS = 86_400_000;

export interface KanjiProgress {
  kanji: string;
  heisigNo: number;
  stability: number | null;      // FSRS S, days (null until first graded, for a new kanji)
  fsrsDifficulty: number | null; // FSRS D, 1..10
  dueAt: number | null;          // ms epoch
  lastReviewedAt: number | null; // ms epoch
  intervalDays: number | null;
  reps: number;
  lapses: number;
  status: SrsStatus;
  introducedAt: number;          // ms epoch
  source: 'anki' | 'yugen';
  updatedAt: number;             // ms epoch — last-write-wins key for sync
}

export interface KanjiCard {
  kanji: string;
  kind: 'review' | 'new';
}

/** Introduced but never graded: shown as a new card, scheduled from a fresh FSRS card. */
export function isNewKanji(p: KanjiProgress): boolean {
  return p.status === 'new' && p.reps === 0 && p.stability == null;
}

/**
 * Today's kanji session: due reviews first (most overdue first), then new kanji in
 * Heisig order. A new kanji is always "due" — it was introduced to be studied.
 */
export function selectKanjiDeck(progress: KanjiProgress[], now: number): KanjiCard[] {
  const reviews = progress
    .filter((p) => !isNewKanji(p) && p.dueAt != null && p.dueAt <= now)
    .sort((a, b) => (a.dueAt! - b.dueAt!) || (a.heisigNo - b.heisigNo));
  const fresh = progress.filter(isNewKanji).sort((a, b) => a.heisigNo - b.heisigNo);
  return [
    ...reviews.map((p) => ({ kanji: p.kanji, kind: 'review' as const })),
    ...fresh.map((p) => ({ kanji: p.kanji, kind: 'new' as const })),
  ];
}

/** The prior FSRS state for a graded kanji, or null for a new one (fresh card). */
export function kanjiSrsState(p: KanjiProgress): SrsState | null {
  if (isNewKanji(p) || p.stability == null || p.dueAt == null) return null;
  return {
    stability: p.stability,
    fsrsDifficulty: p.fsrsDifficulty ?? 5,
    dueAt: p.dueAt,
    lastReviewedAt: p.lastReviewedAt ?? p.introducedAt,
    reps: p.reps,
    lapses: p.lapses,
    status: p.status === 'new' ? 'review' : p.status,
  };
}

function sameLocalDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** Highest Heisig number introduced so far — the user's RTK level. 0 when empty. */
export function highestHeisig(progress: KanjiProgress[]): number {
  return progress.reduce((m, p) => Math.max(m, p.heisigNo), 0);
}

/**
 * Which kanji to introduce now. Counts kanji the drip already introduced today
 * (synced `introducedAt`, so a second device doesn't double up), and continues in
 * Heisig order from the highest introduced. `rtkList` is the 6th-edition order.
 */
export function kanjiToIntroduce(
  progress: KanjiProgress[],
  rtkList: readonly string[],
  perDay: number,
  now: number,
): { kanji: string; heisigNo: number }[] {
  const today = progress.filter((p) => p.source === 'yugen' && sameLocalDay(p.introducedAt, now)).length;
  const room = Math.max(0, perDay - today);
  const start = highestHeisig(progress);
  return rtkList.slice(start, start + room).map((kanji, i) => ({ kanji, heisigNo: start + i + 1 }));
}

/** A freshly introduced kanji (daily drip). */
export function newKanjiProgress(kanji: string, heisigNo: number, now: number): KanjiProgress {
  return {
    kanji, heisigNo,
    stability: null, fsrsDifficulty: null, dueAt: now, lastReviewedAt: null, intervalDays: null,
    reps: 0, lapses: 0, status: 'new',
    introducedAt: now, source: 'yugen', updatedAt: now,
  };
}

// ── Anki import ──────────────────────────────────────────────────────────────
// An FSRS replay of the user's Anki history (all passes, half of them Easy) put
// most cards a year or more out, so the import keeps Anki's own schedule instead:
// the due date carries over unchanged, stability is seeded from Anki's interval
// (at retention 0.9 an FSRS interval equals S), and difficulty from the ease
// factor. FSRS takes over from each card's next review.

export interface AnkiCardSchedule {
  intervalDays: number;   // Anki's current interval (cards.ivl)
  easeFactor: number;     // Anki ease in permille (cards.factor), 2500 = default
  dueAt: number;          // ms epoch, from Anki's due day
  lastReviewedAt: number; // ms epoch, last revlog entry
  reps: number;           // successful reviews in the imported history
  lapses: number;
}

/** Map an Anki ease factor to FSRS difficulty: 2500 → 5, each 200 either side is one step. */
export function difficultyFromEase(easeFactor: number): number {
  return Math.min(10, Math.max(1, 5 - (easeFactor - 2500) / 200));
}

export function seedFromAnki(c: AnkiCardSchedule): SrsState & { intervalDays: number } {
  const intervalDays = Math.max(1, c.intervalDays);
  return {
    stability: intervalDays,
    fsrsDifficulty: difficultyFromEase(c.easeFactor),
    dueAt: c.dueAt,
    lastReviewedAt: c.lastReviewedAt,
    reps: c.reps,
    lapses: c.lapses,
    status: 'review',
    intervalDays,
  };
}

/** Days until a kanji is due (negative = overdue). */
export function daysUntilDue(p: KanjiProgress, now: number): number | null {
  return p.dueAt == null ? null : (p.dueAt - now) / DAY_MS;
}
