import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown, X } from 'lucide-react';
import { useAppStore, WordData, MasteryLevel } from '../services/store';
import { buildDeck, type Card } from '../services/dueDeck';
import type { Rating } from '../services/srs';
import { fetchIntakeCandidates } from '../services/jmdict';
import { alignReading, furiganaSegments } from '../services/furigana';
import type { IntakeCandidate } from '../services/intake';
import { seedDemoDeck } from '../services/devSeed';
import { GradeSlider } from './GradeSlider';
import { StudyCard, PILE_SPACE } from './StudyCard';
import { defaultGrade, recordThinkTime, thinkHistory } from '../services/thinkTime';

const DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true';

// Flashcard study UI (#70) — the deck view for the Word Mastery Loop. Reads the due
// deck from the store (selectDeck), shows a zen front/reveal card, and each grade
// (GradeSlider, then a tap on the card) calls store.reviewWord → advances the FSRS schedule
// (#67) and writes a `flashcard` review-log row. The deck is SNAPSHOTTED at mount
// (tab open) so grading a card doesn't reshuffle the pile underfoot.
// Once the deck is done, Discover mode (#113) offers a triage pass over unseen
// foundation words — same card surface, Hard/Medium/Easy pills.



// ── Discover mode (#113) ─────────────────────────────────────────────────────
// Once the day's deck is done, the user can optionally flip through UNSEEN
// foundation words (lowest JLPT level with unseen words, most common first —
// the same get_intake_candidates feed the daily promotion pass draws from) and
// triage each as Hard / Medium / Easy. Grades land via store.gradeDiscoverWord
// under Policy F: easy → far-out maintenance (never a "new" card); medium/hard
// → the intake queue, exactly as if graded from reading.
const DISCOVER_BATCH = 20;

const DISCOVER_GRADES: { level: Exclude<MasteryLevel, 'unseen'>; label: string; shadow: string }[] = [
  { level: 'hard',   label: 'Hard',   shadow: '0 3px 10px rgba(207, 125, 107, 0.30)' },
  { level: 'medium', label: 'Medium', shadow: '0 3px 10px rgba(194, 160, 88, 0.30)' },
  { level: 'easy',   label: 'Easy',   shadow: '0 3px 10px rgba(143, 170, 116, 0.32)' },
];

// Minimal display record for a Discover card — the word has no store entry yet,
// so the card renders straight off the candidate row. furiganaMap comes from the
// same aligner the enrichment path uses (jmdictToWordDetails), so the reading
// splits across kanji/okurigana exactly like a regular flashcard.
function wordForCandidate(c: IntakeCandidate): WordData {
  return {
    reading: c.reading,
    meaning: c.meaning,
    surface: c.word,
    furiganaMap: alignReading(c.word, c.reading),
    jlptLevel: c.jlptLevel,
    jmdictEntryId: c.entryId,
    freqRank: c.freqRank,
    mastery: 'unseen',
    timesSeen: 0,
    uniqueDaysSeen: [],
    lastSeenTs: 0,
    streak: 0,
  };
}

