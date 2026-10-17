// The four flashcard grades as the grade slider labels them (both decks), and the
// interval caption under it. FSRS ratings 1–4 = Again / Hard / Good / Easy.

import type { Rating } from './srs';

export const GRADES: { rating: Rating; label: string }[] = [
  { rating: 1, label: 'もう一度' },
  { rating: 2, label: '難しい' },
  { rating: 3, label: '正解' },
  { rating: 4, label: '簡単' },
];

/** Interval in the slider's caption: 10分, 5時間, 3日, 2ヶ月, 1.4年. */
export function formatIntervalJa(days: number): string {
  if (days < 1) {
    const mins = Math.max(1, Math.round(days * 24 * 60));
    return mins < 60 ? `${mins}分` : `${Math.round(days * 24)}時間`;
  }
  if (days < 30) return `${Math.round(days)}日`;
  if (days < 365) return `${Math.round(days / 30)}ヶ月`;
  return `${(days / 365).toFixed(1)}年`;
}
