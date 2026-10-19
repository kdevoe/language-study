// generate-song (聞く › 音楽, docs/music-design.md) — writes and records an
// original Japanese song: Claude writes it from the reader's known lexicon
// plus a few review words (the same vocabulary articles use), ElevenLabs Music
// sings it with phrase timestamps, Gemini paints the cover. MP3 and JPEG land
// in the private `music` bucket.
//
// Lifecycle (songs.status): writing → composing → ready | failed. Each stage
// runs in its own invocation (self-call with the service key), so a slow Claude
// call and a slow recording each get a full wall-clock budget.
//
// Requests:
//   { style: <preset id> | 'custom', request?, theme?, minutes?: 1|2|3 }  → 202 { song }
//   { action: 'retry', songId }                                          → 202 { song }
//   { action: 'write' | 'compose', songId }       (service key only)     → 202
//   { action: 'auto' }   (x-cron-secret: SONG_CRON_SECRET, daily pg_cron) → 200 { created, skipped }
//
// Automatic songs (database/32_song_auto.sql): every other day by default, for
// readers who studied since their last one, with no more than 2 unplayed.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CLAUDE_OPUS, ELEVEN_MUSIC_MODEL, GEMINI_IMAGE } from '../_shared/models.ts';
import {
  COVER_STYLE_MAX_CHARS,
  DEFAULT_COVER_STYLE,
  SONG_STYLES,
  SONG_PLAN_TOOL,
  PlanValidationError,
  buildSongPrompt,
  historyItem,
  lineTimings,
  normalizePlan,
  styleById,
  toCompositionPlan,
  type SongPlan,
  type SongStyle,
} from '../_shared/songPrompt.ts';
import { buildLexicon, pickReviewWords, pickTargetWords, LEXICON_MIN_WORDS } from '../_shared/readerVocab.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const BUCKET = 'music';
const ALLOWED_MINUTES = [1, 2, 3];
const STALE_MS = 10 * 60_000;
const MAX_IN_FLIGHT = 2;
const MAX_PER_DAY = 10;
const MAX_REQUEST_CHARS = 600;
const MAX_THEME_CHARS = 80;
const REVIEW_WORDS = 4;
const WRITE_MAX_ATTEMPTS = 2;
const MUSIC_TIMEOUT_MS = 300_000;
const HISTORY_DAYS = 30;
const HISTORY_SONGS = 40;

// Automatic songs
const AUTO_MINUTES = 2;
const AUTO_ACTIVE_DAYS = 2;          // fan out over readers who studied in the last 2 days
const AUTO_MIN_STUDY_EVENTS = 20;    // …and did some real studying since their last auto song
const AUTO_MAX_UNPLAYED = 2;         // a backlog of unplayed songs pauses new ones
const AUTO_MAX_USERS = 500;

const SONG_LIST_FIELDS = 'id, title, style_key, theme, minutes, status, status_detail, origin, cover_path, duration_ms, play_count, last_played_at, created_at';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

const runInBackground = (p: Promise<unknown>) => {
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(p);
  else p.catch((e) => console.error('[generate-song] background job failed:', e));
};

interface SongRow {
  id: string;
  user_id: string;
  style_key: string;
  request: string | null;
  theme: string | null;
  minutes: number;
  status: string;
  origin: 'manual' | 'auto';
  plan: SongPlan | null;
  usage: Record<string, unknown> | null;
  updated_at: string;
}

// ── Write stage: Claude ──────────────────────────────────────────────────────

async function writePlan(prompt: string): Promise<{ raw: unknown; usage: Record<string, unknown> }> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_OPUS,
      max_tokens: 12000,
      tools: [SONG_PLAN_TOOL],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(`claude ${res.status}: ${body?.error?.message ?? 'request failed'}`), { status: res.status });
  const tool = (body?.content ?? []).find((c: { type: string }) => c.type === 'tool_use');
  if (!tool) throw new PlanValidationError('claude returned no plan');
  return { raw: tool.input, usage: { inputTokens: body.usage?.input_tokens ?? null, outputTokens: body.usage?.output_tokens ?? null } };
}

const isTransient = (err: unknown) => {
  if (err instanceof PlanValidationError) return true;
  const status = (err as { status?: number })?.status;
  return status === 429 || status === 500 || status === 529 || status === 503;
};

