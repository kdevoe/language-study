// ハルカ, the tutor (docs/tutor-agent-design.md): client side of the tutor-chat
// edge function. Replies stream as server-sent events; history, the recap and
// the Home card's opener are plain requests.
import { supabase, supabaseAnonKey, supabaseUrl } from './supabase';
import { foreground } from './foreground';
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
  /** Home on Sunday: the weekly recap the opener announces (shown under it). */
  recapId?: string;
  /** Home after a long-read night: the long read the opener announces (shown under it). */
  work?: WorkRef;
}

export interface TutorMessage {
  id: string;
  role: 'user' | 'assistant' | 'context';
  text: string | null;
  /** Screen notes, or on your messages the photo you sent (its transcript, never the image). */
  context?: (ScreenContext & { photo?: undefined; recap?: undefined })
    | { photo: { id: string; label?: string; transcript?: string } }
    | { recap?: RecapRef; work?: WorkRef }
    | null;
}

/** The weekly recap's block in the thread: enough to draw it, the report loads on tap. */
export interface RecapRef { id: string; title: string }

/** A row in 進捗's list of weekly recaps. */
export type RecapListItem = Pick<WeeklyRecap, 'id' | 'week_start' | 'week_end' | 'title'>;

/** A long read ハルカ wrote, as a block in the thread that opens it (write-longread). */
export interface WorkRef { id: string; title: string }

/** ハルカ's weekly recap (learner-dream/recap.ts, database/41). */
export interface WeeklyRecap {
  id: string;
  week_start: string;
  week_end: string;
  title: string;
  report: {
    intro: string;
    lede: string;
    patterns: { title: string; short: string; count: number; examples: { was: string; now: string; fix?: string }[]; explain: string[]; tip: string }[];
    words: { word: string; meaning: string }[];
    solid: string;
  };
}

export type TutorAction =
  | { type: 'add_to_deck'; word: string; reading: string; meaning: string }
  | { type: 'grammar_rating'; pointId: string; rating: 'easy' | 'medium' | 'hard'; why: string }
  | { type: 'content_queued'; kind: 'podcast'; topic: string; episodeId?: string }
  // An offer the learner confirms: the tutor never starts paid generation itself.
  | { type: 'content_offer'; kind: 'podcast'; topic: string; angle?: string }
  | { type: 'content_offer'; kind: 'longform'; topic: string; english?: string; angle?: string }
  | { type: 'preference'; prefs: { correction?: string; asides?: string } };

export type TutorEvent =
  | { type: 'thread'; threadId: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string }
  // A background lookup started: its facts land in the thread later (pollResearch).
  | { type: 'research'; id: string; question: string }
  | { type: 'action'; action: TutorAction }
  | { type: 'photo'; id: string; label: string; transcript: string }
  // A long read that landed: its block goes under the line she's writing.
  | { type: 'work'; work: WorkRef }
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
/** ハルカ's reply stream. Counted as foreground for its whole length, so the offline pack waits for it. */
export function streamTutor(...args: Parameters<typeof streamTutorRaw>): Promise<void> {
  return foreground(streamTutorRaw(...args));
}

