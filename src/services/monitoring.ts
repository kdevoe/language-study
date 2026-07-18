/**
 * Error monitoring (path-forward §0.3). Every past PWA incident — dead taps
 * from a full localStorage quota, stale-cache breakage — required getting a
 * device console from a user; with beta users on installed PWAs this surfaces
 * those failures in hours instead of days.
 *
 * Gated on VITE_SENTRY_DSN and lazy-loaded: without a DSN nothing initializes
 * and the Sentry SDK never enters the bundle's critical path, so local dev and
 * DSN-less deploys behave exactly as before. Callers use captureError()
 * unconditionally — it no-ops until init completes.
 */

const DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;

let sentry: typeof import('@sentry/react') | null = null;

export function initMonitoring(): void {
  if (!DSN) return;
  import('@sentry/react')
    .then((mod) => {
      mod.init({
        dsn: DSN,
        // Errors only — no session replay, no tracing. Keeps the free tier
        // roomy and avoids shipping user reading content anywhere.
        sendDefaultPii: false,
        tracesSampleRate: 0,
      });
      sentry = mod;
    })
    .catch((e) => console.warn('[monitoring] Sentry init failed:', e));
}

/** Report an error with optional context. Safe to call always: logs to the
 *  console in every environment, forwards to Sentry only when configured. */
export function captureError(error: unknown, context?: Record<string, unknown>): void {
  console.error('[monitoring]', error, context ?? '');
  sentry?.captureException(error, context ? { extra: context } : undefined);
}
