// ハルカ, the tutor (docs/tutor-agent-design.md): client side of the tutor-chat
// edge function. Replies stream as server-sent events; history, the recap and
// the Home card's opener are plain requests.
import { supabase, supabaseAnonKey, supabaseUrl } from './supabase';
import { invokeEdgeFn } from './api';
import type { PhotoUpload } from './tutorPhotos';

/** What the screen behind the panel shows (each screen registers one). */
export interface ScreenContext {
  screen: string;
  /** Short label for the context chip; absent = no chip (Home, lists). */
  chip?: string;
  /** What ハルカ is told, in plain English with the Japanese quoted ('' = nothing to tell). */
  detail: string;
  /** Home only: ハルカ's first line for a fresh thread (the card's line). */
  opener?: string;
}

export interface TutorMessage {
  id: string;
  role: 'user' | 'assistant' | 'context';
  text: string | null;
  /** Screen notes, or on your messages the photo you sent (its transcript, never the image). */
  context?: (ScreenContext & { photo?: undefined }) | { photo: { id: string; label?: string; transcript?: string } } | null;
}

export type TutorAction =
  | { type: 'add_to_deck'; word: string; reading: string; meaning: string }
  | { type: 'grammar_rating'; pointId: string; rating: 'easy' | 'medium' | 'hard'; why: string }
  | { type: 'content_queued'; kind: 'podcast'; topic: string; episodeId?: string }
  // An offer the learner confirms: the tutor never starts paid generation itself.
  | { type: 'content_offer'; kind: 'podcast'; topic: string; angle?: string }
  | { type: 'preference'; prefs: { correction?: string; asides?: string } };

export type TutorEvent =
  | { type: 'thread'; threadId: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string }
  // A background lookup started: its facts land in the thread later (pollResearch).
  | { type: 'research'; id: string; question: string }
  | { type: 'action'; action: TutorAction }
  | { type: 'photo'; id: string; label: string; transcript: string }
  | { type: 'ping' }   // server heartbeat, every 15 s (the watchdog's sign of life)
  | { type: 'done'; text: string }
  | { type: 'error'; error: string };

const DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true';

/** The learner's local calendar day: a thread lasts one day (design §4). */
export const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export async function fetchTutorHistory(): Promise<{ threadId: string | null; messages: TutorMessage[] }> {
  if (DEV_MODE) return { threadId: null, messages: [] };
  const res = await invokeEdgeFn<{ thread: { id: string } | null; messages: TutorMessage[] }>('tutor-chat', { action: 'history', day: localDay() });
  return { threadId: res.thread?.id ?? null, messages: res.messages ?? [] };
}

/** Which of these background lookups have landed in the thread. */
export async function pollResearch(threadId: string, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  if (DEV_MODE) return ids.filter((id) => Date.now() - Number(id.split('-')[1]) > 4000);
  const res = await invokeEdgeFn<{ done: string[] }>('tutor-chat', { action: 'research_status', threadId, ids });
  return res.done ?? [];
}

/**
 * Send a message (or, with action 'followup', let ハルカ share a lookup that
 * landed while the chat was quiet) and stream the reply. Resolves when the
 * stream ends; a skipped followup ends with no events.
 */