export function Flashcards({
  onFocusChange,
  onRemainingChange,
  topOffset = '0rem',
}: {
  onFocusChange?: (focused: boolean) => void;
  // Due cards left in this run — drives the 復習 badge in REVIEW.
  onRemainingChange?: (remaining: number) => void;
  // Height of chrome REVIEW renders above the card flow (its segmented control),
  // subtracted from the flow's min-height so the page doesn't scroll.
  topOffset?: string;
}) {
  const reviewWord = useAppStore((s) => s.reviewWord);
  const gradeDiscoverWord = useAppStore((s) => s.gradeDiscoverWord);
  const jlptLevel = useAppStore((s) => s.jlptLevel);

  // Snapshot the deck once, at mount. Flashcards mounts when the tab opens, so this
  // is "the deck as of opening REVIEW" and stays stable while the user works through it.
  const [cards, setCards] = useState<Card[]>(buildDeck);

  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  // The grade slider's position, and how long the front was looked at before the
  // flip: the slider starts on a grade guessed from that time (thinkTime.ts).
  const [pick, setPick] = useState<Rating>(3);
  const thinkMs = useRef<number | null>(null);
  const shownAt = useRef(Date.now());

  // Focus mode: the first tap into a card hides the bottom nav (reported up via
  // onFocusChange) and the card grows into the reclaimed space. Sticky across
  // cards for the rest of the run; it releases when the run ends (finish card,
  // Discover summary, empty deck) so the nav is back for onward navigation.
  const [focused, setFocused] = useState(false);

  // Discover mode (#113). Non-null = in Discover; [] while loading or exhausted.
  const [discoverCards, setDiscoverCards] = useState<IntakeCandidate[] | null>(null);
  const [discoverIndex, setDiscoverIndex] = useState(0);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [discoveredCount, setDiscoveredCount] = useState(0); // triaged this session

  async function startDiscover() {
    if (discoverLoading) return;
    setDiscoverLoading(true);
    setDiscoverCards([]);
    setDiscoverIndex(0);
    setRevealed(false);
    setFocused(false); // each run re-enters focus on its first card tap
    const s = useAppStore.getState();
    const seenIds = Object.values(s.wordDatabase)
      .map((w) => w.jmdictEntryId)
      .filter((id): id is string => !!id);
    const cands = s.jlptLevel != null
      ? await fetchIntakeCandidates(s.jlptLevel, seenIds, DISCOVER_BATCH)
      : [];
    // Belt-and-braces: drop anything that gained a local record while fetching.
    const db = useAppStore.getState().wordDatabase;
    setDiscoverCards(cands.filter((c) => !db[c.entryId]));
    setDiscoverLoading(false);
  }

  function gradeDiscover(level: Exclude<MasteryLevel, 'unseen'>) {
    const c = discoverCards?.[discoverIndex];
    if (!c) return;
    gradeDiscoverWord(c, level);
    setDiscoveredCount((n) => n + 1);
    setRevealed(false);
    setDiscoverIndex((i) => i + 1);
  }

  // The app-open promotion pass (sync → promoteIntakeQueue) is async and can land
  // AFTER this tab mounted with an empty deck. While the deck is empty, rebuild the
  // snapshot whenever words change so freshly promoted cards surface without a
  // tab-away round trip. Once a deck exists it stays snapshotted (no reshuffling).
  const wordDatabase = useAppStore((s) => s.wordDatabase);
  useEffect(() => {
    if (cards.length > 0) return;
    // In Discover mode every grade touches wordDatabase; skip the rebuild churn —
    // Discover grades never mint due cards (far-out maintenance or queued).
    if (discoverCards != null) return;
    const fresh = buildDeck();
    if (fresh.length > 0) {
      setCards(fresh);
      setIndex(0);
      setRevealed(false);
    }
  }, [cards.length, wordDatabase, discoverCards]);

  // Dev-only: seed a demo deck, then rebuild the snapshot in place (no reload).
  function seedAndReload() {
    seedDemoDeck();
    setCards(buildDeck());
    setIndex(0);
    setRevealed(false);
  }
  const total = cards.length;
  const card = cards[index];

  // Focus is only real while a card is actually on screen — the summary/empty
  // states always get the nav back, whatever `focused` says.
  const inCardFlow =
    discoverCards != null
      ? !discoverLoading && discoverIndex < discoverCards.length && discoverCards.length > 0
      : total > 0 && index < total;
  const focusActive = focused && inCardFlow;
  useEffect(() => {
    onRemainingChange?.(Math.max(0, total - index));
  }, [total, index, onRemainingChange]);
  useEffect(() => {
    onFocusChange?.(focusActive);
  }, [focusActive, onFocusChange]);
  // Leaving the tab unmounts this component — always hand the nav back.
  useEffect(() => () => onFocusChange?.(false), [onFocusChange]);

  // Card-flow wrapper: in focus mode the nav-reserving bottom padding collapses
  // and the card (FlipSurface `tall`) grows into the space.
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

  // Each new card starts its thinking clock when it appears.
  useEffect(() => {
    shownAt.current = Date.now();
    thinkMs.current = null;
  }, [card?.key]);

  function reveal() {
    const t = Date.now() - shownAt.current;
    thinkMs.current = t;
    setPick(defaultGrade(t, thinkHistory('vocab')));
    setRevealed(true);
  }

  function grade(rating: Rating) {
    if (!card) return;
    if (thinkMs.current != null) recordThinkTime('vocab', thinkMs.current);
    reviewWord(card.key, rating, Date.now());
    setRevealed(false);
    setIndex((i) => i + 1);
  }

  // Offered only once the due deck is done (the empty and complete states below) —
  // Discover augments a finished session, it never competes with due reviews.
  const discoverEntry = jlptLevel != null && (
    <>
      <button
        onClick={startDiscover}
        style={{
          marginTop: '1.75rem',
          padding: '0.6rem 1.5rem',
          border: '1px solid var(--border-light)',
          borderRadius: '999px',
          backgroundColor: 'var(--bg-pure)',
          boxShadow: '0 3px 10px rgba(0, 0, 0, 0.05)',
          color: 'var(--text-main)',
          fontSize: '0.85rem',
          fontWeight: 600,
          letterSpacing: '0.02em',
          cursor: 'pointer',
        }}
      >
        Discover new words
      </button>
      <p style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
        Triage common words you haven't met yet
      </p>
    </>
  );

  // ── Discover mode (#113) ────────────────────────────────────────────────
  if (discoverCards != null) {
    if (discoverLoading) {
      return (
        <Centered>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>Gathering new words…</p>
        </Centered>
      );
    }
    const dTotal = discoverCards.length;
    if (dTotal === 0) {
      return (
        <Centered>
          <p className="serif" style={{ fontSize: '1.5rem', color: 'var(--text-main)', marginBottom: '0.5rem' }}>
            見つかりません
          </p>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            Nothing left to discover at your level.
          </p>
          <ExitDiscoverButton onClick={() => setDiscoverCards(null)} />
        </Centered>
      );
    }
    if (discoverIndex >= dTotal) {
      return (
        <Centered>
          <p className="serif" style={{ fontSize: '1.5rem', color: 'var(--text-main)', marginBottom: '0.5rem' }}>
            お疲れさま
          </p>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', maxWidth: '32ch', lineHeight: 1.6 }}>
            {discoveredCount} new {discoveredCount === 1 ? 'word' : 'words'} triaged — hard and medium ones will drip into your deck.
          </p>
          <button
            onClick={startDiscover}
            style={{
              marginTop: '1.75rem',
              padding: '0.6rem 1.5rem',
              border: '1px solid var(--border-light)',
              borderRadius: '999px',
              backgroundColor: 'var(--bg-pure)',
              boxShadow: '0 3px 10px rgba(0, 0, 0, 0.05)',
              color: 'var(--text-main)',
              fontSize: '0.85rem',
              fontWeight: 600,
              letterSpacing: '0.02em',
              cursor: 'pointer',
            }}
          >
            Discover more
          </button>
          <ExitDiscoverButton onClick={() => setDiscoverCards(null)} />
        </Centered>
      );
    }

    const cand = discoverCards[discoverIndex];
    return (
      <div style={flowStyle} onClick={() => setFocused(false)}>
        {/* Progress */}
        <div style={{ marginBottom: '1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.4rem' }}>
            <span style={{ fontSize: '0.7rem', letterSpacing: '0.08em', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
              Discover
            </span>
            <span style={{ display: 'flex', alignItems: 'center', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              {discoverIndex + 1} / {dTotal}
              {focusActive && <ExitFocusButton onClick={() => setFocused(false)} />}
            </span>
          </div>
          <div style={{ height: '3px', backgroundColor: 'var(--border-light)', borderRadius: '2px', overflow: 'hidden' }}>
            <motion.div
              style={{ height: '100%', backgroundColor: 'var(--accent-progress)' }}
              initial={false}
              animate={{ width: `${(discoverIndex / dTotal) * 100}%` }}
              transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            />
          </div>
        </div>

        <FlipSurface
          cardKey={cand.entryId}
          index={discoverIndex}
          total={dTotal}
          word={wordForCandidate(cand)}
          revealed={revealed}
          tall={focusActive}
          onTap={() => setFocused(true)}
          onReveal={() => setRevealed(true)}
          footer={
            <div onPointerDown={(e) => e.stopPropagation()} style={{ display: 'flex', flexShrink: 0, gap: '9px', padding: '0 1.1rem 1.6rem' }}>
              {DISCOVER_GRADES.map(({ level, label, shadow }) => (
                <button
                  key={level}
                  onClick={() => gradeDiscover(level)}
                  style={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '0.75rem 0',
                    border: '1px solid var(--border-light)',
                    borderRadius: '999px',
                    backgroundColor: 'var(--bg-pure)',
                    boxShadow: shadow,
                    color: 'var(--text-main)',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>{label}</span>
                </button>
              ))}
            </div>
          }
        />
      </div>
    );
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
        {discoverEntry}
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

  // ── Deck complete — the 完了 finish card ─────────────────────────────────
  // Sits in the same card flow as the deck (full progress bar above it); flips
  // to the day's stats with Discover as the only onward action.
  if (index >= total) {
    return (
      <div style={flowStyle} onClick={() => setFocused(false)}>
        <div style={{ marginBottom: '1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.4rem' }}>
            <span style={{ fontSize: '0.7rem', letterSpacing: '0.08em', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
              Review
            </span>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{total} / {total}</span>
          </div>
          <div style={{ height: '3px', backgroundColor: 'var(--border-light)', borderRadius: '2px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: '100%', backgroundColor: 'var(--accent-progress)' }} />
          </div>
        </div>
        <FinishCard sessionCount={total} onDiscover={jlptLevel != null ? startDiscover : undefined} />
      </div>
    );
  }

  return (
    <div style={flowStyle} onClick={() => setFocused(false)}>
      {/* Progress */}
      <div style={{ marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.4rem' }}>
          <span style={{ fontSize: '0.7rem', letterSpacing: '0.08em', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
            {card.kind === 'new' ? 'New' : 'Review'}
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

      <FlipSurface
        cardKey={card.key}
        index={index}
        total={total}
        word={card.word}
        revealed={revealed}
        tall={focusActive}
        onTap={() => setFocused(true)}
        onReveal={reveal}
        onAdvance={() => grade(pick)}
        footer={<GradeSlider value={pick} onChange={setPick} />}
      />
    </div>
  );
}

// Focus mode's explicit way out (tapping beside the card also works, but the
// card fills nearly the whole screen). Sits after the count in the progress row;
// the negative margins give it a thumb-sized target without moving the row.
export function ExitFocusButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      aria-label="Exit focus mode"
      style={{
        display: 'flex',
        margin: '-0.7rem -0.7rem -0.7rem 0.35rem',
        padding: '0.7rem',
        border: 'none',
        background: 'none',
        color: 'var(--text-muted)',
        cursor: 'pointer',
      }}
    >
      <X size={15} strokeWidth={1.5} />
    </button>
  );
}

// Quiet exit link for the Discover screens — returns to the deck's summary state.
function ExitDiscoverButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        marginTop: '1rem',
        padding: '0.45rem 1rem',
        border: 'none',
        background: 'none',
        color: 'var(--text-muted)',
        fontSize: '0.8rem',
        letterSpacing: '0.02em',
        cursor: 'pointer',
      }}
    >
      Done
    </button>
  );
}

// The single FIXED-HEIGHT flip surface, shared by the due deck and Discover mode.
// The grade buttons live INSIDE the back face (passed as `footer`), as a strip
// along its bottom edge — so flipping never changes the card's height or shifts
// the layout, and the buttons arrive with the flip itself (no second animation).
function FlipSurface({ cardKey, index, total, word, revealed, onReveal, onAdvance, onTap, footer, tall = false }: {
  cardKey: string;
  index: number; // position in the session and its length: the pile under the card shows what's left
  total: number;
  word: WordData;
  revealed: boolean;
  onReveal: () => void;
  onAdvance?: () => void; // a tap on the revealed card: grade with the slider's value and move on
  onTap?: () => void; // fires on ANY in-card tap (even revealed) — re-enters focus
  footer: React.ReactNode;
  tall?: boolean; // focus mode: grow into the space the hidden nav frees up
}) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: `1rem 1rem calc(1rem + ${PILE_SPACE})`, perspective: '1600px' }}>
      <div style={{ width: '100%', maxWidth: '340px' }}>
        {/* Capped in px but scaled by vh so it never tucks under the nav.
            Clicks stop at the card: anything outside it (the flow wrapper)
            exits focus mode, so in-card taps must not bubble that far. */}
        <StudyCard
          cardKey={cardKey}
          index={index}
          total={total}
          revealed={revealed}
          height={tall ? 'min(660px, 74vh)' : 'min(540px, 62vh)'}
          cursor={revealed && !onAdvance ? 'default' : 'pointer'}
          onClick={(e) => {
            e.stopPropagation();
            onTap?.();
            if (!revealed) onReveal();
            else onAdvance?.();
          }}
          front={
            // FRONT — the word to recall (furigana hidden), with a subtle flip hint.
            <CardFace>
              <FuriganaWord word={word} reveal={false} />
              <div style={{ position: 'absolute', bottom: '1.5rem', left: 0, right: 0, display: 'flex', justifyContent: 'center', color: 'var(--text-muted)', opacity: 0.35 }}>
                <ChevronDown size={20} strokeWidth={1.5} />
              </div>
            </CardFace>
          }
          back={
            // BACK — reading (furigana) + meaning + grammar note + JLPT level,
            // with the grade slider along the bottom edge.
            <CardFace back footer={footer}>
              <FuriganaWord word={word} reveal={true} />
              <div style={{ fontSize: '1.1rem', color: 'var(--text-main)', marginTop: '1.5rem', lineHeight: 1.6, maxWidth: '28ch' }}>
                {word.meaning}
              </div>
              {word.grammarNote && (
                <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '1rem', lineHeight: 1.6, maxWidth: '30ch' }}>
                  {word.grammarNote}
                </div>
              )}
              {/* Plain text (no pill chrome) — a pill here would read as an extra
                  button now that the grade slider shares the card. */}
              {word.jlptLevel != null && (
                <span
                  className="sans"
                  title={word.jlptDerived ? 'Approximate level (inferred from kanji / frequency)' : undefined}
                  style={{
                    marginTop: '1.5rem',
                    fontSize: '0.7rem',
                    fontWeight: 800,
                    letterSpacing: '0.04em',
                    color: '#4a5d23',
                    opacity: 0.85,
                  }}
                >
                  {word.jlptDerived ? '≈' : ''}N{word.jlptLevel}
                </span>
              )}
            </CardFace>
          }
        />
      </div>
    </div>
  );
}

// ── Finish card ──────────────────────────────────────────────────────────────
// Shown when the day's deck is done: the same quiet card surface as the
// flashcards, with 完了 on the front. Tapping flips it to a small stats panel
// for the day, with Discover as the only onward action.
function FinishCard({ sessionCount, onDiscover }: { sessionCount: number; onDiscover?: () => void }) {
  const [revealed, setRevealed] = useState(false);
  const reviewsByDay = useAppStore((s) => s.reviewsByDay);

  // Same UTC day key the store stamps reviewsByDay with.
  const dayKey = (ms: number) => new Date(ms).toISOString().split('T')[0];
  const todayReviews = reviewsByDay[dayKey(Date.now())] ?? 0;
  // Consecutive review days ending today.
  let streak = 0;
  for (let ms = Date.now(); (reviewsByDay[dayKey(ms)] ?? 0) > 0; ms -= 86_400_000) streak += 1;

  const stats = [
    { value: sessionCount, label: sessionCount === 1 ? 'card' : 'cards' },
    { value: todayReviews, label: 'today' },
    { value: streak, label: streak === 1 ? 'day' : 'days' },
  ];

  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', perspective: '1600px' }}>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: [0.22, 1, 0.36, 1] } }}
        style={{ width: '100%', maxWidth: '340px' }}
      >
        <motion.div
          onClick={() => !revealed && setRevealed(true)}
          initial={false}
          animate={{ rotateY: revealed ? 180 : 0 }}
          transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
          style={{
            position: 'relative',
            width: '100%',
            height: 'min(540px, 62vh)',
            transformStyle: 'preserve-3d',
            cursor: revealed ? 'default' : 'pointer',
          }}
        >
          {/* FRONT — 完了, nothing else. */}
          <CardFace>
            <span
              className="serif"
              translate="no"
              style={{ fontSize: '3.4rem', lineHeight: 1.15, color: 'var(--text-main)', letterSpacing: '0.08em' }}
            >
              完了
            </span>
            <span
              className="sans"
              style={{
                marginTop: '1.2rem',
                fontSize: '0.7rem',
                fontWeight: 600,
                letterSpacing: '0.28em',
                textTransform: 'uppercase',
                color: 'var(--text-muted)',
              }}
            >
              Complete
            </span>
            <div style={{ position: 'absolute', bottom: '1.5rem', left: 0, right: 0, display: 'flex', justifyContent: 'center', color: 'var(--text-muted)', opacity: 0.35 }}>
              <ChevronDown size={20} strokeWidth={1.5} />
            </div>
          </CardFace>

          {/* BACK — today's numbers, then Discover. */}
          <CardFace
            back
            footer={
              onDiscover && (
                <div style={{ flexShrink: 0, display: 'flex', justifyContent: 'center', padding: '0 1.1rem 1.35rem' }}>
                  <button
                    onClick={onDiscover}
                    style={{
                      padding: '0.7rem 1.6rem',
                      border: '1px solid var(--border-light)',
                      borderRadius: '999px',
                      backgroundColor: 'var(--bg-pure)',
                      boxShadow: '0 3px 10px rgba(143, 170, 116, 0.32)',
                      color: 'var(--text-main)',
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      letterSpacing: '0.02em',
                      cursor: 'pointer',
                    }}
                  >
                    Discover new words
                  </button>
                </div>
              )
            }
          >
            <span className="serif" translate="no" style={{ fontSize: '1.4rem', color: 'var(--text-main)' }}>
              お疲れさま
            </span>
            <div style={{ display: 'flex', gap: '2.4rem', marginTop: '2.25rem' }}>
              {stats.map((s) => (
                <div key={s.label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.45rem' }}>
                  <span className="serif" style={{ fontSize: '1.8rem', lineHeight: 1, color: 'var(--text-main)' }}>
                    {s.value}
                  </span>
                  <span className="sans" style={{ fontSize: '0.65rem', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
                    {s.label}
                  </span>
                </div>
              ))}
            </div>
            <span className="sans" style={{ marginTop: '1.4rem', fontSize: '0.72rem', color: 'var(--text-muted)', letterSpacing: '0.02em' }}>
              {streak > 1 ? `${streak} days in a row — keep it going.` : 'Every review counts.'}
            </span>
          </CardFace>
        </motion.div>
      </motion.div>
    </div>
  );
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

// One face of the flip card — a white card surface lifted by layered soft shadows
// (.study-face, no border). Both faces stack via absolute positioning; the back is
// pre-rotated 180° so it reads correctly once the card flips. `backface-visibility:
// hidden` hides whichever face currently points away from the viewer. `footer`
// renders along the face's bottom edge, outside the content padding (the grade
// strip); the content centres in the space above it.
export function CardFace({ children, back = false, footer }: { children: React.ReactNode; back?: boolean; footer?: React.ReactNode }) {
  return (
    <div
      className="study-face"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'var(--bg-pure)',
        borderRadius: '22px',
        backfaceVisibility: 'hidden',
        WebkitBackfaceVisibility: 'hidden',
        transform: back ? 'rotateY(180deg)' : undefined,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          flex: 1,
          minHeight: 0,
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          padding: footer ? '1.6rem 1.75rem 1rem' : '2rem 1.75rem',
        }}
      >
        {children}
      </div>
      {footer}
    </div>
  );
}

// Shared centered layout for the empty / complete states.
export function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', minHeight: '60vh' }}>
      {children}
    </div>
  );
}
