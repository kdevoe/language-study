import { createClient, processLock } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.replace(/['"]/g, '') || 'https://placeholder.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.replace(/['"]/g, '') || 'placeholder';

// Create a single supabase client for interacting with your database.
// Auth options are explicit so session persistence + token refresh behaviour is
// not left to defaults that can drift between supabase-js versions.
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce',
    // Use the in-memory process lock instead of the default navigator.locks lock.
    // In a long-lived iOS standalone PWA, a token auto-refresh that starts just as
    // iOS suspends the WebView can leave the navigator.locks lock held and never
    // released; every later getSession()/refresh then blocks on it, so all
    // session-dependent actions (article open, word-lookup sync) stall while
    // local-only UI keeps working. processLock serializes in-memory within this
    // single window — correct for a one-window PWA — and cannot deadlock that way.
    lock: processLock,
  },
});

// ── Session recovery on tab return ────────────────────────────────────────────
// Browsers throttle/pause timers in backgrounded tabs (and the OS pauses them on
// sleep), so the auto-refresh tick can miss the ~1h access-token expiry. When the
// tab becomes visible/focused again we proactively restart auto-refresh and call
// getSession(), which refreshes an expired token. This heals BOTH edge-function
// calls and direct PostgREST queries (word lookup) that would otherwise 401.
if (typeof window !== 'undefined') {
  const recover = () => {
    if (document.visibilityState === 'visible') {
      supabase.auth.startAutoRefresh();
      // Fire-and-forget; refreshes the token if it has expired while we were away.
      void supabase.auth.getSession();
    } else {
      supabase.auth.stopAutoRefresh();
    }
  };
  document.addEventListener('visibilitychange', recover);
  window.addEventListener('focus', recover);
  window.addEventListener('online', recover);
}
