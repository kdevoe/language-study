import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore, WordData, MasteryLevel } from '../services/store';
import { fetchJlptTotals, fetchUnseenCommonWords, UnseenWord } from '../services/jmdict';

// Mastery palette mirrors the generated vocab-summary report so the in-app
// dashboard shares the same earthy, muted language as the rest of Yūgen.
// Note: the 'unseen' bucket means "encountered but not yet graded" — shown as
// "Ungraded" so it doesn't clash with corpus-unseen (never encountered) words.
const MASTERY: { key: MasteryLevel; label: string; color: string }[] = [
  { key: 'easy', label: 'Easy', color: '#5b8c5a' },
  { key: 'medium', label: 'Medium', color: '#c79a3f' },
  { key: 'hard', label: 'Hard', color: '#c77b4a' },
  { key: 'unseen', label: 'Ungraded', color: '#cfc9bd' },
];

const MASTERY_COLOR: Record<MasteryLevel, string> = {
  easy: '#5b8c5a',
  medium: '#c79a3f',
  hard: '#c77b4a',
  unseen: '#cfc9bd',
};

// Donut buckets = the four mastery buckets plus 'notSeen': words in the level's
// corpus the user has never encountered. This replaces the old coverage bar —
// the donut now represents ALL words at the level, seen or not.
type BucketKey = MasteryLevel | 'notSeen';
const BUCKETS: { key: BucketKey; label: string; color: string }[] = [
  ...MASTERY,
  { key: 'notSeen', label: 'Unseen', color: 'var(--border-light)' },
];
const BUCKET_COLOR: Record<BucketKey, string> = {
  ...MASTERY_COLOR,
  notSeen: 'var(--border-light)',
};
const BUCKET_ORDER: BucketKey[] = ['easy', 'medium', 'hard', 'unseen', 'notSeen'];

const emptyBuckets = (): Record<BucketKey, number> => ({
  easy: 0,
  medium: 0,
  hard: 0,
  unseen: 0,
  notSeen: 0,
});

// JLPT numbering: 5 = N5 (easiest) ... 1 = N1 (hardest). `'other'` collects
// words JMDict has no JLPT tag for.
type LevelKey = number | 'other';
const LEVELS: { value: LevelKey; label: string; note?: string }[] = [
  { value: 5, label: 'N5', note: 'easiest' },
  { value: 4, label: 'N4' },
  { value: 3, label: 'N3' },
  { value: 2, label: 'N2' },
  { value: 1, label: 'N1', note: 'hardest' },
  { value: 'other', label: 'Other' },
];

const levelKeyFor = (w: WordData): LevelKey =>
  w.jlptLevel == null ? 'other' : w.jlptLevel;

const masteryOf = (w: WordData): MasteryLevel => w.mastery || 'unseen';

interface WordRow extends WordData {
  word: string;   // display surface (the map key is now the JMDict entry_id, #39)
  dbKey: string;  // the wordDatabase key — stable, unique React key
}

