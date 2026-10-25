import { useAppStore, WordData } from './store';
import { selectDeck, mixNewCards, DeckEntry } from './deck';
import { buildGrammarCards } from './grammarStore';
import type { GrammarCard } from './grammarDeck';

// A card carries the full word (or grammar card) plus which source (due review /
// new) put it here. Grammar cards (docs/grammar-cards-plan.md) share the 単語 session.
export type Card =
  | { type: 'word'; key: string; word: WordData; kind: 'review' | 'new' }
  | { type: 'grammar'; key: string; card: GrammarCard; kind: 'review' | 'new' };

// Snapshot the current due deck from the store: map every word to a DeckEntry,
// run selectDeck, rehydrate each surviving key back to its full WordData, and
// spread today's grammar cards evenly through it.
export function buildDeck(): Card[] {
  const db = useAppStore.getState().wordDatabase;
  const now = Date.now();
  const entries: DeckEntry[] = Object.entries(db).map(([key, w]) => ({
    key,
    jlptLevel: w.jlptLevel ?? null,
    freqRank: w.freqRank ?? null,
    dueAt: w.dueAt ?? null,
    reps: w.reps ?? null,
    stability: w.stability ?? null,
    intakeStatus: w.intakeStatus,
    promotedTs: w.promotedTs ?? null,
  }));
  const words: Card[] = selectDeck(entries, now).map((c) => ({ type: 'word', key: c.key, word: db[c.key], kind: c.kind }));
  const grammar: Card[] = buildGrammarCards(now).map((g) => ({ type: 'grammar', key: `g:${g.card.id}`, card: g.card, kind: g.kind }));
  return mixNewCards(words, grammar);
}

// Size of the due deck right now — REVIEW uses it to pick its opening segment.
export function dueDeckSize(): number {
  return buildDeck().length;
}
