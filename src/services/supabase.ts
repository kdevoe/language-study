import { createClient } from '@supabase/supabase-js';

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
