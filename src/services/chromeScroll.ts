// App hides the header and bottom nav on scroll down and reveals them on scroll up.
// Scrolls the app makes itself (tab switch to top, long-form resume pre-scroll) must
// not read as the user scrolling, so they mute the handler briefly first.
let mutedUntil = 0;

export function muteChromeScroll(ms = 400) {
  mutedUntil = performance.now() + ms;
}

export function isChromeScrollMuted() {
  return performance.now() < mutedUntil;
}
