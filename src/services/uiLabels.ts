import { useAppStore } from './store';
import type { UiLanguage, WordData } from './store';
import { rtkKanjiList } from '../data/rtkKanji';

// Adaptive UI labels (docs/design-system.md §6.10). The app's chrome speaks English
// by default; a label turns Japanese when the reader actually learns its word
// (marked easy in the word database) — vocabulary, not JLPT level, drives it, so
// the interface itself becomes reading practice. A label can have several
// Japanese stages (LIBRARY: 本棚, later 書庫); each word moves it one step on. A
// stage can also wait for a kanji (LISTEN: 聞く, then 聴く once 聴 is within the
// reader's RTK progress — both spellings are one JMDict entry). Entry ids come
// from jmdict_entries.

export type UiLabelId = 'today' | 'read' | 'news' | 'library' | 'listen' | 'review' | 'search' | 'settings';

interface JaStage {
  ja: string;
  /** JMDict entry_id — the word database key once the word is linked. Left out
   *  when not yet verified against jmdict_entries: the word is then matched by
   *  its surface, and a title tap looks it up by text. */
  entryId?: string;
  /** Kanji the reader must also have reached in RTK order. */
  kanji?: string;
}

interface UiLabel {
  en: string;
  stages: JaStage[];
}

export const UI_LABELS: Record<UiLabelId, UiLabel> = {
  today: { en: 'Today', stages: [{ ja: '今日' }] },
  read: { en: 'Read', stages: [{ ja: '読む' }] },
  news: { en: 'News', stages: [{ ja: 'ニュース', entryId: '1091500' }] },
  // 聞く and 聴く share JMDict entry 1591110; 聴く waits for the kanji 聴 (RTK #890).
  listen: {
    en: 'Listen',
    stages: [
      { ja: '聞く', entryId: '1591110' },
      { ja: '聴く', entryId: '1591110', kanji: '聴' },
    ],
  },
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

const kanjiReached = (kanji: string, rtkLevel: number | null) => {
  const i = rtkKanjiList.indexOf(kanji);
  return i >= 0 && rtkLevel != null && i < rtkLevel;
};

/** The reader's record for a stage's word: by entry id, else by its surface. */
function stageWord(stage: JaStage, wordDatabase: Record<string, WordData>): WordData | undefined {
  if (stage.entryId) return wordDatabase[stage.entryId];
  return wordDatabase[stage.ja] ?? Object.values(wordDatabase).find((w) => w.surface === stage.ja);
}

/** Highest stage whose word the reader knows (0 = none). */
export function knownStage(id: UiLabelId, wordDatabase: Record<string, WordData>, rtkLevel: number | null): number {
  const { stages } = UI_LABELS[id];
  for (let i = stages.length - 1; i >= 0; i--) {
    const { kanji } = stages[i];
    if (stageWord(stages[i], wordDatabase)?.mastery === 'easy' && (!kanji || kanjiReached(kanji, rtkLevel))) return i + 1;
  }
  return 0;
}

/** The word a title tap opens: the first Japanese word while English, else the one shown. */
export function tapStage(id: UiLabelId, shown: number): JaStage {
  return UI_LABELS[id].stages[Math.max(1, shown) - 1];
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
  rtkLevel: number | null,
): UiLabelState {
  if (uiLanguage === 'english') return { shown: 0, next: null };
  const known = knownStage(id, wordDatabase, rtkLevel);
  // 日本語: at least the first Japanese stage, further ones as they're learned.
  if (uiLanguage === 'japanese') return { shown: Math.max(1, known), next: null };
  const shown = shownStages[id] ?? 0;
  return { shown, next: known > shown ? known : null };
}

export function useUiLabelState(id: UiLabelId): UiLabelState {
  const shown = useAppStore((s) => labelState(id, s.uiLanguage, s.labelStages, s.wordDatabase, s.rtkLevel).shown);
  const next = useAppStore((s) => labelState(id, s.uiLanguage, s.labelStages, s.wordDatabase, s.rtkLevel).next);
  return { shown, next };
}