async function runWriteStage(supabase: SupabaseClient, songId: string) {
  const { data: song } = await supabase.from('songs').select('*').eq('id', songId).single<SongRow>();
  if (!song) return;
  try {
    const { data: prefs } = await supabase.from('user_preferences').select('jlpt_level').eq('user_id', song.user_id).maybeSingle();
    const [lexicon, review, targets, recentTitles, history] = await Promise.all([
      buildLexicon(supabase, song.user_id).catch((e) => { console.warn('[generate-song] lexicon failed:', e); return [] as string[]; }),
      pickReviewWords(supabase, song.user_id, REVIEW_WORDS).catch((e) => { console.warn('[generate-song] review words failed:', e); return []; }),
      // This week's new cards (intake v2 target words): two lead the review list.
      pickTargetWords(supabase, song.user_id, 2).catch(() => []),
      song.theme ? Promise.resolve([] as string[]) : recentReadTitles(supabase, song.user_id),
      songHistory(supabase, song.user_id, song.id),
    ]);
    const style = song.style_key === 'custom' ? null : styleById(song.style_key) ?? SONG_STYLES[0];
    const input = {
      jlptLevel: prefs?.jlpt_level ?? 5,
      minutes: song.minutes,
      style,
      request: song.request ?? undefined,
      theme: song.theme ?? undefined,
      lexicon: lexicon.length >= LEXICON_MIN_WORDS ? lexicon : undefined,
      reviewWords: [...new Set([...targets.map((t) => t.word), ...review.map((r) => r.word)])],
      recentTitles,
      history,
    };
    const prompt = buildSongPrompt(input);
    const t0 = Date.now();
    let plan: SongPlan | null = null;
    let usage: Record<string, unknown> = {};
    for (let attempt = 1; !plan; attempt++) {
      try {
        const out = await writePlan(prompt);
        plan = normalizePlan(out.raw, input);
        usage = { ...out.usage, attempts: attempt };
      } catch (err) {
        if (attempt >= WRITE_MAX_ATTEMPTS || !isTransient(err)) throw err;
        console.warn(`[generate-song] write attempt ${attempt} failed:`, err instanceof Error ? err.message : err);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    console.log(`[generate-song] wrote ${songId}: "${plan.title}", ${plan.sections.length} sections, lexicon=${input.lexicon?.length ?? 0}, review=[${input.reviewWords.join('、')}]`);
    await supabase.from('songs').update({
      plan,
      title: plan.title,
      // The listener's own words are replaced by the artist-free rewrite.
      request: song.style_key === 'custom' ? plan.request_clean : null,
      status: 'composing',
      status_detail: null,
      usage: { ...(song.usage ?? {}), write: { ...usage, ms: Date.now() - t0, lexiconWords: input.lexicon?.length ?? 0, reviewWords: input.reviewWords } },
      updated_at: new Date().toISOString(),
    }).eq('id', songId);
  } catch (err) {
    await failSong(supabase, songId, 'write', err);
    return;
  }
  await selfCall('compose', songId, () => runComposeStage(supabase, songId));
}

/** The reader's songs from the past month that got as far as a plan, newest first. */
async function songHistory(supabase: SupabaseClient, userId: string, exceptId: string) {
  const { data } = await supabase
    .from('songs').select('id, style_key, theme, plan')
    .eq('user_id', userId).not('plan', 'is', null).neq('id', exceptId)
    .gt('created_at', new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString())
    .order('created_at', { ascending: false }).limit(HISTORY_SONGS);
  return (data ?? []).map((r) => historyItem(r.plan as SongPlan, styleById(r.style_key)?.label ?? 'custom', r.theme));
}

async function recentReadTitles(supabase: SupabaseClient, userId: string): Promise<string[]> {
  const { data } = await supabase
    .from('processed_news').select('content, title')
    .eq('user_id', userId).eq('status', 'read')
    .gt('read_at', new Date(Date.now() - 3 * 86_400_000).toISOString())
    .order('read_at', { ascending: false }).limit(3);
  return (data ?? []).map((r) => r.content?.title ?? r.title ?? '').filter(Boolean);
}

// ── Compose stage: ElevenLabs (song) + Gemini (cover), in parallel ───────────

class BadPromptError extends Error {}

async function composeSong(plan: SongPlan) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), MUSIC_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.elevenlabs.io/v1/music/detailed?output_format=mp3_44100_128', {
      method: 'POST',
      headers: { 'xi-api-key': Deno.env.get('ELEVENLABS_API_KEY')!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ composition_plan: toCompositionPlan(plan), model_id: ELEVEN_MUSIC_MODEL, with_timestamps: true }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const detail = body?.detail;
      if (detail?.status === 'bad_prompt') throw new BadPromptError(`bad_prompt: ${detail?.message ?? ''}`.slice(0, 300));
      throw new Error(`elevenlabs ${res.status}: ${JSON.stringify(detail ?? body).slice(0, 300)}`);
    }
    const boundary = res.headers.get('content-type')?.match(/boundary=([^;]+)/)?.[1];
    if (!boundary) throw new Error('elevenlabs: no multipart boundary');
    const parts = parseMultipart(new Uint8Array(await res.arrayBuffer()), boundary);
    const meta = parts.find((p) => /application\/json/i.test(p.type));
    const audio = parts.find((p) => /audio\//i.test(p.type));
    if (!meta || !audio) throw new Error('elevenlabs: response missing a part');
    const info = JSON.parse(new TextDecoder().decode(meta.body));
    return { mp3: audio.body, words: (info.words_timestamps ?? []) as { word: string; start_ms: number; end_ms: number }[], songId: res.headers.get('song-id') };
  } finally {
    clearTimeout(to);
  }
}

