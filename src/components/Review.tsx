import { useCallback, useState } from 'react';
import { Flashcards } from './Flashcards';
import { dueDeckSize } from '../services/dueDeck';
import { Progress } from './Progress';

export type ReviewSegment = 'review' | 'progress';

// REVIEW tab: flashcards (復習) and the progress dashboard (進捗) behind one
// segmented control, so the bottom nav needs one slot for both. Opens on 復習
// when cards are due, otherwise on 進捗 (an "all caught up" visit lands on the
// heatmap, not the empty deck); an explicit choice is remembered by App for the
// session. Both panes stay mounted once visited — switching segments must not
// re-snapshot the flashcard deck mid-run.
const SEGMENTS: { id: ReviewSegment; label: string }[] = [
  { id: 'review', label: '復習' },
  { id: 'progress', label: '進捗' },
];

// Height the segmented control occupies above the card flow (pill + margin).
const SEGMENT_BAR_HEIGHT = '3.5rem';

export function Review({
  segment,
  onSegmentChange,
  onFocusChange,
}: {
  segment: ReviewSegment | null;
  onSegmentChange: (segment: ReviewSegment) => void;
  onFocusChange?: (focused: boolean) => void;
}) {
  const [defaultSegment] = useState<ReviewSegment>(() => (dueDeckSize() > 0 ? 'review' : 'progress'));
  const active = segment ?? defaultSegment;
  const [visitedProgress, setVisitedProgress] = useState(active === 'progress');
  const [remaining, setRemaining] = useState(0);
  const [focused, setFocused] = useState(false);

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

  return (
    <div>
      {/* Focus mode hides the control along with the nav so the card keeps the screen. */}
      {!focused && (
        <div style={{ height: SEGMENT_BAR_HEIGHT, display: 'flex', alignItems: 'flex-start' }}>
          <div
            role="tablist"
            style={{
              display: 'inline-flex',
              backgroundColor: 'var(--bg-card)',
              borderRadius: '100px',
              padding: '3px',
            }}
          >
            {SEGMENTS.map(({ id, label }) => {
              const isActive = active === id;
              return (
                <button
                  key={id}
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => select(id)}
                  className="serif"
                  style={{
                    border: 'none',
                    borderRadius: '100px',
                    padding: '0.3rem 1.05rem',
                    fontSize: '0.95rem',
                    fontWeight: isActive ? 700 : 500,
                    cursor: 'pointer',
                    color: isActive ? 'var(--text-main)' : 'var(--text-muted)',
                    backgroundColor: isActive ? 'var(--bg-pure)' : 'transparent',
                    boxShadow: isActive ? '0 2px 8px rgba(0,0,0,0.04)' : 'none',
                    transition: 'color 0.2s, background-color 0.2s',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                  }}
                >
                  {label}
                  {id === 'review' && remaining > 0 && (
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
                      {remaining}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div hidden={active !== 'review'}>
        <Flashcards
          onFocusChange={handleFocus}
          onRemainingChange={setRemaining}
          topOffset={focused ? '0rem' : SEGMENT_BAR_HEIGHT}
        />
      </div>
      {visitedProgress && (
        <div hidden={active !== 'progress'}>
          <Progress embedded />
        </div>
      )}
    </div>
  );
}
