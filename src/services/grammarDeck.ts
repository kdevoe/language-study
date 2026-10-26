// Grammar cards from ハルカ's weekly recap (docs/grammar-cards-plan.md, database/43-44):
// one rule with one schedule, and a pool of sentences with a blank and two choices.
// The server writes them; here they're picked for the 単語 session, each showing
// the sentence seen least recently, and scheduled with FSRS like words. Pure, so
// the store (grammarStore.ts) and the deck builder (dueDeck.ts) share it.

import type { SrsState, SrsStatus } from './srs';

export interface GrammarSentence {
  id: string;
  before: string;
  answer: string;
  wrong: string;
  after: string;
  fromSlip: boolean;
  /** Last time it came up; null = not yet. */
  shownAt: number | null;
  createdAt: number;
}

export interface GrammarCard {
  id: string;
  pattern: string;
  rule: string;
  sentences: GrammarSentence[];
  /** The sentence on screen (below), or null for a card from before database/44. */
  sentenceId: string | null;
  before: string;
  answer: string;
  wrong: string;
  after: string;
  explain: string;
  fromSlip: boolean;
  stability: number | null;
  fsrsDifficulty: number | null;
  dueAt: number | null;
  lastReviewedAt: number | null;
  intervalDays: number | null;
  reps: number;
  lapses: number;
  status: SrsStatus;
  /** First review; null while the card is still new. */
  introducedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** New grammar cards a day: a Sunday batch (up to 9) arrives over three days. */
export const NEW_GRAMMAR_PER_DAY = 3;

export const isNewGrammar = (c: GrammarCard) => c.introducedAt == null;

function sameLocalDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/**
 * Today's grammar cards: the due ones (most overdue first), then today's share of
 * new ones (oldest first), up to NEW_GRAMMAR_PER_DAY less any already started today.
 */
export function selectGrammarCards(cards: GrammarCard[], now: number): { card: GrammarCard; kind: 'review' | 'new' }[] {
  const reviews = cards
    .filter((c) => !isNewGrammar(c) && c.dueAt != null && c.dueAt <= now)
    .sort((a, b) => a.dueAt! - b.dueAt!);
  const startedToday = cards.filter((c) => c.introducedAt != null && sameLocalDay(c.introducedAt, now)).length;
  const fresh = cards
    .filter(isNewGrammar)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, Math.max(0, NEW_GRAMMAR_PER_DAY - startedToday));
  return [
    ...reviews.map((card) => ({ card, kind: 'review' as const })),
    ...fresh.map((card) => ({ card, kind: 'new' as const })),
  ];
}

/** The prior FSRS state for a graded card, or null for a new one. */
export function grammarSrsState(c: GrammarCard): SrsState | null {
  if (isNewGrammar(c) || c.stability == null || c.dueAt == null) return null;
  return {
    stability: c.stability,
    fsrsDifficulty: c.fsrsDifficulty ?? 5,
    dueAt: c.dueAt,
    lastReviewedAt: c.lastReviewedAt ?? c.introducedAt ?? c.dueAt,
    reps: c.reps,
    lapses: c.lapses,
    status: c.status === 'new' ? 'review' : c.status,
  };
}

/**
 * The card showing its next sentence: the one seen least recently (not yet seen
 * first, the learner's own slip first among those), never `avoid` when there's
 * another. A card without a pool shows its own sentence.
 */
export function withNextSentence(c: GrammarCard, avoid?: string | null): GrammarCard {
  const pool = c.sentences.length > 1 ? c.sentences.filter((s) => s.id !== avoid) : c.sentences;
  const next = [...pool].sort((a, b) =>
    (a.shownAt ?? -1) - (b.shownAt ?? -1) || Number(b.fromSlip) - Number(a.fromSlip) || a.createdAt - b.createdAt)[0];
  if (!next) return c;
  return { ...c, sentenceId: next.id, before: next.before, answer: next.answer, wrong: next.wrong, after: next.after, fromSlip: next.fromSlip };
}
