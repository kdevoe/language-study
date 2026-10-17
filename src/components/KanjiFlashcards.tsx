import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import { useAppStore, type WordData } from '../services/store';
import { useKanjiStore, buildKanjiDeck } from '../services/kanjiStore';
import type { KanjiCard } from '../services/kanjiDeck';
import { mergeArrivals, queueRepeat, type SessionCard } from '../services/deck';
import type { Rating } from '../services/srs';
import { defaultGrade, recordThinkTime, thinkHistory } from '../services/thinkTime';
import { furiganaSegments } from '../services/furigana';
import { rtkKanjiMap } from '../data/rtkKanji';
import type { KanjiInfo } from '../data/rtkKanjiInfo';
import { GradeSlider } from './GradeSlider';
import { StudyCard, PILE_SPACE } from './StudyCard';
import { CardFace, Centered, ExitFocusButton } from './Flashcards';

// The RTK kanji deck's session (docs/rtk-kanji-deck-plan.md, mockup
// docs/mockups/kanji-deck.html). Keyword on the front; the back shows the kanji,
// keyword, readings, components and up to three words you already know that use
// it, with furigana. Grading is the same as the vocab deck: the slider starts from
// the thinking time, a tap on the card moves on. Like Flashcards, the deck is
// snapshotted at mount so grading doesn't reshuffle it.

const MAX_KNOWN = 3;
const MASTERY_ORDER: Record<string, number> = { easy: 0, medium: 1, hard: 2 };

// Words from the vocab deck that contain the kanji, best known first.
function knownWordsWith(kanji: string, db: Record<string, WordData>): WordData[] {
  return Object.values(db)
    .filter((w) => w.mastery !== 'unseen' && (w.surface ?? '').includes(kanji) && w.reading)
    .sort((a, b) =>
      (MASTERY_ORDER[a.mastery] ?? 3) - (MASTERY_ORDER[b.mastery] ?? 3)
      || (b.timesSeen ?? 0) - (a.timesSeen ?? 0)
      || (a.surface ?? '').length - (b.surface ?? '').length)
    .slice(0, MAX_KNOWN);
}

