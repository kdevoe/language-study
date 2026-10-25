import { createClient, processLock, type Session } from '@supabase/supabase-js';

// The env values may carry literal quotes (the production ones do): use these, not import.meta.env.
export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.replace(/['"]/g, '') || 'https://placeholder.supabase.co';
export const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.replace(/['"]/g, '') || 'placeholder';

// supabase-js's default key, named so storedSession() can read it.
const storageKey = `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`;

// Create a single supabase client for interacting with your database.
// Auth options are explicit so session persistence + token refresh behaviour is
// not left to defaults that can drift between supabase-js versions.
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce',
    storageKey,
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

/**
 * The signed-in session as saved on the device, even if its access token has
 * expired. Offline, an expired token can't be refreshed: auth-js keeps the
 * session saved (a network failure isn't a sign-out) but reports null, which
 * would show the landing page mid-flight. The app uses this to stay signed in;
 * the 'online' recovery below refreshes the token when the network is back.
 * A real sign-out or a rejected refresh removes the saved copy, so this is null then.
 */
export function storedSession(): Session | null {
  try {
    const raw = localStorage.getItem(storageKey);
    const session = raw ? (JSON.parse(raw) as Session) : null;
    return session?.user?.id && session.refresh_token ? session : null;
  } catch {
    return null;
  }
}

/**
 * The signed-in user's id, also offline. getSession() can't refresh an expired
 * token without a network and reports null after its retries, which made every
 * progress write on a long flight skip itself before reaching the outbox.
 */
export async function sessionUserId(): Promise<string | null> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return storedSession()?.user.id ?? null;
  const { data: { session } } = await supabase.auth.getSession();
  return session?.user?.id ?? storedSession()?.user.id ?? null;
}

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
