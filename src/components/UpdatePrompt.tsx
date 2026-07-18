import { useEffect, useRef, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';

// "Update available" prompt for the PWA service worker (path-forward §0.5).
// Installed-PWA users have no reload button and repeatedly wedged on stale
// builds; the SW precaches the shell and this surfaces new versions as a tap-
// to-reload banner (styled after App's actionError toast) instead of silently
// swapping code mid-session. Also re-checks for a new worker hourly and when
// the app returns to the foreground — an installed PWA can stay "open" for
// days, and the default update check only runs on navigation.
const UPDATE_CHECK_MS = 60 * 60 * 1000;

export function UpdatePrompt() {
  const [needRefresh, setNeedRefresh] = useState(false);
  const updateSW = useRef<((reload?: boolean) => Promise<void>) | null>(null);

  useEffect(() => {
    updateSW.current = registerSW({
      onNeedRefresh: () => setNeedRefresh(true),
      onRegisteredSW: (_url, registration) => {
        if (!registration) return;
        const check = () => registration.update().catch(() => { /* offline — retry next tick */ });
        const interval = setInterval(check, UPDATE_CHECK_MS);
        const onVisible = () => { if (document.visibilityState === 'visible') check(); };
        document.addEventListener('visibilitychange', onVisible);
        // App-lifetime listeners: the prompt mounts once at the App root.
        void interval;
      },
    });
  }, []);

  if (!needRefresh) return null;

  return (
    <div
      role="status"
      onClick={() => updateSW.current?.(true)}
      style={{
        position: 'fixed',
        bottom: 'calc(5.5rem + env(safe-area-inset-bottom))',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1000,
        maxWidth: 'min(90vw, 420px)',
        padding: '0.75rem 1.1rem',
        borderRadius: '14px',
        backgroundColor: 'var(--bg-card)',
        border: '1px solid var(--border-light)',
        boxShadow: '0 6px 30px rgba(0,0,0,0.12)',
        color: 'var(--text-main)',
        fontSize: '0.85rem',
        lineHeight: 1.4,
        cursor: 'pointer',
        textAlign: 'center',
      }}
    >
      新しいバージョンがあります — tap to update
    </div>
  );
}
