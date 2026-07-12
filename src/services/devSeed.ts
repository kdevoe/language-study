// Dev-only flashcard demo seeder (#70). Populates the store with a small,
// hand-authored deck so the STUDY tab can be exercised without first reading
// articles to accrue due words. Gated to VITE_DEV_MODE at the call site
// (Flashcards.tsx) — never shipped to real users.
//
// The words are seeded already `active` and scheduled (4 due reviews + 4 new
// intake cards) with real per-kanji furiganaMap, mirroring what enrichment +
// #68 promotion would produce, so the deck, furigana, and FSRS grading all work.

import { useAppStore, type WordData } from './store';

type Seed = Partial<WordData> & { surface: string; reading: string; meaning: string; jlptLevel: number; freqRank: number };

const DAY = 86_400_000;

/** Build the 8 demo words keyed by a stable demo id (prefixed so they're obvious). */
function demoWords(now: number): Record<string, WordData> {
  const base = (o: Seed & { dueAt: number; reps: number; promotedTs: number | null }): WordData => ({
    mastery: 'medium',
    timesSeen: 4,
    uniqueDaysSeen: ['2026-07-10'],
    lastSeenTs: now - 2 * DAY,
    streak: 1,
    difficulty: 5,
    intakeStatus: 'active',
    stability: 8,
    fsrsDifficulty: 5,
    lapses: 0,
    srsStatus: 'review',
    lastReviewedTs: now - 2 * DAY,
    grammarNote: '',
    furiganaMap: [],
    ...o,
  });
  const review = (o: Seed & { overdueDays: number }): WordData =>
    base({ ...o, dueAt: now - o.overdueDays * DAY, reps: 3, promotedTs: null });
  const fresh = (o: Seed): WordData =>
    base({ ...o, dueAt: now + 14 * DAY, reps: 0, promotedTs: now - DAY });

  return {
    'demo:経済': review({ surface: '経済', reading: 'けいざい', meaning: 'economy; economics', jlptLevel: 4, freqRank: 10, overdueDays: 6, furiganaMap: [{ kanji: '経', kana: 'けい' }, { kanji: '済', kana: 'ざい' }] }),
    'demo:影響': review({ surface: '影響', reading: 'えいきょう', meaning: 'influence; effect; impact', jlptLevel: 3, freqRank: 30, overdueDays: 4, grammarNote: 'Often 〜に影響を与える (to have an effect on).', furiganaMap: [{ kanji: '影', kana: 'えい' }, { kanji: '響', kana: 'きょう' }] }),
    'demo:政府': review({ surface: '政府', reading: 'せいふ', meaning: 'government; administration', jlptLevel: 3, freqRank: 45, overdueDays: 2, furiganaMap: [{ kanji: '政', kana: 'せい' }, { kanji: '府', kana: 'ふ' }] }),
    'demo:発表': review({ surface: '発表', reading: 'はっぴょう', meaning: 'announcement; presentation', jlptLevel: 3, freqRank: 55, overdueDays: 1, furiganaMap: [{ kanji: '発', kana: 'はっ' }, { kanji: '表', kana: 'ぴょう' }] }),
    'demo:水': fresh({ surface: '水', reading: 'みず', meaning: 'water', jlptLevel: 5, freqRank: 1, furiganaMap: [{ kanji: '水', kana: 'みず' }] }),
    'demo:時間': fresh({ surface: '時間', reading: 'じかん', meaning: 'time; hour', jlptLevel: 5, freqRank: 8, furiganaMap: [{ kanji: '時', kana: 'じ' }, { kanji: '間', kana: 'かん' }] }),
    'demo:会議': fresh({ surface: '会議', reading: 'かいぎ', meaning: 'meeting; conference', jlptLevel: 4, freqRank: 20, furiganaMap: [{ kanji: '会', kana: 'かい' }, { kanji: '議', kana: 'ぎ' }] }),
    'demo:提案': fresh({ surface: '提案', reading: 'ていあん', meaning: 'proposal; suggestion', jlptLevel: 3, freqRank: 70, grammarNote: 'する-verb: 提案する = to propose.', furiganaMap: [{ kanji: '提', kana: 'てい' }, { kanji: '案', kana: 'あん' }] }),
  };
}

/**
 * Merge the demo deck into the store (persisted like any other words). Reads the
 * clock here so the module stays free of top-level Date calls. Returns nothing;
 * the caller re-reads the deck to refresh the view.
 */
export function seedDemoDeck(): void {
  const words = demoWords(Date.now());
  useAppStore.setState((state) => ({
    wordDatabase: { ...state.wordDatabase, ...words },
    jlptLevel: state.jlptLevel ?? 4,
    isOnboarded: true,
  }));
}
