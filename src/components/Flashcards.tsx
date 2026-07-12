import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import { useAppStore, WordData } from '../services/store';
import { selectDeck, DeckEntry } from '../services/deck';
import { schedule, seedSrsFromDifficulty, type Rating, type SrsState } from '../services/srs';
import { seedDemoDeck } from '../services/devSeed';

const DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true';

// Flashcard study UI (#70) — the deck view for the Word Mastery Loop. Reads the due
// deck from the store (selectDeck), shows a zen front/reveal card, and each
// Again/Hard/Good/Easy grade calls store.reviewWord → advances the FSRS schedule
// (#67) and writes a `flashcard` review-log row. The deck is SNAPSHOTTED at mount
// (tab open) so grading a card doesn't reshuffle the pile underfoot.

// Grade color is carried by a small dot (not a full fill) so the buttons read as
// part of the card's white/hairline aesthetic while keeping the red→green
// traffic-light cue. Dots are muted tones from the same palette family.
const RATINGS: { rating: Rating; label: string; dot: string }[] = [
  { rating: 1, label: 'Again', dot: '#cf7d6b' },
  { rating: 2, label: 'Hard', dot: '#c2a058' },
  { rating: 3, label: 'Good', dot: '#8fb0c4' },
  { rating: 4, label: 'Easy', dot: '#8faa74' },
];

// A card carries the full word plus which source (due review / new) put it here.
interface Card {
  key: string;
  word: WordData;
  kind: 'review' | 'new';
}

// Prior FSRS state for a word, or a seed from `difficulty` if it isn't scheduled
// yet — mirrors store.reviewWord so the per-button interval preview matches what a
// grade will actually assign.
function priorSrsFor(w: WordData, now: number): SrsState {
  const baseDifficulty = w.difficulty ?? 5;
  return w.stability != null && w.dueAt != null
    ? {
        stability: w.stability,
        fsrsDifficulty: w.fsrsDifficulty ?? baseDifficulty,
        dueAt: w.dueAt,
        lastReviewedAt: w.lastReviewedTs ?? w.lastSeenTs ?? now,
        reps: w.reps ?? 0,
        lapses: w.lapses ?? 0,
        status: (w.srsStatus ?? 'review') as SrsState['status'],
      }
    : seedSrsFromDifficulty(baseDifficulty, w.lastSeenTs ?? now);
}