export async function streamTutor(
  input:
    | { action?: 'send'; message: string; context?: ScreenContext; opener?: string; newThread?: boolean; image?: PhotoUpload }
    | { action: 'followup'; threadId: string; researchId: string },
  onEvent: (e: TutorEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (DEV_MODE) return devReply(input, onEvent);
  // Watchdog: no response within 25 s, or 60 s without a byte once streaming (the
  // server pings every 15 s), means a dead connection, often a stale one after
  // iOS resumes the PWA. Give up and say so instead of showing dots for minutes.
  const wd = new AbortController();
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number) => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; wd.abort(); }, ms); };
  const onAbort = () => wd.abort();
  signal?.addEventListener('abort', onAbort);
  const post = (token: string) => fetch(`${supabaseUrl}/functions/v1/tutor-chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: supabaseAnonKey,
    },
    body: JSON.stringify({ action: 'send', day: localDay(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, ...input }),
    signal: wd.signal,
  });
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('sign in required');
    arm(25_000);
    let res = await post(session.access_token);
    // A long-idle PWA session can carry an expired token (as in invokeEdgeFn): refresh once and retry.
    if (res.status === 401) {
      const { data: refreshed } = await supabase.auth.refreshSession();
      arm(25_000);
      if (refreshed.session) res = await post(refreshed.session.access_token);
    }
    if (!res.ok || !res.body) throw new Error(`tutor-chat ${res.status}`);
    if (!(res.headers.get('Content-Type') ?? '').includes('text/event-stream')) return; // followup skipped
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      arm(60_000);
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        try { onEvent(JSON.parse(line.slice(6)) as TutorEvent); } catch { /* partial or malformed */ }
      }
    }
  } catch (e) {
    if (stalled) throw new Error('tutor-chat timeout');
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Dev mode has no session: canned, streamed replies so the panel can be driven
 *  locally. A message with 調べ in it starts a fake lookup that lands after ~4s. */
async function devReply(input: Parameters<typeof streamTutor>[0], onEvent: (e: TutorEvent) => void) {
  const say = async (text: string) => {
    for (let i = 0; i < text.length; i += 6) {
      await new Promise((r) => setTimeout(r, 40));
      onEvent({ type: 'text', text: text.slice(i, i + 6) });
    }
  };
  onEvent({ type: 'thread', threadId: 'dev' });
  if (input.action === 'followup') {
    const text = 'さっきの、調べたよ！NHKによると、新しい図書館は土曜日に開いたんだって。行ってみたい？';
    await say(text);
    onEvent({ type: 'done', text });
    return;
  }
  if (input.message.includes('調べ')) {
    await say('え、気になる！調べておくね。');
    onEvent({ type: 'tool', name: 'research' });
    onEvent({ type: 'research', id: `dev-${Date.now()}`, question: 'dev lookup' });
    await new Promise((r) => setTimeout(r, 300));
    const text = '\nところで、週末は何をする予定？';
    await say(text);
    onEvent({ type: 'done', text });
    return;
  }
  const text = 'いいね、お寺<fix was="に" why="で marks where you do something">で</fix>写真を撮りたいんだ。\nどのお寺に行くの？';
  await say(text);
  onEvent({ type: 'action', action: { type: 'add_to_deck', word: '紅葉', reading: 'こうよう', meaning: 'autumn leaves' } });
  onEvent({ type: 'done', text });
}

/** ハルカ's line for the Home card: last night's first opener, else a quiet default. */
export async function fetchOpener(): Promise<string | null> {
  if (DEV_MODE) return null;
  const { data } = await supabase.from('learner_briefs').select('brief').order('day', { ascending: false }).limit(1).maybeSingle();
  const line = (data?.brief as { openers?: string[] } | undefined)?.openers?.[0];
  return typeof line === 'string' && line.trim() ? line.trim() : null;
}

// ── "What ハルカ knows" (Settings) ───────────────────────────────────────────

export interface ProfileItem {
  id: string;
  kind: string;
  text: string;
  evidence: string;
  importance: number;
  lastSeen: string;
  persona?: string;
}
export interface ProfileVersion {
  version: number;
  created_at: string;
  profile: { summary: string; items: ProfileItem[] };
  changes: { added: string[]; faded: string[]; updated: string[] } | null;
}

export async function fetchProfile(): Promise<ProfileVersion | null> {
  const { data } = await supabase.from('learner_profile_versions')
    .select('version, created_at, profile, changes')
    .eq('accepted', true).order('version', { ascending: false }).limit(1).maybeSingle();
  return (data as ProfileVersion | null) ?? null;
}

/** Delete one line: a new 'edit' version without it, plus a 'forget' note so a
 *  later dream never writes it back. */
export async function forgetProfileItem(current: ProfileVersion, itemId: string): Promise<ProfileVersion | null> {
  const { data: { session } } = await supabase.auth.getSession();
  const uid = session?.user?.id;
  const item = current.profile.items.find((i) => i.id === itemId);
  if (!uid || !item) return null;
  const { data: last } = await supabase.from('learner_profile_versions').select('version')
    .order('version', { ascending: false }).limit(1).maybeSingle();
  const next = {
    user_id: uid,
    version: Math.max(current.version, last?.version ?? 0) + 1,
    kind: 'edit',
    profile: { ...current.profile, items: current.profile.items.filter((i) => i.id !== itemId) },
    changes: { added: [], faded: [item.text], updated: [] },
  };
  const [{ data, error }] = await Promise.all([
    supabase.from('learner_profile_versions').insert(next).select('version, created_at, profile, changes').single(),
    supabase.from('learner_notes').insert({ user_id: uid, kind: 'forget', source: 'user', text: item.text }),
  ]);
  if (error) { console.error('[tutor] forget failed:', error); return null; }
  return data as ProfileVersion;
}

/** Forget everything: profiles, digests, briefs, notes and conversations. */
export async function forgetEverything(): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession();
  const uid = session?.user?.id;
  if (!uid) return;
  await Promise.all([
    supabase.from('learner_profile_versions').delete().eq('user_id', uid),
    supabase.from('learner_digests').delete().eq('user_id', uid),
    supabase.from('learner_briefs').delete().eq('user_id', uid),
    supabase.from('learner_notes').delete().eq('user_id', uid),
    supabase.from('tutor_threads').delete().eq('user_id', uid),
  ]);
}