export function Progress() {
  const wordDatabase = useAppStore((s) => s.wordDatabase);
  const userJlpt = useAppStore((s) => s.jlptLevel);

  // Group every tracked word by JLPT level once.
  const byLevel = useMemo(() => {
    const map = new Map<LevelKey, WordRow[]>();
    LEVELS.forEach((l) => map.set(l.value, []));
    Object.entries(wordDatabase).forEach(([dbKey, data]) => {
      const key = levelKeyFor(data);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push({ ...data, word: data.surface ?? dbKey, dbKey });
    });
    return map;
  }, [wordDatabase]);

  // Latest per-level grouping, read inside the discover effect WITHOUT making it
  // a dependency. Depending on `wordDatabase`/`byLevel` there would re-run the
  // expensive get_unseen_common_words RPC on every word the user tracks, which
  // pegs the shared DB and starves all other queries.
  const byLevelRef = useRef(byLevel);
  byLevelRef.current = byLevel;

  const totalWords = Object.keys(wordDatabase).length;

  // Default to the user's own JLPT level if they have words there, else the
  // most-populated level, else N5.
  const defaultLevel = useMemo<LevelKey>(() => {
    if (userJlpt != null && (byLevel.get(userJlpt)?.length ?? 0) > 0) return userJlpt;
    let best: LevelKey = 5;
    let bestCount = -1;
    LEVELS.forEach((l) => {
      const c = byLevel.get(l.value)?.length ?? 0;
      if (c > bestCount) {
        bestCount = c;
        best = l.value;
      }
    });
    return best;
  }, [byLevel, userJlpt]);

  const [activeLevel, setActiveLevel] = useState<LevelKey>(defaultLevel);
  // null = show all buckets; otherwise filter the word list to one bucket.
  const [activeBucket, setActiveBucket] = useState<BucketKey | null>(null);
  const [listMode, setListMode] = useState<'seen' | 'discover'>('seen');

  // Corpus totals per JLPT level (denominator for coverage). Fetched once.
  const [levelTotals, setLevelTotals] = useState<Record<number, number>>({});
  useEffect(() => {
    let cancelled = false;
    fetchJlptTotals().then((t) => {
      if (!cancelled) setLevelTotals(t);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Most-common unseen ("discover") words for the active level, fetched lazily.
  const [unseenWords, setUnseenWords] = useState<UnseenWord[]>([]);
  const [unseenLoading, setUnseenLoading] = useState(false);
  useEffect(() => {
    if (listMode !== 'discover' || typeof activeLevel !== 'number') return;
    let cancelled = false;
    setUnseenLoading(true);
    setUnseenWords([]);
    // Only seen words AT this level can exclude one of this level's candidates: a
    // shared surface form implies a shared JMDict entry and therefore the same
    // JLPT level. Sending just this level's seen words (read from a ref, not the
    // whole database) keeps p_seen_words small and the RPC cheap, and limits the
    // refetch to when the user actually changes level or enters discover mode.
    const seenWords = (byLevelRef.current.get(activeLevel) ?? []).map((w) => w.word);
    fetchUnseenCommonWords(activeLevel, seenWords, 40)
      .then((ws) => {
        if (!cancelled) setUnseenWords(ws);
      })
      .finally(() => {
        if (!cancelled) setUnseenLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeLevel, listMode]);

  const words = useMemo(() => byLevel.get(activeLevel) ?? [], [byLevel, activeLevel]);

  // Bucket counts per level: the four mastery buckets from tracked words, plus
  // 'notSeen' = corpus total minus tracked (levels without a corpus total —
  // 'Other', or totals still loading — get notSeen 0). Feeds both the mini
  // donuts in the level buttons and the detail donut below.
  const levelBucketCounts = useMemo(() => {
    const m = new Map<LevelKey, Record<BucketKey, number>>();
    LEVELS.forEach((l) => {
      const levelWords = byLevel.get(l.value) ?? [];
      const c = emptyBuckets();
      levelWords.forEach((w) => {
        c[masteryOf(w)] += 1;
      });
      if (typeof l.value === 'number') {
        const corpus = levelTotals[l.value];
        if (corpus) c.notSeen = Math.max(0, corpus - levelWords.length);
      }
      m.set(l.value, c);
    });
    return m;
  }, [byLevel, levelTotals]);

  const counts = levelBucketCounts.get(activeLevel) ?? emptyBuckets();
  const levelTotal = words.length;
  // Everything the donut represents: all corpus words at this level (or just
  // tracked words where no corpus total exists).
  const donutTotal = levelTotal + counts.notSeen;

  const visibleWords = useMemo(() => {
    const filtered =
      activeBucket == null
        ? words
        : activeBucket === 'notSeen'
        ? [] // never-encountered words aren't tracked; the Discover list covers them
        : words.filter((w) => masteryOf(w) === activeBucket);
    return [...filtered].sort((a, b) => (b.timesSeen || 0) - (a.timesSeen || 0));
  }, [words, activeBucket]);

  const switchLevel = (lvl: LevelKey) => {
    setActiveLevel(lvl);
    setActiveBucket(null);
  };

  const toggleBucket = (key: BucketKey) => {
    const next = activeBucket === key ? null : key;
    setActiveBucket(next);
    // Unseen words only exist in the Discover list; graded/ungraded ones in Seen.
    if (next === 'notSeen' && typeof activeLevel === 'number') setListMode('discover');
    else if (next != null && next !== 'notSeen') setListMode('seen');
  };

  return (
    <div className="fade-in" style={{ paddingBottom: '6rem' }}>
      <h1
        className="serif"
        style={{ fontSize: '2rem', marginBottom: '0.35rem', color: 'var(--text-main)' }}
      >
        Progress
      </h1>
      <p
        className="sans"
        style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '1.75rem' }}
      >
        {totalWords > 0
          ? `Tracking ${totalWords} ${totalWords === 1 ? 'word' : 'words'} across your reading.`
          : 'Words you encounter while reading will appear here.'}
      </p>

      {/* Study dashboard (#73): global deck health + review-activity heatmap. Sits
          up top, ahead of the per-JLPT-level breakdown, since it summarizes the
          whole deck rather than the selected level. */}
      <StudyDashboard />

      {/* JLPT level selector — segmented, scrollable */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          // Fluid row: on narrow screens the donuts SHRINK proportionally (via
          // flex-grow ratios on the buttons) so all six always fit with at least
          // the fixed gap between them; on wide screens they cap at full size
          // and space-between spreads the leftover as extra spacing. When the
          // active donut grows, flexbox re-spreads every frame — neighbors
          // slide smoothly.
          justifyContent: 'space-between',
          gap: '8px',
          overflowX: 'auto',
          // Generous padding so the active donut's shadow (14px blur) never
          // clips against the overflow scroller on any edge.
          padding: '0.5rem 0.9rem 1.25rem',
          // Bleed through main's 1.25rem side padding: the row isn't a card, so
          // it may run wider than the cards — on phones that slack goes straight
          // into bigger donuts (the fluid sizing absorbs it).
          margin: '0 -1.25rem 1rem',
          WebkitOverflowScrolling: 'touch',
          scrollbarWidth: 'none',
        }}
      >
        {LEVELS.map((l) => {
          const isActive = l.value === activeLevel;
          const bucketCounts = levelBucketCounts.get(l.value) ?? emptyBuckets();
          const tracked = byLevel.get(l.value)?.length ?? 0;
          // Full corpus size for JLPT levels; 'Other' has no corpus, so tracked.
          const total =
            typeof l.value === 'number' ? levelTotals[l.value] ?? tracked : tracked;
          return (
            <button
              key={String(l.value)}
              onClick={() => switchLevel(l.value)}
              className="sans"
              style={{
                // Fluid width: grow factors carry the 64:80 inactive:active
                // ratio, so donuts scale down together on narrow screens (the
                // fluid svg inside tracks the button width); max-width caps them
                // at full size on wide screens. min-width floors legibility —
                // below it the row overflows into a scroll with gaps intact.
                // Height is fixed so nothing below the row moves vertically.
                flex: `${isActive ? 80 : 64} 1 0px`,
                maxWidth: isActive ? '80px' : '64px',
                minWidth: isActive ? '54px' : '43px',
                height: '108px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                // A fixed-height slot at the bottom centers the donut vertically,
                // so every donut's CENTER sits on the same line regardless of
                // size; the label is anchored to the donut's top edge, so it
                // rides up as the active donut grows into the headroom above.
                justifyContent: 'flex-end',
                padding: 0,
                border: 'none',
                cursor: 'pointer',
                background: 'none',
                color: isActive ? 'var(--text-main)' : 'var(--text-muted)',
                transition: 'color 0.2s, flex-grow 0.25s ease, max-width 0.25s ease, min-width 0.25s ease',
              }}
            >
              {/* Fixed-height slot = max donut size; smaller donuts center in it. */}
              <span
                style={{
                  height: '80px',
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
              {/* Round wrapper carries a box-shadow (border-radius 50%) instead of
                  a CSS filter: drop-shadow rasterizes the layer, which both blurs
                  it and shifts its color against the page background. box-shadow
                  keeps the ring vector-crisp and the hole truly transparent. */}
              <span
                style={{
                  position: 'relative',
                  display: 'flex',
                  width: '100%',
                  borderRadius: '50%',
                  boxShadow: isActive
                    ? '0 6px 14px rgba(0,0,0,0.24)'
                    : '0 1px 3px rgba(0,0,0,0.10)',
                  transition: 'box-shadow 0.25s ease',
                }}
              >
                <span
                  className="sans"
                  style={{
                    position: 'absolute',
                    bottom: 'calc(100% + 7px)',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    fontSize: isActive ? '1.1rem' : '0.85rem',
                    fontWeight: isActive ? 700 : 600,
                    letterSpacing: '0.04em',
                    lineHeight: 1,
                    whiteSpace: 'nowrap',
                    transition: 'font-size 0.25s ease',
                  }}
                >
                  {l.label}
                </span>
                <Donut
                  counts={bucketCounts}
                  total={tracked + bucketCounts.notSeen}
                  activeBucket={null}
                  size={56}
                  strokeWidth={8}
                  fluid
                  showText={false}
                  centerText={total.toLocaleString()}
                  holeFill={isActive ? 'var(--bg-card)' : undefined}
                />
              </span>
              </span>
            </button>
          );
        })}
      </div>

      {/* Breakdown card: donut + legend over ALL words at this level — the four
          mastery buckets plus corpus words never encountered ("Unseen"). */}
      <div
        style={{
          backgroundColor: 'var(--bg-card)',
          padding: '1.75rem 1.5rem',
          borderRadius: '16px',
          marginBottom: '1.5rem',
        }}
      >
        {/* Mirrors the active mini donut's label styling so the card visibly
            belongs to the selected level. */}
        <span
          className="sans"
          style={{
            display: 'block',
            fontSize: '1.1rem',
            fontWeight: 700,
            letterSpacing: '0.04em',
            color: 'var(--text-main)',
            lineHeight: 1,
            marginBottom: '1rem',
          }}
        >
          {LEVELS.find((l) => l.value === activeLevel)?.label}
        </span>
        {donutTotal === 0 ? (
          <p
            className="sans"
            style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.9rem', padding: '1.5rem 0' }}
          >
            No words tracked at this level yet.
          </p>
        ) : (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              // Donut grows into whatever the legend doesn't need; the legend
              // keeps its natural (content) width and hugs the right edge, so
              // the leftover always lands as whitespace between the two.
              justifyContent: 'space-between',
              gap: '1.25rem',
            }}
          >
            <div style={{ flex: '1 1 0', minWidth: 0, maxWidth: '210px' }}>
              {/* Same lifted look as the active mini donut: round box-shadow
                  wrapper + card-colored hole so the shadow can't bleed through. */}
              <span
                style={{
                  display: 'flex',
                  borderRadius: '50%',
                  boxShadow: '0 6px 14px rgba(0,0,0,0.24)',
                }}
              >
                <Donut
                  counts={counts}
                  total={donutTotal}
                  activeBucket={activeBucket}
                  fluid
                  holeFill="var(--bg-card)"
                  headline={`${donutTotal > 0 ? Math.round((levelTotal / donutTotal) * 100) : 0}%`}
                  subline="seen"
                />
              </span>
            </div>
            <div style={{ flex: '0 0 auto' }}>
              {BUCKETS.filter((m) => m.key !== 'notSeen' || counts.notSeen > 0).map((m) => {
                const value = counts[m.key];
                const pct = donutTotal > 0 ? Math.round((value / donutTotal) * 100) : 0;
                const isActive = activeBucket === m.key;
                const dimmed = activeBucket != null && !isActive;
                return (
                  <button
                    key={m.key}
                    onClick={() => toggleBucket(m.key)}
                    className="sans"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.45rem',
                      width: '100%',
                      padding: '0.45rem 0.4rem',
                      background: isActive ? 'var(--bg-pure)' : 'none',
                      border: 'none',
                      borderRadius: '10px',
                      cursor: 'pointer',
                      textAlign: 'left',
                      opacity: dimmed ? 0.45 : 1,
                      transition: 'opacity 0.2s, background-color 0.2s',
                    }}
                  >
                    <span
                      style={{
                        width: '10px',
                        height: '10px',
                        borderRadius: '3px',
                        backgroundColor: m.color,
                        flex: '0 0 auto',
                      }}
                    />
                    <span style={{ fontSize: '0.85rem', color: 'var(--text-main)', flex: 1, whiteSpace: 'nowrap' }}>
                      {m.label}
                    </span>
                    {/* Fixed-width number columns: the legend keeps the same width
                        no matter the digit counts, so the donut never resizes when
                        switching levels or buckets. */}
                    <span
                      style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-main)', width: '2.5rem', textAlign: 'right', flex: '0 0 auto' }}
                    >
                      {pct}%
                    </span>
                    <span
                      style={{ fontSize: '0.75rem', color: 'var(--text-muted)', width: '2.7rem', textAlign: 'right', flex: '0 0 auto' }}
                    >
                      {value.toLocaleString()}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Word list — Seen (tracked) vs Discover (most-common unseen) */}
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '0.85rem',
            gap: '0.75rem',
          }}
        >
          {/* Seen / Discover segmented toggle */}
          <div
            style={{
              display: 'inline-flex',
              backgroundColor: 'var(--bg-card)',
              borderRadius: '100px',
              padding: '3px',
            }}
          >
            {(['seen', 'discover'] as const).map((mode) => {
              const isActive = listMode === mode;
              const disabled = mode === 'discover' && typeof activeLevel !== 'number';
              return (
                <button
                  key={mode}
                  onClick={() => !disabled && setListMode(mode)}
                  className="sans"
                  disabled={disabled}
                  style={{
                    border: 'none',
                    borderRadius: '100px',
                    padding: '0.35rem 0.9rem',
                    fontSize: '0.8rem',
                    fontWeight: isActive ? 700 : 500,
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    color: disabled
                      ? 'var(--border-light)'
                      : isActive
                      ? 'var(--text-main)'
                      : 'var(--text-muted)',
                    backgroundColor: isActive ? 'var(--bg-pure)' : 'transparent',
                    boxShadow: isActive ? '0 2px 8px rgba(0,0,0,0.04)' : 'none',
                    transition: 'color 0.2s, background-color 0.2s',
                    textTransform: 'capitalize',
                  }}
                >
                  {mode === 'seen' ? 'Seen' : 'Discover'}
                </button>
              );
            })}
          </div>

          {listMode === 'seen' && activeBucket && (
            <button
              onClick={() => setActiveBucket(null)}
              className="sans"
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-muted)',
                fontSize: '0.8rem',
                cursor: 'pointer',
                textDecoration: 'underline',
              }}
            >
              Clear
            </button>
          )}
        </div>

        {listMode === 'discover' && (
          <p
            className="sans"
            style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '0 0.25rem 0.85rem' }}
          >
            The most common {LEVELS.find((l) => l.value === activeLevel)?.label} words you haven't met yet.
          </p>
        )}

        {/* SEEN list */}
        {listMode === 'seen' &&
          (visibleWords.length === 0 ? null : (
            <div style={{ backgroundColor: 'var(--bg-card)', borderRadius: '16px', overflow: 'hidden' }}>
              {visibleWords.map((w, i) => (
                <WordRowView
                  key={w.dbKey}
                  word={w.word}
                  reading={w.reading}
                  meaning={w.meaning}
                  timesSeen={w.timesSeen}
                  bucket={masteryOf(w)}
                  difficulty={w.difficulty}
                  first={i === 0}
                />
              ))}
            </div>
          ))}

        {/* DISCOVER list */}
        {listMode === 'discover' &&
          (unseenLoading ? (
            <div
              className="sans"
              style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem', padding: '2rem 0' }}
            >
              Loading…
            </div>
          ) : unseenWords.length === 0 ? (
            <div
              className="sans"
              style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem', padding: '2rem 0' }}
            >
              Nothing to show — you may have seen all the common words here, or the
              dictionary is unavailable.
            </div>
          ) : (
            <div style={{ backgroundColor: 'var(--bg-card)', borderRadius: '16px', overflow: 'hidden' }}>
              {unseenWords.map((w, i) => (
                <WordRowView
                  key={w.word}
                  word={w.word}
                  reading={w.reading}
                  meaning={w.meaning}
                  first={i === 0}
                />
              ))}
            </div>
          ))}
      </div>
    </div>
  );
}

