import type { Rating } from '../services/srs';
import { GRADES } from '../services/grades';

// The flashcard grade control (both decks), in the shape of the app's slider toggle
// (design-system §6.1). It's a setting, not four buttons: it arrives already set to
// a grade guessed from the thinking time (services/thinkTime.ts), a tap moves the
// white thumb to another grade and nothing else, and tapping the card moves on.
// See docs/mockups/kanji-deck.html (S2 + S3).

export function GradeSlider({ value, onChange, intervals }: {
  value: Rating;
  onChange: (rating: Rating) => void;
  /** Next interval per grade, already formatted. */
  intervals: Record<Rating, string>;
}) {
  const i = GRADES.findIndex((g) => g.rating === value);
  return (
    // Taps on the control must not reach the card: tapping the card means "move on".
    <div onClick={(e) => e.stopPropagation()} style={{ padding: '0 1rem 1.05rem', cursor: 'default' }}>
      <div
        role="radiogroup"
        aria-label="How did it go?"
        style={{ position: 'relative', display: 'flex', height: '45px', padding: '4px', borderRadius: '100px', backgroundColor: 'var(--border-light)' }}
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
              onClick={() => onChange(g.rating)}
              className="serif"
              style={{
                position: 'relative',
                zIndex: 1,
                flex: 1,
                border: 'none',
                background: 'none',
                cursor: 'pointer',
                fontSize: '0.9rem',
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
      <div
        className="sans"
        style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.45rem', padding: '0 0.3rem', fontSize: '0.66rem', color: 'var(--text-muted)' }}
      >
        <span>次は {intervals[value]}</span>
        <span>タップで次へ</span>
      </div>
    </div>
  );
}
