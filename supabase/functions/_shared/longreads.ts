// ハルカ's long reads, shared by write-longread (which writes them) and
// tutor-chat (which offers one when the learner asks): the server-side caps and
// the loose match against earlier long reads (docs/haruka-longform-plan.md).
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const WEEK_MAX = 4;               // pieces in any 7 days
export const WEEK_REQUESTED_MAX = 2;     // of which the learner asked for
const DAY_ATTEMPTS_MAX = 4;       // jobs started in 24 h, failed ones included
const SCHEDULED_GAP_HOURS = 20;   // one scheduled piece a night
const STALE_MINUTES = 30;         // an in-flight job this quiet has died

/** An earlier long read (ハルカ's or the learner's import), as the planners see it. */
export interface PastWork {
  id: string; title: string; sourceType: string; day: string; state: string; topic: string; summary: string;
}

/** Columns for toPastWork. */
export const PAST_WORK_COLUMNS = 'id, title, source_type, status, created_at, reading_position, meta';

// deno-lint-ignore no-explicit-any
export function toPastWork(r: any): PastWork {
  return {
    id: r.id,
    title: String(r.title ?? ''),
    sourceType: r.source_type,
    day: String(r.created_at).slice(0, 10),
    state: r.status === 'finished' ? 'finished' : (r.reading_position?.percent ?? 0) > 0 ? 'started' : 'not opened',
    topic: String(r.meta?.topic ?? ''),
    summary: String(r.meta?.summary ?? ''),
  };
}

// ── Caps ─────────────────────────────────────────────────────────────────────

export async function checkCaps(admin: SupabaseClient, userId: string, trigger: 'scheduled' | 'requested') {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  // A job that went quiet mid-stage has died: free the slot (it still counts below).
  await admin.from('longread_jobs').update({ status: 'failed', error: 'stale', updated_at: new Date().toISOString() })
    .eq('user_id', userId).in('status', ['planning', 'researching', 'writing']).lt('updated_at', iso(STALE_MINUTES * 60_000));

  const { data } = await admin.from('longread_jobs').select('trigger, status, created_at')
    .eq('user_id', userId).gt('created_at', iso(7 * 86400_000));
  const jobs = (data ?? []) as { trigger: string; status: string; created_at: string }[];
  const live = jobs.filter((j) => j.status !== 'failed' && j.status !== 'skipped');
  if (jobs.some((j) => ['planning', 'researching', 'writing'].includes(j.status))) {
    return { status: 409, kind: 'busy', message: 'ハルカ is already writing one.' };
  }
  if (live.length >= WEEK_MAX) return { status: 429, kind: 'week_limit', message: `${WEEK_MAX} long reads this week already.` };
  if (trigger === 'requested' && live.filter((j) => j.trigger === 'requested').length >= WEEK_REQUESTED_MAX) {
    return { status: 429, kind: 'week_limit', message: `${WEEK_REQUESTED_MAX} requested long reads this week already.` };
  }
  const since24h = iso(86400_000);
  if (jobs.filter((j) => j.status !== 'skipped' && j.created_at > since24h).length >= DAY_ATTEMPTS_MAX) {
    return { status: 429, kind: 'day_limit', message: 'Too many long reads started today.' };
  }
  if (trigger === 'scheduled' && jobs.some((j) => j.trigger === 'scheduled' && j.status !== 'skipped' && j.created_at > iso(SCHEDULED_GAP_HOURS * 3600_000))) {
    return { status: 409, kind: 'already', message: 'Tonight\'s long read already started.' };
  }
  return null;
}

/** How many more the learner can ask for this week (tutor-chat says so before offering). */
export async function requestsLeft(admin: SupabaseClient, userId: string): Promise<number> {
  const { data } = await admin.from('longread_jobs').select('trigger, status')
    .eq('user_id', userId).gt('created_at', new Date(Date.now() - 7 * 86400_000).toISOString());
  const live = ((data ?? []) as { trigger: string; status: string }[]).filter((j) => j.status !== 'failed' && j.status !== 'skipped');
  return Math.max(0, Math.min(WEEK_MAX - live.length, WEEK_REQUESTED_MAX - live.filter((j) => j.trigger === 'requested').length));
}

// ── Repeats: a light check, not a ban ────────────────────────────────────────

const STOP = new Set('the a an and or of in on at to for from with by about how why what who when where its it is are was were be this that these those their his her into over under after before between new old story history japan japanese world life'.split(' '));
const words = (s: string) => new Set(s.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w)));

function overlap(a: string, b: string): number {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / Math.min(x.size, y.size);
}

/** Past works whose topic or title share words with this text, closest first. */
export function relatedWorks(text: string, works: PastWork[], n = 3): PastWork[] {
  return works.map((w) => ({ w, s: Math.max(overlap(text, `${w.topic} ${w.title}`), overlap(text, w.summary) * 0.6) }))
    .filter((x) => x.s >= 0.34).sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.w);
}
