import { useCallback, useMemo, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { Flashcards } from './Flashcards';
import { KanjiFlashcards } from './KanjiFlashcards';
import { buildDeck, dueDeckSize } from '../services/dueDeck';
import { buildKanjiDeck, useKanjiStore } from '../services/kanjiStore';
import { Progress } from './Progress';
import { useAppStore } from '../services/store';
import { PageHeading } from './PageHeading';
import { Segment } from './Segment';

export type ReviewSegment = 'review' | 'progress';
type Deck = 'vocab' | 'kanji';

// REVIEW tab: flashcards (復習) and the progress dashboard (進捗) behind one
// segmented control, so the bottom nav needs one slot for both. Opens on 復習
// when cards are due, otherwise on 進捗 (an "all caught up" visit lands on the
// heatmap, not the empty deck); an explicit choice is remembered by App for the
// session. Both panes stay mounted once visited — switching segments must not
// re-snapshot the flashcard deck mid-run.
//
// With an RTK kanji deck (docs/rtk-kanji-deck-plan.md, option B), 復習 opens on two
// deck rows — 単語 and 漢字 — and tapping one runs that deck under a "‹ 単語" /
// "‹ 漢字" heading. Without one, 復習 is the vocab deck directly, as before.
const SEGMENTS: { id: ReviewSegment; label: string }[] = [
  { id: 'review', label: '復習' },
  { id: 'progress', label: '進捗' },
];

const DECK_TITLE: Record<Deck, string> = { vocab: '単語', kanji: '漢字' };

// Height the segmented control row occupies above the content (pill + breathing
// room below it, as in docs/mockups/review-progress.html).
const SEGMENT_BAR_HEIGHT = '4.4rem';

// Matches how the store stamps reviewsByDay (UTC day key).
const utcDayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function Review({
  segment,
  onSegmentChange,
  onFocusChange,
}: {
  segment: ReviewSegment | null;
  onSegmentChange: (segment: ReviewSegment) => void;
  onFocusChange?: (focused: boolean) => void;
}) {
  const kanjiProgress = useKanjiStore((s) => s.progress);
  const hasKanji = Object.keys(kanjiProgress).length > 0;
  const [defaultSegment] = useState<ReviewSegment>(() =>
    (dueDeckSize() > 0 || buildKanjiDeck().length > 0 ? 'review' : 'progress'));
  const active = segment ?? defaultSegment;
  const [visitedProgress, setVisitedProgress] = useState(active === 'progress');
  const [remaining, setRemaining] = useState(0);
  const [focused, setFocused] = useState(false);
  // Deck rows mode: which deck is open (null = the rows), and which have been
  // opened this visit (kept mounted so going back to the rows keeps the session).
  const [deck, setDeck] = useState<Deck | null>(null);
  const [opened, setOpened] = useState<Deck[]>([]);
  // Each open bumps the deck's key, so its session enters focus mode (nav hidden) at once.
  const [focusKeys, setFocusKeys] = useState<Record<Deck, number>>({ vocab: 0, kanji: 0 });
  const reviewsToday = useAppStore((s) => s.reviewsByDay[utcDayKey(Date.now())] ?? 0);
  const trackedWords = useAppStore((s) => Object.keys(s.wordDatabase).length);
  const wordDatabase = useAppStore((s) => s.wordDatabase);

  // Live counts for the deck rows (recomputed when a sync or a grade lands).
  const vocabDeck = useMemo(() => buildDeck(), [wordDatabase]); // eslint-disable-line react-hooks/exhaustive-deps
  const kanjiDeck = useMemo(() => buildKanjiDeck(), [kanjiProgress]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFocus = useCallback(
    (f: boolean) => {
      setFocused(f);
      onFocusChange?.(f);
    },
    [onFocusChange],
  );

  const select = (id: ReviewSegment) => {
    if (id === 'progress') setVisitedProgress(true);
    onSegmentChange(id);
  };

  const openDeck = (d: Deck) => {
    setOpened((o) => (o.includes(d) ? o : [...o, d]));
    setFocusKeys((k) => ({ ...k, [d]: k[d] + 1 }));
    setDeck(d);
  };

  const inDeck = hasKanji && deck != null && active === 'review';
  const badgeCount = hasKanji ? vocabDeck.length + kanjiDeck.length : remaining;

  return (
    <div>
      {/* Focus mode hides the heading and control along with the nav so the card keeps the screen. */}
      {!focused && !inDeck && <PageHeading id="review" settingsMark={false} />}
      {!focused && inDeck && (
        <div style={{ display: 'flex', alignItems: 'center', minHeight: '2.75rem', marginBottom: '1rem' }}>
          <h1 className="serif" translate="no" style={{ fontSize: '2rem', fontWeight: 500, lineHeight: 1.2, color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <button
              onClick={() => setDeck(null)}
              aria-label="Back to decks"
              style={{ display: 'flex', border: 'none', background: 'none', padding: '0.3rem 0.2rem 0.3rem 0', marginLeft: '-0.35rem', color: 'var(--text-muted)', cursor: 'pointer' }}
            >
              <ChevronLeft size={24} strokeWidth={1.5} />
            </button>
            {DECK_TITLE[deck!]}
          </h1>
        </div>
      )}
      {!focused && !inDeck && (
        <div style={{ height: SEGMENT_BAR_HEIGHT, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <Segment
            options={SEGMENTS.map(({ id, label }) => ({
              id,
              label,
              badge: id === 'review' && badgeCount > 0 && (
                <span
                  className="sans"
                  style={{
                    fontSize: '0.62rem',
                    fontWeight: 700,
                    backgroundColor: 'var(--accent-primary)',
                    color: 'var(--text-main)',
                    borderRadius: '100px',
                    padding: '0.05rem 0.45rem',
                  }}
                >
                  {badgeCount}
                </span>
              ),
            }))}
            active={active}
            onChange={select}
          />
          <span
            className="sans"
            style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', lineHeight: 1, marginTop: '0.95rem' }}
          >
            {active === 'review' ? `今日 ${reviewsToday} 回` : `${trackedWords.toLocaleString()} 語`}
          </span>
        </div>
      )}

      {!hasKanji && (
        <div hidden={active !== 'review'}>
          <Flashcards
            onFocusChange={handleFocus}
            onRemainingChange={setRemaining}
            topOffset={focused ? '0rem' : SEGMENT_BAR_HEIGHT}
          />
        </div>
      )}

      {hasKanji && (
        <div hidden={active !== 'review'}>
          {deck == null && (
            <DeckRows
              vocabDue={vocabDeck.length}
              vocabNew={vocabDeck.filter((c) => c.kind === 'new').length}
              kanjiDue={kanjiDeck.length}
              kanjiNew={kanjiDeck.filter((c) => c.kind === 'new').map((c) => kanjiProgress[c.kanji]?.heisigNo).filter((n): n is number => n != null)}
              kanjiTotal={Object.keys(kanjiProgress).length}
              onOpen={openDeck}
            />
          )}
          {opened.includes('vocab') && (
            <div hidden={deck !== 'vocab'}>
              <Flashcards onFocusChange={handleFocus} onRemainingChange={setRemaining} topOffset="0rem" focusKey={focusKeys.vocab} />
            </div>
          )}
          {opened.includes('kanji') && (
            <div hidden={deck !== 'kanji'}>
              <KanjiFlashcards
                onFocusChange={handleFocus}
                onRemainingChange={setRemaining}
                onDone={vocabDeck.length > 0 ? () => openDeck('vocab') : undefined}
                topOffset="0rem"
                focusKey={focusKeys.kanji}
              />
            </div>
          )}
        </div>
      )}

      {visitedProgress && (
        <div hidden={active !== 'progress'}>
          <Progress embedded />
        </div>
      )}
    </div>
  );
}

// The two deck rows 復習 opens on (mockup docs/mockups/kanji-deck.html): name and a
// quiet line about today's new cards on the left, the due count on the right.
function DeckRows({ vocabDue, vocabNew, kanjiDue, kanjiNew, kanjiTotal, onOpen }: {
  vocabDue: number;
  vocabNew: number;
  kanjiDue: number;
  kanjiNew: number[];
  kanjiTotal: number;
  onOpen: (deck: Deck) => void;
}) {
  const newRange = kanjiNew.length === 0
    ? `RTK · ${kanjiTotal.toLocaleString()} kanji`
    : kanjiNew.length === 1
      ? `RTK · #${kanjiNew[0]} new today`
      : `RTK · #${Math.min(...kanjiNew)}–${Math.max(...kanjiNew)} new today`;
  const rows: { deck: Deck; sub: string; due: number }[] = [
    { deck: 'vocab', sub: vocabNew > 0 ? `vocabulary · ${vocabNew} new today` : 'vocabulary', due: vocabDue },
    { deck: 'kanji', sub: newRange, due: kanjiDue },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem', paddingBottom: 'calc(5rem + env(safe-area-inset-bottom))' }}>
      {rows.map((r) => (
        <button
          key={r.deck}
          onClick={() => onOpen(r.deck)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
            padding: '1.3rem 1.4rem',
            border: '1px solid var(--border-light)',
            borderRadius: '24px',
            backgroundColor: 'var(--bg-pure)',
            boxShadow: '0 4px 25px rgba(0,0,0,0.03)',
            textAlign: 'left',
            cursor: 'pointer',
            color: 'var(--text-main)',
          }}
        >
          <span>
            <span className="serif" style={{ display: 'block', fontSize: '1.4rem', fontWeight: 500, lineHeight: 1.3 }}>{DECK_TITLE[r.deck]}</span>
            <span className="sans" style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)' }}>{r.sub}</span>
          </span>
          <span style={{ textAlign: 'right' }}>
            <span className="serif" style={{ display: 'block', fontSize: '1.8rem', fontWeight: 500, lineHeight: 1, color: r.due > 0 ? 'var(--text-main)' : 'var(--text-muted)' }}>{r.due}</span>
            <span className="sans" style={{ display: 'block', fontSize: '0.62rem', letterSpacing: '0.08em', color: 'var(--text-muted)', marginTop: '0.3rem' }}>DUE</span>
          </span>
        </button>
      ))}
    </div>
  );
}
