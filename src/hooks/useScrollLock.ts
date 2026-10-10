import { useEffect } from 'react';

// Freezes page scroll while a modal or bottom sheet is open, so a swipe on the
// backdrop or sheet doesn't scroll the page behind it. Locks both <html> and
// <body> (iOS Safari only honors the lock on the root). Ref-counted so
// overlapping overlays (a sheet, then WordModal) don't unlock each other early.

let locks = 0;

export function useScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    if (locks++ === 0) {
      document.documentElement.style.overflow = 'hidden';
      document.body.style.overflow = 'hidden';
    }
    return () => {
      if (--locks === 0) {
        document.documentElement.style.overflow = '';
        document.body.style.overflow = '';
      }
    };
  }, [active]);
}
