import { useCallback, useState } from 'react';
import { Flashcards } from './Flashcards';
import { dueDeckSize } from '../services/dueDeck';
import { Progress } from './Progress';
import { useAppStore } from '../services/store';
import { PageHeading } from './PageHeading';
import { Segment } from './Segment';

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
  const [defaultSegment] = useState<ReviewSegment>(() => (dueDeckSize() > 0 ? 'review' : 'progress'));
  const active = segment ?? defaultSegment;
  const [visitedProgress, setVisitedProgress] = useState(active === 'progress');
  const [remaining, setRemaining] = useState(0);
  const [focused, setFocused] = useState(false);
  // Quiet right-hand hint balancing the toggle row: today's reviews on 復習,
  // tracked words on 進捗.
  const reviewsToday = useAppStore((s) => s.reviewsByDay[utcDayKey(Date.now())] ?? 0);
  const trackedWords = useAppStore((s) => Object.keys(s.wordDatabase).length);

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
      {/* Focus mode hides the heading and control along with the nav so the card keeps the screen. */}
      {!focused && <PageHeading id="review" settingsMark={false} />}
      {!focused && (
        <div style={{ height: SEGMENT_BAR_HEIGHT, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <Segment
            options={SEGMENTS.map(({ id, label }) => ({
              id,
              label,
              badge: id === 'review' && remaining > 0 && (
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