export function KanjiFlashcards({
  onFocusChange,
  onRemainingChange,
  onDone,
  topOffset = '0rem',
  focusKey,
}: {
  onFocusChange?: (focused: boolean) => void;
  onRemainingChange?: (remaining: number) => void;
  /** Offered on the finish screen ("単語へ"), when there are vocab cards waiting. */
  onDone?: () => void;
  topOffset?: string;
  /** Bumped each time the deck is opened from the deck rows: enter focus mode at once. */
  focusKey?: number;
}) {
  const review = useKanjiStore((s) => s.review);
  const progress = useKanjiStore((s) => s.progress);
  const wordDatabase = useAppStore((s) => s.wordDatabase);

  const [cards, setCards] = useState<SessionCard<KanjiCard>[]>(() => buildKanjiDeck());
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (focusKey) setFocused(true); }, [focusKey]);
  const [pick, setPick] = useState<Rating>(3);
  const thinkMs = useRef<number | null>(null);
  const shownAt = useRef(Date.now());

  // Card backs load lazily (about 120KB of readings and components).
  const [info, setInfo] = useState<Record<string, KanjiInfo> | null>(null);
  useEffect(() => {
    let live = true;
    import('../data/rtkKanjiInfo').then((m) => { if (live) setInfo(m.rtkKanjiInfo); });
    return () => { live = false; };
  }, []);

  // The app-open sync and the daily drip can land after mount (the session stays
  // mounted once opened): anything newly due that isn't in this run yet joins the
  // part still ahead, today's new kanji spread through it (mergeArrivals).
  const indexRef = useRef(index);
  indexRef.current = index;
  useEffect(() => {
    const fresh = buildKanjiDeck();
    setCards((cur) => mergeArrivals(cur, indexRef.current, fresh, (c) => c.kanji));
  }, [progress]);

  const total = cards.length;
  const card = cards[index];
  const inCardFlow = total > 0 && index < total;
  const focusActive = focused && inCardFlow;
  useEffect(() => { onRemainingChange?.(Math.max(0, total - index)); }, [total, index, onRemainingChange]);
  useEffect(() => { onFocusChange?.(focusActive); }, [focusActive, onFocusChange]);
  useEffect(() => () => onFocusChange?.(false), [onFocusChange]);

  useEffect(() => {
    shownAt.current = Date.now();
    thinkMs.current = null;
  }, [index, card?.kanji]);

  const known = useMemo(() => (card ? knownWordsWith(card.kanji, wordDatabase) : []), [card, wordDatabase]);

  function reveal() {
    const t = Date.now() - shownAt.current;
    thinkMs.current = t;
    setPick(defaultGrade(t, thinkHistory('kanji')));
    setRevealed(true);
  }

  // A grade tap and a card tap can both land for one card (the slider commits a
  // beat after its tap): only the first grades it.
  const gradedAt = useRef<number | null>(null);
  function grade(rating: Rating) {
    if (!card || gradedAt.current === index) return;
    gradedAt.current = index;
    // A repeat is practice: the first grade already set the schedule.
    if (!card.repeat) {
      if (thinkMs.current != null) recordThinkTime('kanji', thinkMs.current);
      review(card.kanji, rating, thinkMs.current, Date.now());
    }
    // もう一度 brings the kanji back a few cards later in this run.
    if (rating === 1) setCards((cur) => queueRepeat(cur, index));
    setRevealed(false);
    setIndex((i) => i + 1);
  }

  const flowStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    minHeight: `calc(100dvh - 5rem - ${topOffset})`,
    paddingTop: '0.5rem',
    paddingBottom: focusActive
      ? 'calc(1.25rem + env(safe-area-inset-bottom))'
      : 'calc(4.75rem + env(safe-area-inset-bottom))',
    boxSizing: 'border-box',
    transition: 'padding-bottom 0.4s cubic-bezier(0.22, 1, 0.36, 1)',
  };

  if (total === 0) {
    return (
      <Centered>
        <p className="serif" style={{ fontSize: '1.5rem', color: 'var(--text-main)', marginBottom: '0.5rem' }}>何もありません</p>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>No kanji due today.</p>
      </Centered>
    );
  }

  if (index >= total) {
    return (
      <Centered>
        <p className="serif" style={{ fontSize: '3rem', lineHeight: 1.15, color: 'var(--text-main)', letterSpacing: '0.08em' }}>完了</p>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '0.6rem' }}>
          {cards.filter((c) => !c.repeat).length} kanji today
        </p>
        {onDone && (
          <button
            onClick={onDone}
            className="serif"
            style={{
              marginTop: '2rem',
              padding: '0.7rem 1.6rem',
              border: 'none',
              borderRadius: '100px',
              backgroundColor: 'var(--bg-pure)',
              boxShadow: '0 4px 14px rgba(0,0,0,0.1)',
              color: 'var(--text-main)',
              fontSize: '1rem',
              cursor: 'pointer',
            }}
          >
            単語へ
          </button>
        )}
      </Centered>
    );
  }

  const keyword = rtkKanjiMap[card.kanji] ?? '';
  const [on, kun, parts] = info?.[card.kanji] ?? ['', '', ''];

  return (
    <div style={flowStyle} onClick={() => setFocused(false)}>
      <div style={{ marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.4rem' }}>
          <span style={{ fontSize: '0.7rem', letterSpacing: '0.08em', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
            {card.repeat ? 'Again' : card.kind === 'new' ? 'New' : 'Review'}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            {index + 1} / {total}
            {focusActive && <ExitFocusButton onClick={() => setFocused(false)} />}
          </span>
        </div>
        <div style={{ height: '3px', backgroundColor: 'var(--border-light)', borderRadius: '2px', overflow: 'hidden' }}>
          <motion.div
            style={{ height: '100%', backgroundColor: 'var(--accent-progress)' }}
            initial={false}
            animate={{ width: `${(index / total) * 100}%` }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          />
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: `1rem 1rem calc(1rem + ${PILE_SPACE})`, perspective: '1600px' }}>
        <div style={{ width: '100%', maxWidth: '340px' }}>
          <StudyCard
            cardKey={`${card.kanji}#${index}`}
            index={index}
            total={total}
            revealed={revealed}
            maxHeight={focusActive ? '74vh' : '62vh'}
            onClick={(e) => {
              e.stopPropagation();
              setFocused(true);
              if (!revealed) reveal();
              else grade(pick);
            }}
            front={
              // FRONT — the keyword to recall the kanji from.
              <CardFace>
                <span className="serif" style={{ fontSize: '2.3rem', lineHeight: 1.25, color: 'var(--text-main)', maxWidth: '12ch' }}>
                  {keyword}
                </span>
                <div style={{ position: 'absolute', bottom: '1.5rem', left: 0, right: 0, display: 'flex', justifyContent: 'center', color: 'var(--text-muted)', opacity: 0.35 }}>
                  <ChevronDown size={20} strokeWidth={1.5} />
                </div>
              </CardFace>
            }
            back={
              // BACK — kanji, keyword, readings, parts, then known words (no rule, no
              // title), centred above the slider and nudged up 6px. Sizes from the
              // tuning panel in docs/mockups/flashcard-feel-2.html.
              <CardFace back footer={<GradeSlider value={pick} onChange={setPick} onCommit={grade} />}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', transform: 'translateY(-6px)' }}>
                  <span className="serif" translate="no" style={{ fontSize: '7.2rem', lineHeight: 1, color: 'var(--text-main)' }}>
                    {card.kanji}
                  </span>
                  <span className="serif" style={{ fontSize: '1.2rem', color: 'var(--text-main)', marginTop: '0.6rem' }}>{keyword}</span>
                  {(on || kun) && (
                    <div style={{ display: 'flex', gap: '0.8rem', justifyContent: 'center', flexWrap: 'wrap', marginTop: '0.8rem', fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                      {on && <span>音 <span className="serif" style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-main)' }}>{on}</span></span>}
                      {kun && <span>訓 <span className="serif" style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-main)' }}>{kun}</span></span>}
                    </div>
                  )}
                  {parts && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.35rem' }}>{parts}</div>}
                  {known.length > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'center', gap: '1.2rem', flexWrap: 'wrap', marginTop: '1.6rem' }}>
                      {known.map((w) => <KnownWord key={w.surface} word={w} />)}
                    </div>
                  )}
                </div>
              </CardFace>
            }
          />
        </div>
      </div>
    </div>
  );
}

// A known word with furigana over its kanji and a short meaning underneath.
function KnownWord({ word }: { word: WordData }) {
  const meaning = (word.meaning ?? '').split(/[;,]/)[0].trim();
  return (
    <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', maxWidth: '7.5rem' }}>
      <span translate="no" className="serif" style={{ fontSize: '1.1rem', lineHeight: 1.2, color: 'var(--text-main)' }}>
        {furiganaSegments(word).map((s, i) =>
          s.kanji === s.kana
            ? <span key={i}>{s.kanji}</span>
            : (
              <ruby key={i}>
                {s.kanji}
                {/* Always shown: the reader's global rt style hides readings until tapped. */}
                <rt className="sans" style={{ fontSize: '0.55rem', fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.02em', opacity: 1, transform: 'none' }}>{s.kana}</rt>
              </ruby>
            ))}
      </span>
      <span className="sans" style={{ fontSize: '0.62rem', color: 'var(--text-muted)', lineHeight: 1.3, marginTop: '0.1rem', textAlign: 'center' }}>
        {meaning}
      </span>
    </span>
  );
}
