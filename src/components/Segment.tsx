import type { ReactNode } from 'react';

// The quiet tab-page segment (REVIEW's 復習 | 進捗, 読む's ニュース | 本棚): serif
// labels on a --bg-card pill, the active one lifted onto white. Not the
// settings slider toggle (§6.1) — this one switches what the page shows.
export function Segment<T extends string>({ options, active, onChange }: {
  options: { id: T; label: ReactNode; badge?: ReactNode }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div
      role="tablist"
      style={{
        display: 'inline-flex',
        backgroundColor: 'var(--bg-card)',
        borderRadius: '100px',
        padding: '3px',
      }}
    >
      {options.map(({ id, label, badge }) => {
        const isActive = active === id;
        return (
          <button
            key={id}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(id)}
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
            {badge}
          </button>
        );
      })}
    </div>
  );
}
