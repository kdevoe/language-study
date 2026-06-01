import { useEffect, useMemo, useState } from 'react';
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
  word: string;
}

export function Progress() {
  const wordDatabase = useAppStore((s) => s.wordDatabase);
  const userJlpt = useAppStore((s) => s.jlptLevel);

  // Group every tracked word by JLPT level once.
  const byLevel = useMemo(() => {
    const map = new Map<LevelKey, WordRow[]>();
    LEVELS.forEach((l) => map.set(l.value, []));
    Object.entries(wordDatabase).forEach(([word, data]) => {
      const key = levelKeyFor(data);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push({ word, ...data });
    });
    return map;
  }, [wordDatabase]);

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
  const [activeBucket, setActiveBucket] = useState<MasteryLevel | null>(null);
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
    // Exclude by surface form — word_frequency is keyed by word, and that's how
    // the local wordDatabase is keyed too, so this is the reliable join.
    const seenWords = Object.keys(wordDatabase);
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
  }, [activeLevel, listMode, wordDatabase]);

  const words = byLevel.get(activeLevel) ?? [];

  // Bucket counts for the active level.
  const counts = useMemo(() => {
    const c: Record<MasteryLevel, number> = { easy: 0, medium: 0, hard: 0, unseen: 0 };
    words.forEach((w) => {
      c[masteryOf(w)] += 1;
    });
    return c;
  }, [words]);

  const levelTotal = words.length;

  const visibleWords = useMemo(() => {
    const filtered = activeBucket ? words.filter((w) => masteryOf(w) === activeBucket) : words;
    return [...filtered].sort((a, b) => (b.timesSeen || 0) - (a.timesSeen || 0));
  }, [words, activeBucket]);

  const switchLevel = (lvl: LevelKey) => {
    setActiveLevel(lvl);
    setActiveBucket(null);
  };

  // Coverage: how much of this level's full vocabulary the user has encountered.
  const corpusTotal = typeof activeLevel === 'number' ? levelTotals[activeLevel] : undefined;
  const coveragePct =
    corpusTotal && corpusTotal > 0 ? (levelTotal / corpusTotal) * 100 : null;
  const coverageLabel =
    coveragePct == null ? '' : coveragePct >= 10 ? `${Math.round(coveragePct)}%` : coveragePct >= 1 ? `${coveragePct.toFixed(1)}%` : '<1%';

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

      {/* JLPT level selector — segmented, scrollable */}
      <div
        style={{
          display: 'flex',
          gap: '0.4rem',
          overflowX: 'auto',
          paddingBottom: '0.4rem',
          marginBottom: '1.5rem',
          WebkitOverflowScrolling: 'touch',
          scrollbarWidth: 'none',
        }}
      >
        {LEVELS.map((l) => {
          const isActive = l.value === activeLevel;
          const count = byLevel.get(l.value)?.length ?? 0;
          return (
            <button
              key={String(l.value)}
              onClick={() => switchLevel(l.value)}
              className="sans"
              style={{
                flex: '0 0 auto',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '2px',
                minWidth: '3.4rem',
                padding: '0.55rem 0.7rem',
                borderRadius: '14px',
                border: 'none',
                cursor: 'pointer',
                backgroundColor: isActive ? 'var(--accent-primary)' : 'var(--bg-card)',
                color: isActive ? 'var(--text-main)' : 'var(--text-muted)',
                transition: 'background-color 0.2s, color 0.2s',
              }}
            >
              <span style={{ fontSize: '0.95rem', fontWeight: 700, letterSpacing: '0.03em' }}>
                {l.label}
              </span>
              <span style={{ fontSize: '0.65rem', fontWeight: 600, opacity: 0.75 }}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* Coverage strip — encountered vs. the full vocabulary pool of this level */}
      {coveragePct != null && corpusTotal && (
        <div
          style={{
            backgroundColor: 'var(--bg-card)',
            padding: '1.1rem 1.25rem',
            borderRadius: '16px',
            marginBottom: '1.5rem',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              marginBottom: '0.6rem',
            }}
          >
            <span className="sans" style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Encountered{' '}
              <span style={{ color: 'var(--text-main)', fontWeight: 600 }}>
                {levelTotal.toLocaleString()}
              </span>{' '}
              of {corpusTotal.toLocaleString()} words
            </span>
            <span
              className="serif"
              style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-main)' }}
            >
              {coverageLabel}
            </span>
          </div>
          <div
            style={{
              height: '8px',
              borderRadius: '100px',
              backgroundColor: 'var(--border-light)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${Math.max(coveragePct, 1.5)}%`,
                backgroundColor: 'var(--accent-primary)',
                borderRadius: '100px',
              }}
            />
          </div>
          <p
            className="sans"
            style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.6rem' }}
          >
            {(corpusTotal - levelTotal).toLocaleString()} more {LEVELS.find((l) => l.value === activeLevel)?.label} words to discover.
          </p>
        </div>
      )}

      {/* Breakdown card: donut + legend (of the words you've engaged with) */}
      <div
        style={{
          backgroundColor: 'var(--bg-card)',
          padding: '1.75rem 1.5rem',
          borderRadius: '16px',
          marginBottom: '1.5rem',
        }}
      >
        {levelTotal === 0 ? (
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
              gap: '1.75rem',
              flexWrap: 'wrap',
              justifyContent: 'center',
            }}
          >
            <Donut counts={counts} total={levelTotal} activeBucket={activeBucket} />
            <div style={{ flex: '1 1 180px', minWidth: '160px' }}>
              {MASTERY.map((m) => {
                const value = counts[m.key];
                const pct = levelTotal > 0 ? Math.round((value / levelTotal) * 100) : 0;
                const isActive = activeBucket === m.key;
                const dimmed = activeBucket != null && !isActive;
                return (
                  <button
                    key={m.key}
                    onClick={() => setActiveBucket(isActive ? null : m.key)}
                    className="sans"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.6rem',
                      width: '100%',
                      padding: '0.5rem 0.5rem',
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
                    <span style={{ fontSize: '0.9rem', color: 'var(--text-main)', flex: 1 }}>
                      {m.label}
                    </span>
                    <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-main)' }}>
                      {pct}%
                    </span>
                    <span
                      style={{ fontSize: '0.8rem', color: 'var(--text-muted)', minWidth: '1.6rem', textAlign: 'right' }}
                    >
                      {value}
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
          (levelTotal === 0 ? null : (
            <div style={{ backgroundColor: 'var(--bg-card)', borderRadius: '16px', overflow: 'hidden' }}>
              {visibleWords.map((w, i) => (
                <WordRowView
                  key={w.word}
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
}: {
  counts: Record<MasteryLevel, number>;
  total: number;
  activeBucket: MasteryLevel | null;
}) {
  const size = 150;
  const stroke = 20;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const center = size / 2;

  // Build segments in legend order; skip empty buckets.
  const order: MasteryLevel[] = ['easy', 'medium', 'hard', 'unseen'];
  let offset = 0;
  const segments = order
    .filter((k) => counts[k] > 0)
    .map((k) => {
      const frac = counts[k] / total;
      const len = frac * c;
      const seg = { key: k, len, offset };
      offset += len;
      return seg;
    });

  // Headline = the active bucket's share, else "words" total.
  const headlineNum = activeBucket
    ? `${total > 0 ? Math.round((counts[activeBucket] / total) * 100) : 0}%`
    : String(total);
  const headlineLbl = activeBucket
    ? MASTERY.find((m) => m.key === activeBucket)!.label
    : total === 1 ? 'word' : 'words';

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flex: '0 0 auto' }}>
      {/* track */}
      <circle cx={center} cy={center} r={r} fill="none" stroke="var(--border-light)" strokeWidth={stroke} />
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
              stroke={MASTERY_COLOR[s.key]}
              strokeWidth={stroke}
              strokeDasharray={`${s.len} ${c - s.len}`}
              strokeDashoffset={-s.offset}
              strokeLinecap="butt"
              style={{ opacity: dim ? 0.25 : 1, transition: 'opacity 0.2s' }}
            />
          );
        })}
      </g>
      <text
        x={center}
        y={center - 4}
        textAnchor="middle"
        className="serif"
        style={{ fontSize: '1.7rem', fontWeight: 700, fill: 'var(--text-main)' }}
      >
        {headlineNum}
      </text>
      <text
        x={center}
        y={center + 16}
        textAnchor="middle"
        className="sans"
        style={{ fontSize: '0.7rem', fill: 'var(--text-muted)', letterSpacing: '0.04em' }}
      >
        {headlineLbl}
      </text>
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
