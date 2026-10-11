import { createContext, useContext } from 'react';
import { AdaptiveLabel } from './AdaptiveLabel';
import type { UiLabelId } from '../services/uiLabels';

// A tab page's one heading (docs/design-system.md §6.9): the page title on the
// left, the settings mark on the right, and nothing above it — there is no
// global header on tab pages. Page controls (search, segment) sit right below.

/** Opens Settings; provided by App so tabs don't thread a prop through. */
export const OpenSettingsContext = createContext<() => void>(() => {});

export function PageHeading({ id, settingsMark = true }: { id: UiLabelId; settingsMark?: boolean }) {
  return (
    // 2.75rem + 1rem = 3.75rem, the space App's tab padding gave up (see App main).
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: '2.75rem', marginBottom: '1rem' }}>
      <h1 className="serif" translate="no" style={{ fontSize: '2rem', fontWeight: 500, lineHeight: 1.2, color: 'var(--text-main)' }}>
        <AdaptiveLabel id={id} event />
      </h1>
      {settingsMark && <SettingsMark />}
    </div>
  );
}

/** Thin slider lines: reads as settings, quieter than a gear. */
export function SettingsMark() {
  const openSettings = useContext(OpenSettingsContext);
  return (
    <button
      onClick={openSettings}
      aria-label="Settings"
      style={{
        width: '44px', height: '44px', marginRight: '-10px', border: 'none', background: 'none', cursor: 'pointer',
        color: 'var(--text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" aria-hidden="true">
        <path d="M4 8h9M17 8h3M4 16h3M11 16h9" />
        <circle cx="15" cy="8" r="2" />
        <circle cx="9" cy="16" r="2" />
      </svg>
    </button>
  );
}