async function streamTutorRaw(
  input:
    | { action?: 'send'; message: string; context?: ScreenContext; opener?: string; recapId?: string; workId?: string; newThread?: boolean; image?: PhotoUpload }
    | { action: 'followup'; threadId: string; researchId: string },
  onEvent: (e: TutorEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (DEV_MODE) return devReply(input as Parameters<typeof devReply>[0], onEvent);
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
 *  locally. A message with 調べ in it starts a fake lookup that lands after ~4s;
 *  one with 長い記事 offers a long read, which "lands" the same way. */
const devLongreads = new Set<string>();
async function devReply(input: Parameters<typeof streamTutor>[0], onEvent: (e: TutorEvent) => void) {
  const say = async (text: string) => {
    for (let i = 0; i < text.length; i += 6) {
      await new Promise((r) => setTimeout(r, 40));
      onEvent({ type: 'text', text: text.slice(i, i + 6) });
    }
  };
  onEvent({ type: 'thread', threadId: 'dev' });
  if (input.action === 'followup' && devLongreads.has(input.researchId)) {
    const text = 'できたよ！本棚に入れておいたから、時間があるときに読んでみてね。';
    await say(text);
    onEvent({ type: 'work', work: { id: '00000000-0000-4000-8000-00000000dev2', title: '宇宙ステーションの歴史' } });
    onEvent({ type: 'done', text });
    return;
  }
  if (input.action !== 'followup' && input.message.includes('長い記事')) {
    const text = 'いいね！宇宙ステーションの歴史について書こうか。';
    await say(text);
    onEvent({ type: 'action', action: { type: 'content_offer', kind: 'longform', topic: '宇宙ステーションの歴史', english: 'history of space stations' } });
    onEvent({ type: 'done', text });
    return;
  }
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

/** ハルカ's line for the Home card: last night's first opener (null = keep a quiet
 *  default). On Sunday it announces the weekly recap, and recapId names it; after
 *  a long-read night it may announce the long read, and work names it. */
export async function fetchOpener(): Promise<{ line: string; recapId?: string; work?: WorkRef } | null> {
  if (DEV_MODE) return DEV_RECAP_ON ? { line: DEV_RECAP_TEASER, recapId: DEV_RECAP.id } : null;
  const { data } = await supabase.from('learner_briefs').select('brief').order('day', { ascending: false }).limit(1).maybeSingle();
  const brief = data?.brief as { openers?: string[]; recap?: { id?: string }; longread?: { id?: string; title?: string } } | undefined;
  const line = brief?.openers?.[0];
  if (typeof line !== 'string' || !line.trim()) return null;
  const lr = brief?.longread;
  // The block goes with the line that announces it: first unless a recap teaser leads.
  const work = typeof lr?.id === 'string' && typeof lr.title === 'string' && !brief?.recap ? { id: lr.id, title: lr.title } : undefined;
  return { line: line.trim(), ...(typeof brief?.recap?.id === 'string' && { recapId: brief.recap.id }), ...(work && { work }) };
}

/** Start the long read ハルカ offered (write-longread, with the learner's own
 *  session and caps). Its note lands in the thread; poll it like a lookup. */
export async function startLongread(input: { topic: string; angle?: string; threadId: string | null }): Promise<string> {
  if (DEV_MODE) { const id = `dev-${Date.now()}`; devLongreads.add(id); return id; }
  const res = await invokeEdgeFn<{ jobId: string }>('write-longread', { action: 'start', trigger: 'requested', ...input });
  return res.jobId;
}

export async function longreadErrorMessage(error: unknown): Promise<string> {
  const e = error as { context?: Response } | null;
  let kind = '';
  try { kind = (await e?.context?.clone().json())?.errorKind ?? ''; } catch { /* body wasn't JSON */ }
  switch (kind) {
    case 'busy': return 'いま別の記事を書いています。できたら知らせるね。';
    case 'week_limit': return '今週はもうたくさん書きました。また来週ね。';
    case 'day_limit': return '今日はここまで。また明日ね。';
  }
  return '記事を書き始められませんでした。もう一度試してください。';
}

/** What ハルカと練習する says for you, from the chat or from 進捗. */
export const practiceLine = (pattern: string) => `「${pattern}」を練習したい！`;

export const recapRange = (r: Pick<WeeklyRecap, 'week_start' | 'week_end'>) => {
  const fmt = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
  return `${fmt(r.week_start)} – ${fmt(r.week_end)}`;
};

/** Every weekly recap, newest first (進捗's list); the reports load when one is opened. */
export async function fetchRecaps(): Promise<RecapListItem[]> {
  if (DEV_MODE) return DEV_RECAP_ON ? [{ id: DEV_RECAP.id, week_start: DEV_RECAP.week_start, week_end: DEV_RECAP.week_end, title: DEV_RECAP.title }] : [];
  const { data, error } = await supabase.from('weekly_recaps').select('id, week_start, week_end, title')
    .order('week_end', { ascending: false }).limit(100);
  if (error) throw error;
  return (data ?? []) as RecapListItem[];
}

export async function fetchRecap(id: string): Promise<WeeklyRecap | null> {
  if (DEV_MODE) return id === DEV_RECAP.id ? DEV_RECAP : null;
  const { data } = await supabase.from('weekly_recaps').select('id, week_start, week_end, title, report').eq('id', id).maybeSingle();
  return (data as WeeklyRecap | null) ?? null;
}

// Dev mode (no session): a sample recap on the Home card, from real data
// (docs/mockups/weekly-recap.html). Turn it off with localStorage yugen-dev-recap = 'off'.
const DEV_RECAP_ON = (() => { try { return localStorage.getItem('yugen-dev-recap') !== 'off'; } catch { return true; } })();
const DEV_RECAP_TEASER = '今週のまとめができたよ。い形容詞とな形容詞が、まだちょっと混ざってるね。';
const DEV_RECAP: WeeklyRecap = {
  id: '00000000-0000-4000-8000-00000000dev1', week_start: '2026-10-12', week_end: '2026-10-18',
  title: 'い / な adjectives · で vs に · nouns after particles',
  report: {
    intro: '今週もいっぱい話せたね！三つだけ、何回も出てきたことがあるよ。',
    lede: "Most of what you wrote this week was natural. These three slips came up again and again. They're all small, and fixing them will make everything you say sound cleaner.",
    patterns: [
      { title: 'い and な adjectives get mixed up', short: 'い / な adjectives', count: 7,
        examples: [{ was: '若いなのに', now: '若いのに', fix: '若いのに' }, { was: '古いな杉', now: '古い杉', fix: '古い' }, { was: '好きので', now: '好きなので', fix: '好きな' }, { was: '大事と思う', now: '大事だと思う', fix: '大事だ' }, { was: '強いで', now: '強くて', fix: '強くて' }],
        explain: ['い-adjectives (若い・古い・強い) work on their own: no な before a noun, no だ before と思う, and the て-form is い→くて.', 'な-adjectives (好き・大事・残念) behave like nouns. They need な before a noun or ので, and だ before と思う or けど.'],
        tip: 'Before ので, のに, けど or と思う, stop for a second and ask: い or な?' },
      { title: "で where it doesn't belong", short: 'で vs に', count: 4,
        examples: [{ was: '旅館で泊まります', now: '旅館に泊まります', fix: 'に' }, { was: '本社で大きな公園があって', now: '本社に大きな公園があって', fix: 'に' }, { was: 'ゆっくりで散歩する', now: 'ゆっくり散歩する', fix: 'ゆっくり' }],
        explain: ['で marks where an action happens (食べる・働く). に marks where something is, or where you end up (ある・いる・住む・泊まる). Adverbs like ゆっくり take no particle at all.'],
        tip: 'With ある, いる, 住む or 泊まる, the place takes に.' },
      { title: 'A verb where a noun belongs', short: 'nouns after particles', count: 4,
        examples: [{ was: '打ち上げる', now: '打ち上げ', fix: '打ち上げ' }, { was: '話す', now: '昨日の話', fix: '話' }, { was: '集中するのことが', now: '集中しているところが', fix: '集中しているところ' }],
        explain: ['について, の and が need a noun in front. Use the noun form (話・打ち上げ) or add の or こと, but never both.'],
        tip: 'When a particle follows a verb, check whether it wants a noun.' },
    ],
    words: [{ word: '字引', meaning: 'dictionary' }, { word: '浸ける', meaning: 'to soak' }, { word: '講堂', meaning: 'auditorium' }, { word: '被る', meaning: 'to wear (a hat)' }, { word: 'ずつ', meaning: 'each' }, { word: '屋上', meaning: 'rooftop' }],
    solid: '〜ように and 行ったことがない came out natural, with no help. Your sentences are getting longer, too.',
  },
};

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
    supabase.from('weekly_recaps').delete().eq('user_id', uid),
    supabase.from('longread_jobs').delete().eq('user_id', uid),
  ]);
}
