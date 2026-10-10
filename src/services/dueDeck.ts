import { useAppStore, WordData } from './store';
import { selectDeck, DeckEntry } from './deck';

// A card carries the full word plus which source (due review / new) put it here.
export interface Card {
  key: string;
  word: WordData;
  kind: 'review' | 'new';
}

// Snapshot the current due deck from the store: map every word to a DeckEntry,
// run selectDeck, and rehydrate each surviving key back to its full WordData.
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
  return selectDeck(entries, now).map((c) => ({ key: c.key, word: db[c.key], kind: c.kind }));
}

// Size of the due deck right now — REVIEW uses it to pick its opening segment.
export function dueDeckSize(): number {
  return buildDeck().length;
}