/** Split a multipart/mixed body into parts (headers' Content-Type + raw body). */
function parseMultipart(buf: Uint8Array, boundary: string): { type: string; body: Uint8Array }[] {
  const enc = new TextEncoder();
  const delim = enc.encode(`--${boundary}`);
  const indexOf = (needle: Uint8Array, from: number) => {
    outer: for (let i = from; i <= buf.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) if (buf[i + j] !== needle[j]) continue outer;
      return i;
    }
    return -1;
  };
  const parts: { type: string; body: Uint8Array }[] = [];
  let at = indexOf(delim, 0);
  while (at >= 0) {
    const start = at + delim.length;
    if (buf[start] === 45 && buf[start + 1] === 45) break; // closing "--"
    const next = indexOf(delim, start);
    if (next < 0) break;
    const headerEnd = indexOf(enc.encode('\r\n\r\n'), start);
    if (headerEnd < 0 || headerEnd > next) break;
    const headers = new TextDecoder().decode(buf.subarray(start, headerEnd));
    let end = next;
    if (buf[end - 2] === 13 && buf[end - 1] === 10) end -= 2; // CRLF before the delimiter
    parts.push({ type: headers.match(/content-type:\s*([^\r\n]+)/i)?.[1] ?? '', body: buf.subarray(headerEnd + 4, end) });
    at = next;
  }
  return parts;
}

