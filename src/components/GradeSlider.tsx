import { useEffect, useRef } from 'react';
import type { Rating } from '../services/srs';
import { GRADES } from '../services/grades';

// The flashcard grade control (both decks), in the shape of the app's slider toggle
// (design-system §6.1). It arrives already set to a grade guessed from the thinking
// time (services/thinkTime.ts). Two ways to move on, one tap each:
//   • tap the card — keep the suggested grade
//   • tap a grade — the thumb slides there, and a beat later the card moves on
//     with that grade (tapping another grade inside the beat re-aims it)
// No caption: the slider alone sits 1.6rem above the card's bottom edge.
// See docs/mockups/kanji-deck.html (S2 + S3) and flashcard-feel-2.html.

/** Long enough to see the thumb arrive before the card lifts away. */
const COMMIT_DELAY_MS = 260;

export function GradeSlider({ value, onChange, onCommit }: {
  value: Rating;
  /** Move the thumb. */
  onChange: (rating: Rating) => void;
  /** Grade the card and move on. */
  onCommit: (rating: Rating) => void;
}) {
  const i = GRADES.findIndex((g) => g.rating === value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const choose = (rating: Rating) => {
    onChange(rating);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; onCommit(rating); }, COMMIT_DELAY_MS);
  };

  return (
    // Taps on the control must not reach the card (a card tap commits the suggested
    // grade), and a press on the slider shouldn't make the card sink.
    <div
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      style={{ padding: '0 1.1rem 1.6rem', cursor: 'default' }}
    >
      <div
        role="radiogroup"
        aria-label="How did it go?"
        style={{ position: 'relative', display: 'flex', height: '44px', padding: '4px', borderRadius: '100px', backgroundColor: 'var(--border-light)' }}
      >
        <div
          aria-hidden
          style={{
            position: 'absolute',
            top: '4px',
            bottom: '4px',
            left: `calc(4px + ${i} * (100% - 8px) / ${GRADES.length})`,
            width: `calc((100% - 8px) / ${GRADES.length})`,
            borderRadius: '100px',
            backgroundColor: 'var(--bg-pure)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
            transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        />
        {GRADES.map((g) => {
          const on = g.rating === value;
          return (
            <button
              key={g.rating}
              role="radio"
              aria-checked={on}
              onClick={() => choose(g.rating)}
              className="serif"
              style={{
                position: 'relative',
                zIndex: 1,
                flex: 1,
                border: 'none',
                background: 'none',
                cursor: 'pointer',
                fontSize: '0.84rem',
                fontWeight: on ? 700 : 500,
                color: on ? 'var(--text-main)' : 'var(--text-muted)',
                transition: 'color 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                whiteSpace: 'nowrap',
              }}
            >
              {g.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
