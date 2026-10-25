// The beta gate (check_is_approved), remembered per user so the app still opens
// offline. Without this a failed check read as 'not_joined' and an approved
// learner got the waitlist screen on a flight (docs/offline-mode-plan.md, phase 1).
//
// Only 'approved' is remembered, and only for the user it was checked for, so
// it can never let a different account in. Sign-out forgets it.

import { supabase } from './supabase';

export type ApprovalStatus = 'approved' | 'waitlisted' | 'not_joined';

const KEY = 'yugen-approved-user';

export async function checkApproval(userId: string, email: string): Promise<ApprovalStatus> {
  try {
    const { data, error } = await supabase.rpc('check_is_approved', { p_email: email });
    if (!error && data) {
      if (data === 'approved') remember(userId);
      else forgetApproval();
      return data as ApprovalStatus;
    }
    if (error) console.error('Whitelist check error:', error);
  } catch (e) {
    console.error('Whitelist check error:', e);
  }
  // The check couldn't run (offline, server down): trust the last answer for this user.
  return remembered() === userId ? 'approved' : 'not_joined';
}

export function forgetApproval(): void {
  try { localStorage.removeItem(KEY); } catch { /* storage blocked */ }
}

function remember(userId: string): void {
  try { localStorage.setItem(KEY, userId); } catch { /* storage blocked: falls back to the old behaviour */ }
}

function remembered(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}