// Scene from the songwriter, look from the listener's art direction (or the default).
async function paintCover(scene: string, artDirection: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE}:generateContent?key=${Deno.env.get('GEMINI_API_KEY')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Square album cover art.\nScene: ${scene}\nArt direction: ${artDirection}\nAn illustration, not a photograph: no photorealism, no 3D render, no glossy lighting. The artwork fills the whole square edge to edge: no border, frame, margin or paper edge around it. No text, letters, words or logos anywhere in the image. No recognisable real people.` }] }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '1:1', imageSize: '512' } },
      }),
    });
    const body = await res.json().catch(() => null);
    const part = body?.candidates?.[0]?.content?.parts?.find((p: { inlineData?: unknown }) => p.inlineData);
    if (!res.ok || !part) {
      console.warn('[generate-song] cover failed:', res.status, JSON.stringify(body?.error ?? body?.promptFeedback ?? {}).slice(0, 200));
      return null;
    }
    return Uint8Array.from(atob(part.inlineData.data), (c) => c.charCodeAt(0));
  } catch (e) {
    console.warn('[generate-song] cover failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

async function runComposeStage(supabase: SupabaseClient, songId: string) {
  const { data: song } = await supabase.from('songs').select('*').eq('id', songId).single<SongRow>();
  if (!song?.plan) return;
  const plan = song.plan;
  try {
    const t0 = Date.now();
    const { data: prefs } = await supabase.from('user_preferences').select('song_cover_style').eq('user_id', song.user_id).maybeSingle();
    const artDirection = (typeof prefs?.song_cover_style === 'string' && prefs.song_cover_style.trim().slice(0, COVER_STYLE_MAX_CHARS)) || DEFAULT_COVER_STYLE;
    const [music, cover] = await Promise.all([composeSong(plan), paintCover(plan.cover_prompt, artDirection)]);
    const audioPath = `${song.user_id}/${song.id}.mp3`;
    // Never re-rendered once ready, so caches may keep it a year (docs/audio-cache-retention.md).
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(audioPath, music.mp3, { contentType: 'audio/mpeg', cacheControl: '31536000', upsert: true });
    if (upErr) throw new Error(`audio upload failed: ${upErr.message}`);
    let coverPath: string | null = null;
    if (cover) {
      const path = `${song.user_id}/${song.id}.jpg`;
      const { error } = await supabase.storage.from(BUCKET).upload(path, cover, { contentType: 'image/jpeg', cacheControl: '31536000', upsert: true });
      if (error) console.warn('[generate-song] cover upload failed:', error.message);
      else coverPath = path;
    }
    const timing = lineTimings(plan, music.words);
    const matched = timing.flat().filter(Boolean).length;
    console.log(`[generate-song] composed ${songId} in ${Date.now() - t0}ms: ${music.words.length} phrases, ${matched}/${timing.flat().length} lines timed, cover=${!!coverPath}`);
    await supabase.from('songs').update({
      audio_path: audioPath,
      cover_path: coverPath,
      timing,
      duration_ms: plan.sections.reduce((n, s) => n + s.duration_ms, 0),
      song_model: ELEVEN_MUSIC_MODEL,
      status: 'ready',
      status_detail: null,
      usage: { ...(song.usage ?? {}), compose: { ms: Date.now() - t0, phrases: music.words.length, linesTimed: matched, elevenSongId: music.songId } },
      updated_at: new Date().toISOString(),
    }).eq('id', songId);
  } catch (err) {
    // A rejected plan (e.g. it read as a real artist's song) is rewritten on retry.
    if (err instanceof BadPromptError) await supabase.from('songs').update({ plan: null }).eq('id', songId);
    await failSong(supabase, songId, 'compose', err);
  }
}

async function failSong(supabase: SupabaseClient, songId: string, stage: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[generate-song] ${stage} stage failed for ${songId}:`, msg);
  await supabase.from('songs').update({
    status: 'failed',
    status_detail: `${stage}: ${msg}`.slice(0, 500),
    updated_at: new Date().toISOString(),
  }).eq('id', songId);
}

