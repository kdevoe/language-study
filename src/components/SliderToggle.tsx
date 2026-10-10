import type { CSSProperties, ReactNode } from 'react';

// The app's one-of-n choice control (docs/design-system.md §6.1): a
// --border-light track with a white thumb that slides under the labels.
// Width follows importance — full width for a primary choice, a fixed compact
// width for a secondary one.

const EASE = '0.4s cubic-bezier(0.4, 0, 0.2, 1)';

export interface SliderOption<T> {
  value: T;
  label: ReactNode;
}

interface Props<T> {
  options: readonly SliderOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Track width; defaults to the full row. */
  width?: CSSProperties['width'];
  fontSize?: CSSProperties['fontSize'];
  ariaLabel?: string;
  style?: CSSProperties;
}

export function SliderToggle<T extends string | number>({
  options,
  value,
  onChange,
  width = '100%',
  fontSize = '0.85rem',
  ariaLabel,
  style,
}: Props<T>) {
  const n = options.length;
  const active = Math.max(0, options.findIndex((o) => o.value === value));

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      style={{
        display: 'flex',
        position: 'relative',
        width,
        flexShrink: 0,
        height: '45px',
        padding: '4px',
        borderRadius: '100px',
        backgroundColor: 'var(--border-light)',
        ...style,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: '4px',
          bottom: '4px',
          left: `calc(4px + ${active} * (100% - 8px) / ${n})`,
          width: `calc((100% - 8px) / ${n})`,
          backgroundColor: 'var(--bg-pure)',
          borderRadius: '100px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
          transition: `all ${EASE}`,
          zIndex: 0,
        }}
      />
      {options.map((o, i) => {
        const isActive = i === active;
        return (
          <button
            key={String(o.value)}
            role="radio"
            aria-checked={isActive}
            onClick={() => onChange(o.value)}
            style={{
              flex: 1,
              position: 'relative',
              zIndex: 1,
              border: 'none',
              outline: 'none',
              borderRadius: '100px',
              backgroundColor: 'transparent',
              cursor: 'pointer',
              fontFamily: 'var(--font-sans)',
              fontSize,
              fontWeight: isActive ? 700 : 600,
              color: isActive ? 'var(--text-main)' : 'var(--text-muted)',
              transition: `color ${EASE}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              whiteSpace: 'nowrap',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
