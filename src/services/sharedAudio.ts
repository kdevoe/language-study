// One <audio> element for everything the app plays (podcasts now, music later),
// so opening an item can start it playing on its own.
//
// iOS only lets an element play programmatically after that same element has
// been played inside a user gesture. The player loads its episode and signed
// URL over the network after the tap, which is too late for a fresh element.
// So the tap that opens an item calls unlockSharedAudio(): it plays a 10ms
// silent clip on the shared element while the gesture is still live. The
// player then swaps in the real source on that element and play() is allowed.

// 10ms of 8kHz 8-bit mono silence.
const SILENT_WAV =
  'data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==';

let element: HTMLAudioElement | null = null;

/** The app's single audio element, created on first use. */
export function sharedAudio(): HTMLAudioElement {
  if (!element) {
    element = new Audio();
    element.preload = 'auto';
  }
  return element;
}

/** True while the element still holds the unlock clip (not a real source). */
export function isUnlockClip(audio: HTMLAudioElement | null): boolean {
  return !!audio && audio.src === SILENT_WAV;
}

/** Call synchronously in the tap handler that opens something to play. */
export function unlockSharedAudio(): void {
  const audio = sharedAudio();
  if (!audio.paused) return; // already playing: it's unlocked, and this would cut it off
  audio.src = SILENT_WAV;
  audio.play().catch(() => { /* blocked or replaced by the real source: the player falls back to its play button */ });
}