// --- Shared word row --------------------------------------------------------

function WordRowView({
  word,
  reading,
  meaning,
  timesSeen,
  bucket,
  difficulty,
  first,
}: {
  word: string;
  reading?: string;
  meaning?: string;
  timesSeen?: number;
  bucket?: MasteryLevel;
  difficulty?: number | null;
  first: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        padding: '0.85rem 1rem',
        borderTop: first ? 'none' : '1px solid var(--border-light)',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
          <span
            className="serif"
            translate="no"
            style={{ fontSize: '1.15rem', fontWeight: 600, color: 'var(--text-main)' }}
          >
            {word}
          </span>
          {reading && (
            <span
              className="sans"
              translate="no"
              style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}
            >
              {reading}
            </span>
          )}
        </div>
        {meaning && (
          <div
            className="sans"
            style={{
              fontSize: '0.78rem',
              color: 'var(--text-muted)',
              marginTop: '2px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {meaning}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flex: '0 0 auto' }}>
        {timesSeen != null && timesSeen > 0 && (
          <span className="sans" style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
            ×{timesSeen}
          </span>
        )}
        {bucket && <MasteryPill bucket={bucket} difficulty={difficulty} />}
      </div>
    </div>
  );
}

// --- Donut ring -------------------------------------------------------------

function Donut({
  counts,
  total,
  activeBucket,
  size = 150,
  strokeWidth = 20,
  showText = true,
  centerText,
  headline,
  subline,
  displaySize,
  holeFill,
  fluid = false,
}: {
  counts: Record<BucketKey, number>;
  total: number;
  activeBucket: BucketKey | null;
  size?: number;
  strokeWidth?: number;
  showText?: boolean;
  centerText?: string;  // compact center count (mini donuts)
  headline?: string;    // big center line (detail donut), e.g. "42%"
  subline?: string;     // small line under the headline, e.g. "seen"
  displaySize?: number; // rendered size; defaults to `size` (the viewBox scale)
  holeFill?: string;    // center fill; omit for a transparent hole
  fluid?: boolean;      // fill the parent's width (square) instead of fixed px
}) {
  const r = (size - strokeWidth) / 2;
  const c = 2 * Math.PI * r;
  const center = size / 2;

  // Build segments in legend order; skip empty buckets.
  let offset = 0;
  const segments = BUCKET_ORDER
    .filter((k) => counts[k] > 0)
    .map((k) => {
      const frac = total > 0 ? counts[k] / total : 0;
      const len = frac * c;
      const seg = { key: k, len, offset };
      offset += len;
      return seg;
    });

  const rendered = displaySize ?? size;
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      style={
        fluid
          ? // Track the parent's (animated) width; the viewBox scales all
            // geometry and text vectorially, so any rendered size stays crisp.
            { width: '100%', height: 'auto', aspectRatio: '1 / 1' }
          : {
              flex: '0 0 auto',
              width: rendered,
              height: rendered,
              transition: 'width 0.25s ease, height 0.25s ease',
            }
      }
    >
      {holeFill && <circle cx={center} cy={center} r={r} fill={holeFill} />}
      {/* track */}
      <circle cx={center} cy={center} r={r} fill="none" stroke="var(--border-light)" strokeWidth={strokeWidth} />
      <g transform={`rotate(-90 ${center} ${center})`}>
        {segments.map((s) => {
          const dim = activeBucket != null && s.key !== activeBucket;
          return (
            <circle
              key={s.key}
              cx={center}
              cy={center}
              r={r}
              fill="none"
              stroke={BUCKET_COLOR[s.key]}
              strokeWidth={strokeWidth}
              strokeDasharray={`${s.len} ${c - s.len}`}
              strokeDashoffset={-s.offset}
              strokeLinecap="butt"
              style={{ opacity: dim ? 0.25 : 1, transition: 'opacity 0.2s' }}
            />
          );
        })}
      </g>
      {!showText && centerText != null && (
        <text
          x={center}
          y={center}
          dominantBaseline="central"
          textAnchor="middle"
          className="sans"
          style={{
            // Shrink to fit the hole: ~0.62em average glyph width for digits.
            fontSize: `${Math.min(11, (size - strokeWidth * 2 - 4) / (Math.max(centerText.length, 1) * 0.62))}px`,
            fontWeight: 600,
            fill: 'currentColor',
          }}
        >
          {centerText}
        </text>
      )}
      {showText && headline != null && (
        <>
          <text
            x={center}
            y={subline != null ? center - 4 : center}
            dominantBaseline={subline != null ? undefined : 'central'}
            textAnchor="middle"
            className="serif"
            style={{
              fontSize: headline.length > 4 ? '1rem' : '1.2rem',
              fontWeight: 700,
              fill: 'var(--text-main)',
            }}
          >
            {headline}
          </text>
          {subline != null && (
            <text
              x={center}
              y={center + 14}
              textAnchor="middle"
              className="sans"
              style={{ fontSize: '0.65rem', fill: 'var(--text-muted)', letterSpacing: '0.04em' }}
            >
              {subline}
            </text>
          )}
        </>
      )}
    </svg>
  );
}

// --- Mastery pill -----------------------------------------------------------

function MasteryPill({ bucket, difficulty }: { bucket: MasteryLevel; difficulty?: number | null }) {
  const color = MASTERY_COLOR[bucket];
  const label = MASTERY.find((m) => m.key === bucket)!.label;
  const isUnseen = bucket === 'unseen';
  return (
    <span
      className="sans"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.25rem',
        fontSize: '0.7rem',
        fontWeight: 600,
        padding: '0.2rem 0.6rem',
        borderRadius: '100px',
        color: isUnseen ? 'var(--text-muted)' : color,
        backgroundColor: isUnseen ? 'transparent' : `${color}22`,
        border: isUnseen ? '1px solid var(--border-light)' : `1px solid ${color}55`,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
      {!isUnseen && difficulty != null && (
        <span style={{ opacity: 0.7, fontWeight: 500 }}>{difficulty}/10</span>
      )}
    </span>
  );
}

// --- Study dashboard (#73) --------------------------------------------------
// Review-activity heatmap fed by the store's reviewsByDay tally — the grid
// reflects real reviews (read-past + flashcard grades both count).

const DAY_MS = 86_400_000;
const HEAT_WEEKS = 14; // ~3 months of activity, mobile-friendly width
// Fixed intensity thresholds (stable across users, unlike a max-relative scale).
const heatLevel = (n: number): number => (n === 0 ? 0 : n < 4 ? 1 : n < 10 ? 2 : n < 25 ? 3 : 4);
const HEAT_COLORS = [
  'var(--border-light)',
  'rgba(91, 140, 90, 0.35)',
  'rgba(91, 140, 90, 0.6)',
  'rgba(91, 140, 90, 0.82)',
  'rgba(91, 140, 90, 1)',
];

/** UTC day key (YYYY-MM-DD) for a ms timestamp — matches how the store stamps
 * reviewsByDay (new Date().toISOString()), so the grid lines up with the tallies. */
const utcDayKey = (ms: number): string => new Date(ms).toISOString().split('T')[0];

function StudyDashboard() {
  const reviewsByDay = useAppStore((s) => s.reviewsByDay);

  const now = Date.now();

  // Heatmap columns: weeks × 7 weekday rows, oldest→newest, ending today. The first
  // cell is aligned to a Sunday so columns are whole weeks (Sun..Sat).
  const { columns, todayCount, windowTotal } = useMemo(() => {
    const dow = new Date(now).getUTCDay(); // 0=Sun..6=Sat
    const totalDays = (HEAT_WEEKS - 1) * 7 + dow + 1;
    const cols: ({ key: string; count: number } | null)[][] = [];
    let col: ({ key: string; count: number } | null)[] = new Array(7).fill(null);
    let total = 0;
    for (let i = totalDays - 1; i >= 0; i--) {
      const ms = now - i * DAY_MS;
      const key = utcDayKey(ms);
      const count = reviewsByDay[key] ?? 0;
      total += count;
      const weekday = new Date(ms).getUTCDay();
      col[weekday] = { key, count };
      if (weekday === 6) {
        cols.push(col);
        col = new Array(7).fill(null);
      }
    }
    if (col.some(Boolean)) cols.push(col);
    return { columns: cols, todayCount: reviewsByDay[utcDayKey(now)] ?? 0, windowTotal: total };
  }, [reviewsByDay, now]);

  return (
    <div
      style={{
        backgroundColor: 'var(--bg-card)',
        padding: '1.4rem 1.5rem',
        borderRadius: '16px',
        marginBottom: '1.5rem',
      }}
    >
      {/* Review-activity heatmap */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '0.55rem' }}>
        <span className="sans" style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
          Reviews today{' '}
          <span style={{ color: 'var(--text-main)', fontWeight: 600 }}>{todayCount}</span>
        </span>
        <span className="sans" style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
          {windowTotal.toLocaleString()} in {HEAT_WEEKS} weeks
        </span>
      </div>
      <div style={{ display: 'flex', gap: '3px', overflowX: 'auto' }}>
        {columns.map((week, ci) => (
          <div key={ci} style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            {week.map((cell, ri) => (
              <div
                key={ri}
                title={cell ? `${cell.key}: ${cell.count} review${cell.count === 1 ? '' : 's'}` : undefined}
                style={{
                  width: '11px',
                  height: '11px',
                  borderRadius: '3px',
                  backgroundColor: cell ? HEAT_COLORS[heatLevel(cell.count)] : 'transparent',
                }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
