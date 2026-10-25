// Thinking time → the grade slider's starting position (both flashcard decks).
//
// The slider is a setting, not four buttons: it starts on a grade picked from how
// long the front of the card was looked at before flipping, the user nudges it only
// when that guess is wrong, and tapping the card moves on. Quick (under half the
// user's usual time) starts on Easy, normal (up to twice it) on Good, slow on Hard.
// It never starts on Again — "I couldn't recall it" is always the user's call.
// Thresholds follow the user's own pace: the median of their recent think times
// per deck, falling back to 6s until there are enough samples.

import type { Rating } from './srs';

export type DeckId = 'vocab' | 'kanji' | 'grammar';

const STORAGE_KEY = 'yugen-think-times';
const KEEP = 50;            // recent samples per deck
const MIN_SAMPLES = 10;     // below this, use the fallback median
const FALLBACK_MEDIAN_MS = 6_000;
// A grammar card is a sentence to read and a choice to make, not a word to recognise.
const FALLBACK_BY_DECK: Partial<Record<DeckId, number>> = { grammar: 12_000 };
const CAP_MS = 60_000;      // a card left open while distracted shouldn't skew the median

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Pure: the starting grade for a think time, given the deck's recent samples. */
export function defaultGrade(thinkMs: number, history: number[], fallbackMs = FALLBACK_MEDIAN_MS): Rating {
  const m = history.length >= MIN_SAMPLES ? median(history) : fallbackMs;
  if (thinkMs <= m * 0.5) return 4;
  if (thinkMs <= m * 2) return 3;
  return 2;
}

function readAll(): Record<DeckId, number[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return { vocab: parsed?.vocab ?? [], kanji: parsed?.kanji ?? [], grammar: parsed?.grammar ?? [] };
  } catch {
    return { vocab: [], kanji: [], grammar: [] };
  }
}

export function thinkHistory(deck: DeckId): number[] {
  return readAll()[deck];
}

/** The starting grade for a deck's think time, with that deck's own fallback pace. */
export function deckDefaultGrade(deck: DeckId, thinkMs: number): Rating {
  return defaultGrade(thinkMs, thinkHistory(deck), FALLBACK_BY_DECK[deck]);
}

/** Record a think time once the card is graded (only real flips count). */
export function recordThinkTime(deck: DeckId, thinkMs: number): void {
  try {
    const all = readAll();
    all[deck] = [...all[deck], Math.min(CAP_MS, Math.max(0, Math.round(thinkMs)))].slice(-KEEP);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage full or blocked: the slider just falls back to the default pace.
  }
}
