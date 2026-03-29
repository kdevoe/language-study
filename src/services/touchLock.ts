/**
 * Simple shared module to prevent accidental taps immediately after peeking or closing drawers.
 * This handles the "ghost click" sensitivity on mobile devices.
 */
export const touchLock = {
  lastReleaseTime: 0,
  
  lock: () => {
    touchLock.lastReleaseTime = Date.now();
  },
  
  isLocked: () => {
    return (Date.now() - touchLock.lastReleaseTime) < 200;
  }
};