// Snapshot the current due deck from the store: map every word to a DeckEntry,
// run selectDeck, and rehydrate each surviving key back to its full WordData.
function buildDeck(): Card[] {
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

// Human-friendly interval label, Anki-style ("10m" / "3d" / "2mo" / "1.4y").
function formatInterval(days: number): string {
  if (days < 1) {
    const mins = Math.max(1, Math.round(days * 24 * 60));
    return mins < 60 ? `${mins}m` : `${Math.round(days * 24)}h`;
  }
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

export function Flashcards() {
  const reviewWord = useAppStore((s) => s.reviewWord);

  // Snapshot the deck once, at mount. Flashcards mounts when the tab opens, so this
  // is "the deck as of opening STUDY" and stays stable while the user works through it.
  const [cards, setCards] = useState<Card[]>(buildDeck);

  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);

  // Dev-only: seed a demo deck, then rebuild the snapshot in place (no reload).
  function seedAndReload() {
    seedDemoDeck();
    setCards(buildDeck());
    setIndex(0);
    setRevealed(false);
  }
  const total = cards.length;
  const card = cards[index];

  // Interval each rating would assign, previewed against the current card's schedule.
  const previews = useMemo(() => {
    if (!card) return {} as Record<Rating, string>;
    const now = Date.now();
    // A never-studied "new" card previews from a fresh FSRS card (State.New) so the
    // grades ladder (Again→Easy) instead of bunching around the synthetic
    // difficulty-seed stability that promotion writes as status 'review'. Review
    // cards preview from their real prior schedule. Mirrors store.reviewWord.
    const prior = card.kind === 'new' ? null : priorSrsFor(card.word, now);
    const out = {} as Record<Rating, string>;
    for (const { rating } of RATINGS) out[rating] = formatInterval(schedule(prior, rating, now).intervalDays);
    return out;
  }, [card]);

  function grade(rating: Rating) {
    if (!card) return;
    reviewWord(card.key, rating, Date.now());
    setRevealed(false);
    setIndex((i) => i + 1);
  }

  // ── Empty deck ──────────────────────────────────────────────────────────
  if (total === 0) {
    return (
      <Centered>
        <p className="serif" style={{ fontSize: '1.5rem', color: 'var(--text-main)', marginBottom: '0.5rem' }}>
          何もありません
        </p>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          You're all caught up — nothing due today.
        </p>
        {DEV_MODE && (
          <button
            onClick={seedAndReload}
            style={{
              marginTop: '1.5rem',
              padding: '0.5rem 1rem',
              border: '1px dashed var(--border-light)',
              borderRadius: '10px',
              background: 'none',
              color: 'var(--text-muted)',
              fontSize: '0.75rem',
              letterSpacing: '0.04em',
              cursor: 'pointer',
            }}
          >
            🛠 Seed demo deck
          </button>
        )}
      </Centered>
    );
  }

  // ── Deck complete ───────────────────────────────────────────────────────
  if (index >= total) {
    return (
      <Centered>
        <p className="serif" style={{ fontSize: '1.5rem', color: 'var(--text-main)', marginBottom: '0.5rem' }}>
          お疲れさま
        </p>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          Deck complete — {total} {total === 1 ? 'card' : 'cards'} reviewed.
        </p>
      </Centered>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 'calc(100dvh - 5rem)', paddingTop: '0.5rem', paddingBottom: 'calc(4.75rem + env(safe-area-inset-bottom))', boxSizing: 'border-box' }}>
      {/* Progress */}
      <div style={{ marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.4rem' }}>
          <span style={{ fontSize: '0.7rem', letterSpacing: '0.08em', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
            {card.kind === 'new' ? 'New' : 'Review'}
          </span>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{index + 1} / {total}</span>
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

      {/* Card + grade group — the FRONT card grows down into the button zone so the
          flip target sits where the thumb already rests. On flip the card shrinks
          up and the grade buttons slide into the space it vacated. Both live in one
          centered column so the whole unit stays put. */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', perspective: '1600px' }}>
        <AnimatePresence mode="wait">
          {/* Outer wrapper handles the between-cards slide/fade. */}
          <motion.div
            key={card.key}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: [0.22, 1, 0.36, 1] } }}
            exit={{ opacity: 0, y: -10, transition: { duration: 0.11, ease: 'easeIn' } }}
            style={{ width: '100%', maxWidth: '340px', display: 'flex', flexDirection: 'column' }}
          >
            {/* Inner element rotates in 3D — front and back are its two faces. Its
                height shrinks on reveal (540→440) to open room for the buttons. */}
            <motion.div
              onClick={() => !revealed && setRevealed(true)}
              initial={false}
              animate={{ rotateY: revealed ? 180 : 0 }}
              transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
              style={{
                position: 'relative',
                width: '100%',
                // Front grows into the button zone; shrinks on reveal. Capped in px but
                // scaled by vh so it never tucks under the nav on short screens.
                // (Height rides a CSS transition since framer can't tween a min() calc.)
                height: revealed ? 'min(440px, 50vh)' : 'min(540px, 62vh)',
                transition: 'height 0.55s cubic-bezier(0.22, 1, 0.36, 1)',
                transformStyle: 'preserve-3d',
                cursor: revealed ? 'default' : 'pointer',
              }}
            >
              {/* FRONT — the word to recall (furigana hidden), with a subtle flip hint. */}
              <CardFace>
                <FuriganaWord word={card.word} reveal={false} />
                <div style={{ position: 'absolute', bottom: '1.5rem', left: 0, right: 0, display: 'flex', justifyContent: 'center', color: 'var(--text-muted)', opacity: 0.35 }}>
                  <ChevronDown size={20} strokeWidth={1.5} />
                </div>
              </CardFace>

              {/* BACK — reading (furigana) + meaning + grammar note + JLPT pill. */}
              <CardFace back>
                <FuriganaWord word={card.word} reveal={true} />
                <div style={{ fontSize: '1.1rem', color: 'var(--text-main)', marginTop: '1.5rem', lineHeight: 1.6, maxWidth: '28ch' }}>
                  {card.word.meaning}
                </div>
                {card.word.grammarNote && (
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '1rem', lineHeight: 1.6, maxWidth: '30ch' }}>
                    {card.word.grammarNote}
                  </div>
                )}
                {card.word.jlptLevel != null && (
                  <span
                    className="sans"
                    title={card.word.jlptDerived ? 'Approximate level (inferred from kanji / frequency)' : undefined}
                    style={{
                      marginTop: '1.5rem',
                      padding: '0.25rem 0.75rem',
                      border: '1px solid var(--border-light)',
                      borderRadius: '999px',
                      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.05)',
                      fontSize: '0.7rem',
                      fontWeight: 800,
                      letterSpacing: '0.04em',
                      color: '#4a5d23',
                      opacity: 0.85,
                    }}
                  >
                    {card.word.jlptDerived ? '≈' : ''}N{card.word.jlptLevel}
                  </span>
                )}
              </CardFace>
            </motion.div>

            {/* Grade buttons — slide into the space the shrinking card vacated,
                so they land right under the thumb that just tapped to flip. */}
            <AnimatePresence>
              {revealed && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, delay: 0.18, ease: [0.22, 1, 0.36, 1] }}
                  style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}
                >
                  {RATINGS.map(({ rating, label, dot }) => (
                <button
                  key={rating}
                  onClick={() => grade(rating)}
                  style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '0.3rem',
                    padding: '0.7rem 0.25rem',
                    border: '1px solid var(--border-light)',
                    borderRadius: '14px',
                    backgroundColor: 'var(--bg-pure)',
                    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.05)',
                    color: 'var(--text-main)',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.85rem', fontWeight: 600 }}>
                    <span style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: dot }} />
                    {label}
                  </span>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{previews[rating]}</span>
                </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

