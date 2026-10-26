import { useSyncExternalStore } from 'react';

// Whether the device has a connection (navigator.onLine), for the offline
// states in existing UI (docs/offline-mode-plan.md, phase 5): create buttons
// dim, ハルカ waits, the feed says why it's empty.

const subscribe = (fn: () => void) => {
  window.addEventListener('online', fn);
  window.addEventListener('offline', fn);
  return () => {
    window.removeEventListener('online', fn);
    window.removeEventListener('offline', fn);
  };
};

export const useOnline = () => useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
