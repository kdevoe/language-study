import { useAppStore } from './store';
import type { UiLanguage, WordData } from './store';

// Adaptive UI labels (docs/design-system.md §6.10). The app's chrome speaks English
// by default; a label turns Japanese when the reader actually learns its word
// (marked easy in the word database) — vocabulary, not JLPT level, drives it, so
// the interface itself becomes reading practice. A label can have several
// Japanese stages (LIBRARY: 本棚, later 書庫); each word moves it one step on.
// Entry ids come from jmdict_entries.

export type UiLabelId = 'news' | 'library' | 'listen' | 'review' | 'search' | 'settings';

interface JaStage {
  ja: string;
  /** JMDict entry_id — the word database key once the word is linked. */
  entryId: string;
}

interface UiLabel {
  en: string;
  stages: JaStage[];
}

export const UI_LABELS: Record<UiLabelId, UiLabel> = {
  news: { en: 'News', stages: [{ ja: 'ニュース', entryId: '1091500' }] },
  // 聴く shares JMDict entry 1591110 with 聞く.
  listen: { en: 'Listen', stages: [{ ja: '聴く', entryId: '1591110' }] },
  review: { en: 'Review', stages: [{ ja: '復習', entryId: '1500800' }] },
  search: { en: 'Search', stages: [{ ja: '検索', entryId: '1257900' }] },
  library: {
    en: 'Library',
    stages: [
      { ja: '本棚', entryId: '1522980' },
      { ja: '書庫', entryId: '1344020' },
    ],
  },
  settings: { en: 'Settings', stages: [{ ja: '設定', entryId: '1386060' }] },
};

/** Text for a stage: 0 is English, 1.. the Japanese stages. */
export function labelText(id: UiLabelId, stage: number, upper = false): string {
  const label = UI_LABELS[id];
  if (stage <= 0) return upper ? label.en.toUpperCase() : label.en;
  return label.stages[Math.min(stage, label.stages.length) - 1].ja;
}

/** Highest stage whose word the reader knows (0 = none). */
export function knownStage(id: UiLabelId, wordDatabase: Record<string, WordData>): number {
  const { stages } = UI_LABELS[id];
  for (let i = stages.length - 1; i >= 0; i--) {
    if (wordDatabase[stages[i].entryId]?.mastery === 'easy') return i + 1;
  }
  return 0;
}

/**
 * `shown` is what the label displays now; `next` is set when the reader has
 * learned a further word and the page title should play the switch to it.
 */
export interface UiLabelState {
  shown: number;
  next: number | null;
}

export function labelState(
  id: UiLabelId,
  uiLanguage: UiLanguage,
  shownStages: Record<string, number>,
  wordDatabase: Record<string, WordData>,
): UiLabelState {
  if (uiLanguage === 'english') return { shown: 0, next: null };
  const known = knownStage(id, wordDatabase);
  // 日本語: at least the first Japanese stage, further ones as they're learned.
  if (uiLanguage === 'japanese') return { shown: Math.max(1, known), next: null };
  const shown = shownStages[id] ?? 0;
  return { shown, next: known > shown ? known : null };
}

export function useUiLabelState(id: UiLabelId): UiLabelState {
  const shown = useAppStore((s) => labelState(id, s.uiLanguage, s.labelStages, s.wordDatabase).shown);
  const next = useAppStore((s) => labelState(id, s.uiLanguage, s.labelStages, s.wordDatabase).next);
  return { shown, next };
}