// Furigana segments for the card face. Prefers the word's `furiganaMap` (per-kanji
// readings from enrichment), heals a map that doesn't cover the whole surface, and
// falls back to one reading over the whole word — mirroring WordModal so the deck
// and the lookup modal position furigana the same way.
function furiganaSegments(w: WordData): { kanji: string; kana: string }[] {
  const surface = w.surface || w.reading || '';
  let segments = w.furiganaMap ?? [];
  const mapped = segments.map((s) => s.kanji).join('');
  if (mapped !== surface && surface.startsWith(mapped)) {
    const tail = Array.from(surface.slice(mapped.length)).map((c) => ({ kanji: c, kana: c }));
    segments = [...segments, ...tail];
  }
  if (segments.length > 0) return segments;
  // No map: one reading over the whole surface (kana shown above the run).
  return [{ kanji: surface, kana: w.reading || surface }];
}

// Renders the word with furigana positioned above each kanji (like the lookup
// modal). The ruby row's height is reserved even when hidden, so revealing the
// reading doesn't shift the kanji — it just fades in above them.
function FuriganaWord({ word, reveal }: { word: WordData; reveal: boolean }) {
  const segments = furiganaSegments(word);
  return (
    <div translate="no" style={{ display: 'inline-flex', gap: '0.12em', alignItems: 'flex-end', justifyContent: 'center' }}>
      {segments.map((s, i) => {
        const isKana = s.kanji === s.kana; // pure-kana run: nothing to annotate
        return (
          <span key={i} style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center' }}>
            <span
              style={{
                height: '1.3rem',
                fontSize: '1.05rem',
                lineHeight: 1,
                color: 'var(--text-muted)',
                fontFamily: 'var(--font-sans)',
                fontWeight: 700,
                letterSpacing: '0.02em',
                opacity: reveal && !isKana ? 1 : 0,
                transition: 'opacity 0.3s ease',
              }}
            >
              {s.kana}
            </span>
            <span className="serif" style={{ fontSize: '3rem', lineHeight: 1.1, color: 'var(--text-main)' }}>
              {s.kanji}
            </span>
          </span>
        );
      })}
    </div>
  );
}

// One face of the flip card — a minimal white card surface (hairline border, soft
// shadow). Both faces stack via absolute positioning; the back is pre-rotated 180°
// so it reads correctly once the card flips. `backface-visibility: hidden` hides
// whichever face currently points away from the viewer.
function CardFace({ children, back = false }: { children: React.ReactNode; back?: boolean }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: '2rem 1.75rem',
        backgroundColor: 'var(--bg-pure)',
        border: '1px solid var(--border-light)',
        borderRadius: '22px',
        boxShadow: '0 6px 24px rgba(0, 0, 0, 0.05)',
        backfaceVisibility: 'hidden',
        WebkitBackfaceVisibility: 'hidden',
        transform: back ? 'rotateY(180deg)' : undefined,
        overflow: 'hidden',
      }}
    >
      {children}
    </div>
  );
}

// Shared centered layout for the empty / complete states.
function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', minHeight: '60vh' }}>
      {children}
    </div>
  );
}