/** Run a stage in a fresh invocation (own wall-clock budget); inline if the call fails. */
async function selfCall(action: 'write' | 'compose', songId: string, inline: () => Promise<void>) {
  try {
    const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/generate-song`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, songId }),
    });
    if (res.status === 202) return;
    console.warn(`[generate-song] ${action} self-call returned ${res.status}; running inline`);
  } catch (e) {
    console.warn(`[generate-song] ${action} self-call failed; running inline:`, e instanceof Error ? e.message : e);
  }
  await inline();
}

// ── Automatic songs ──────────────────────────────────────────────────────────

const utcDay = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

/** Pick a style for an automatic song from the past month's songs: never one of
 *  the last two; styles this reader plays weigh more, styles already used a lot
 *  this month weigh less, so the month stays varied but leans to what they like.
 *  The children's style only for N5/N4 readers. */
function pickAutoStyle(jlptLevel: number, recent: { style_key: string; play_count: number }[], allowed: string[] | null): SongStyle {
  const lastTwo = new Set(recent.slice(0, 2).map((r) => r.style_key));
  const plays = new Map<string, number>();
  const uses = new Map<string, number>();
  for (const r of recent) {
    plays.set(r.style_key, (plays.get(r.style_key) ?? 0) + Math.min(5, r.play_count));
    uses.set(r.style_key, (uses.get(r.style_key) ?? 0) + 1);
  }
  // The reader's chosen styles (Settings › 聞く); fall back to all if the filter empties it.
  const chosen = SONG_STYLES.filter((s) => !allowed?.length || allowed.includes(s.id));
  const fits = (s: SongStyle) => !lastTwo.has(s.id) && (!s.minLevel || jlptLevel >= s.minLevel);
  const pool = chosen.filter(fits).length ? chosen.filter(fits) : chosen.length ? chosen : SONG_STYLES;
  const weights = pool.map((s) => (1 + (plays.get(s.id) ?? 0)) / (1 + (uses.get(s.id) ?? 0)));
  let x = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < pool.length; i++) if ((x -= weights[i]) < 0) return pool[i];
  return pool[0] ?? SONG_STYLES[0];
}

/** Why this reader gets no automatic song today, or null if they should. */
async function autoSkipReason(supabase: SupabaseClient, userId: string, frequency: string): Promise<string | null> {
  if (frequency === 'off') return 'off';
  const { data: songs } = await supabase
    .from('songs').select('origin, status, play_count, created_at, updated_at')
    .eq('user_id', userId).order('created_at', { ascending: false }).limit(30);
  const rows = songs ?? [];
  if (rows.some((r) => (r.status === 'writing' || r.status === 'composing') && Date.now() - Date.parse(r.updated_at) < STALE_MS)) return 'in_flight';
  const auto = rows.filter((r) => r.origin === 'auto' && r.status !== 'failed');
  // Calendar days, not a rolling window, so the run time can't drift the cadence.
  const gapDays = frequency === 'daily' ? 1 : 2;
  const today = utcDay(new Date());
  const lastDay = auto[0] ? utcDay(auto[0].created_at) : null;
  if (lastDay && (Date.parse(today) - Date.parse(lastDay)) / 86_400_000 < gapDays) return 'too_soon';
  if (auto.filter((r) => r.status === 'ready' && r.play_count === 0).length >= AUTO_MAX_UNPLAYED) return 'unplayed_backlog';
  const since = auto[0]?.created_at ?? new Date(Date.now() - AUTO_ACTIVE_DAYS * 86_400_000).toISOString();
  const { count } = await supabase.from('study_history').select('id', { count: 'exact', head: true }).eq('user_id', userId).gt('created_at', since);
  if ((count ?? 0) < AUTO_MIN_STUDY_EVENTS) return 'no_new_study';
  return null;
}

async function runAuto(supabase: SupabaseClient) {
  const since = new Date(Date.now() - AUTO_ACTIVE_DAYS * 86_400_000).toISOString();
  const { data: active } = await supabase.from('study_history').select('user_id').gt('created_at', since).limit(20_000);
  const userIds = Array.from(new Set((active ?? []).map((r) => r.user_id as string))).slice(0, AUTO_MAX_USERS);
  const created: string[] = [];
  const skipped: Record<string, number> = {};
  for (const userId of userIds) {
    try {
      const { data: prefs } = await supabase.from('user_preferences').select('jlpt_level, song_frequency, song_styles').eq('user_id', userId).maybeSingle();
      const reason = await autoSkipReason(supabase, userId, prefs?.song_frequency ?? 'every_other_day');
      if (reason) { skipped[reason] = (skipped[reason] ?? 0) + 1; continue; }
      const { data: recent } = await supabase.from('songs').select('style_key, play_count').eq('user_id', userId).neq('status', 'failed')
        .gt('created_at', new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString()).order('created_at', { ascending: false }).limit(HISTORY_SONGS);
      const style = pickAutoStyle(prefs?.jlpt_level ?? 5, recent ?? [], prefs?.song_styles ?? null);
      const { data: song, error } = await supabase.from('songs').insert({
        user_id: userId, style_key: style.id, minutes: AUTO_MINUTES, origin: 'auto', status: 'writing',
      }).select('id').single();
      if (error || !song) throw error ?? new Error('insert failed');
      created.push(song.id);
      // Each song gets its own invocation; the write stage chains into compose.
      runInBackground(selfCall('write', song.id, () => runWriteStage(supabase, song.id)));
    } catch (e) {
      skipped.error = (skipped.error ?? 0) + 1;
      console.error(`[generate-song] auto for ${userId} failed:`, e instanceof Error ? e.message : e);
    }
  }
  console.log(`[generate-song] auto: ${userIds.length} active, created ${created.length}, skipped ${JSON.stringify(skipped)}`);
  return { active: userIds.length, created: created.length, skipped };
}

// ── Request handling ─────────────────────────────────────────────────────────

/** True when `token` carries service-role rights. The platform's injected key
 *  and a caller's copy can differ in format (legacy JWT vs sb_secret_…), so
 *  beyond an exact match we ask the admin API whether the token is accepted. */
async function isServiceToken(token: string, serviceKey: string): Promise<boolean> {
  if (!token) return false;
  if (token === serviceKey) return true;
  const probe = createClient(Deno.env.get('SUPABASE_URL')!, token, { auth: { persistSession: false } });
  const { error } = await probe.auth.admin.listUsers({ page: 1, perPage: 1 });
  return !error;
}

const isStale = (s: { updated_at: string }) => Date.now() - new Date(s.updated_at).getTime() > STALE_MS;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey);
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'invalid JSON body', errorKind: 'bad_request' });
  }

  // Internal stages, invoked with the service key (or ops scripts holding one).
  if (body.action === 'write' || body.action === 'compose') {
    if (!(await isServiceToken(token, serviceKey))) return json(401, { error: 'unauthorized', errorKind: 'unauthorized' });
    const id = String(body.songId);
    runInBackground(body.action === 'write' ? runWriteStage(supabase, id) : runComposeStage(supabase, id));
    return json(202, { ok: true });
  }

  // Daily cron (database/32_song_auto.sql): a shared secret, not a user.
  if (body.action === 'auto') {
    const secret = Deno.env.get('SONG_CRON_SECRET');
    if (!secret || req.headers.get('x-cron-secret') !== secret) return json(401, { error: 'unauthorized', errorKind: 'unauthorized' });
    return json(200, await runAuto(supabase));
  }

  const { data: auth } = await supabase.auth.getUser(token);
  const userId = auth?.user?.id;
  if (!userId) return json(401, { error: 'sign in to make songs', errorKind: 'unauthorized' });

  if (body.action === 'retry') {
    const { data: song } = await supabase.from('songs').select('*').eq('id', String(body.songId)).eq('user_id', userId).maybeSingle<SongRow>();
    if (!song) return json(404, { error: 'song not found', errorKind: 'not_found' });
    if (song.status === 'ready') return json(200, { song });
    if (song.status !== 'failed' && !isStale(song)) return json(409, { error: 'song is still being made', errorKind: 'song_in_progress' });
    const stage = song.plan ? 'composing' : 'writing';
    const { data: updated } = await supabase.from('songs')
      .update({ status: stage, status_detail: null, updated_at: new Date().toISOString() })
      .eq('id', song.id).select(SONG_LIST_FIELDS).single();
    runInBackground(stage === 'composing' ? runComposeStage(supabase, song.id) : runWriteStage(supabase, song.id));
    return json(202, { song: updated });
  }

  // ── Create ──
  const styleKey = String(body.style ?? '');
  if (styleKey !== 'custom' && !styleById(styleKey)) return json(400, { error: 'unknown style', errorKind: 'bad_request' });
  const request = typeof body.request === 'string' ? body.request.trim().slice(0, MAX_REQUEST_CHARS) : '';
  if (styleKey === 'custom' && request.length < 8) return json(400, { error: 'describe the song in a few words', errorKind: 'bad_request' });
  const theme = typeof body.theme === 'string' ? body.theme.trim().slice(0, MAX_THEME_CHARS) : '';
  const minutes = ALLOWED_MINUTES.includes(Number(body.minutes)) ? Number(body.minutes) : 2;

  const { data: recent } = await supabase
    .from('songs').select('id, status, created_at, updated_at')
    .eq('user_id', userId).order('created_at', { ascending: false }).limit(30);
  const rows = recent ?? [];
  const inFlight = rows.filter((r) => (r.status === 'writing' || r.status === 'composing') && !isStale(r));
  if (inFlight.length >= MAX_IN_FLIGHT) return json(429, { error: 'two songs are already being made — try again in a minute', errorKind: 'too_many_in_flight' });
  const today = utcDay(new Date());
  if (rows.filter((r) => utcDay(r.created_at) === today).length >= MAX_PER_DAY) {
    return json(429, { error: `that's ${MAX_PER_DAY} songs today — more tomorrow`, errorKind: 'daily_limit' });
  }

  const { data: song, error } = await supabase.from('songs').insert({
    user_id: userId,
    style_key: styleKey,
    request: styleKey === 'custom' ? request : null,
    theme: theme || null,
    minutes,
    origin: 'manual',
    status: 'writing',
  }).select(SONG_LIST_FIELDS).single();
  if (error || !song) return json(500, { error: `could not create song: ${error?.message}`, errorKind: 'server_error' });

  runInBackground(runWriteStage(supabase, song.id));
  return json(202, { song });
});
