// generate-podcast (#12, docs/podcast-design.md §5) — creates a two-host Japanese
// podcast episode: Gemini writes the script, ElevenLabs voices it with
// per-character timestamps, the MP3 lands in the private `podcasts` bucket.
//
// Lifecycle (podcast_episodes.status): scripting → voicing → ready | failed.
// The create call answers 202 immediately; the work runs in the background
// (EdgeRuntime.waitUntil) and the client polls the row. Script and voice run
// in SEPARATE invocations (the script stage re-invokes this function with
// {action:'voice'}) so each stage gets its own wall-clock budget — a 15-minute
// episode is ~4 TTS requests after a ~60s script generation.
//
// Auth: the caller's user comes from the JWT (not the body); service-key callers
// (a future digest cron, ops scripts) pass body.userId instead. The internal
// voice-stage call authenticates with the service role key.
//
// Requests:
//   { source: { kind: 'article', articleId } | { kind: 'digest', date? } |
//             { kind: 'topic', topic } | { kind: 'text', text, title? } | { kind: 'url', url },
//     minutes?: 5 | 10 | 15 }                       → 202 { episode } (200 for an existing digest)
//   { action: 'retry', episodeId }                  → 202 { episode }
//   { action: 'voice', episodeId }  (service only)  → 202

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { GoogleGenAI } from 'https://esm.sh/@google/genai';
import { GEMINI_FLASH, ELEVEN_DIALOGUE_MODEL } from '../_shared/models.ts';
import { pickPairing, personaById, type PairHistory, type Persona } from '../_shared/podcastCast.ts';
import {
  buildPodcastPrompt,
  normalizeScript,
  ScriptValidationError,
  CHARS_PER_MINUTE,
  type PodcastPromptInput,
  type PodcastScript,
  type PodcastSourceItem,
  type PodcastSourceKind,
} from '../_shared/podcastPrompt.ts';
import { renderDialogue } from '../_shared/elevenlabs.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const BUCKET = 'podcasts';
const ALLOWED_MINUTES = [5, 10, 15];
/** An in-flight episode older than this is treated as dead and may be retried. */
const STALE_MS = 10 * 60_000;
const MAX_IN_FLIGHT = 2;
const ROTATION_HISTORY = 12;
const DIGEST_STORIES = 3;
const DIGEST_WINDOW_MS = 36 * 3600_000;
const JINA_READER_URL = 'https://r.jina.ai/';
const URL_TIMEOUT_MS = 12_000;
const SCRIPT_MAX_ATTEMPTS = 3;
const SCRIPT_BACKOFF_MS = [500, 1500, 3000];

const EPISODE_LIST_FIELDS = 'id, title, source_kind, source_ref, minutes, status, status_detail, cast_ids, duration_ms, listen_position_ms, listened_at, created_at';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

const runInBackground = (p: Promise<unknown>) => {
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(p);
  else p.catch((e) => console.error('[generate-podcast] background job failed:', e));
};

interface EpisodeRow {
  id: string;
  user_id: string;
  source_kind: PodcastSourceKind;
  source_ref: string | null;
  source_payload: { text?: string; title?: string } | null;
  minutes: number;
  status: string;
  cast_ids: { host: string; guest: string } | null;
  script: PodcastScript | null;
  usage: Record<string, unknown> | null;
  updated_at: string;
}

// ── Script stage ─────────────────────────────────────────────────────────────

function isTransientLlmError(err: unknown): boolean {
  if (err instanceof SyntaxError || err instanceof ScriptValidationError) return true;
  const status = (err as { status?: number })?.status ?? (err as { code?: number })?.code;
  if (status === 429 || status === 500 || status === 503) return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /\b(429|500|503)\b|overload|unavailable|rate.?limit|resource.?exhausted|deadline|timeout/.test(msg);
}

async function generateScript(ai: GoogleGenAI, input: PodcastPromptInput) {
  const prompt = buildPodcastPrompt(input);
  let lastErr: unknown;
  for (let attempt = 0; attempt < SCRIPT_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await ai.models.generateContent({
        model: GEMINI_FLASH,
        contents: prompt,
        config: { responseMimeType: 'application/json' },
      });
      const raw = (result.text ?? '').replace(/^```(json)?[\s\n]*/i, '').replace(/[\s\n]*```$/i, '').trim();
      const script = normalizeScript(JSON.parse(raw), input);
      const meta = result.usageMetadata;
      return {
        script,
        usage: {
          promptTokens: meta?.promptTokenCount ?? null,
          outputTokens: meta?.candidatesTokenCount ?? null,
          attempts: attempt + 1,
        },
      };
    } catch (err) {
      lastErr = err;
      const transient = isTransientLlmError(err);
      console.warn(`[generate-podcast] script attempt ${attempt + 1}/${SCRIPT_MAX_ATTEMPTS} failed (transient=${transient}):`, err instanceof Error ? err.message : err);
      if (!transient || attempt === SCRIPT_MAX_ATTEMPTS - 1) throw err;
      await new Promise((r) => setTimeout(r, SCRIPT_BACKOFF_MS[attempt]));
    }
  }
  throw lastErr;
}

const paragraphsOf = (content: { blocks?: { type?: string; text?: string }[] } | null) =>
  (content?.blocks ?? []).filter((b) => b.type === 'paragraph' && typeof b.text === 'string').map((b) => b.text as string);

async function fetchUrlText(url: string, jinaKey: string | undefined): Promise<PodcastSourceItem | null> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), URL_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'User-Agent': 'YugenStudy/1.0', Accept: 'text/plain' };
    if (jinaKey) headers['Authorization'] = `Bearer ${jinaKey}`;
    const res = await fetch(JINA_READER_URL + url, { headers, signal: ctrl.signal });
    if (!res.ok) return null;
    const raw = await res.text();
    const title = raw.match(/^Title:\s*(.+)$/m)?.[1]?.trim() ?? '';
    const text = (raw.split(/Markdown Content:\s*/i).pop() || raw).trim();
    return text.length >= 200 ? { title, text } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(to);
  }
}

/** Resolve the episode's source material into prompt items. */
async function loadSources(supabase: SupabaseClient, ep: EpisodeRow): Promise<PodcastSourceItem[]> {
  switch (ep.source_kind) {
    case 'article': {
      const { data } = await supabase
        .from('processed_news').select('content').eq('id', ep.source_ref).eq('user_id', ep.user_id).maybeSingle();
      const paras = paragraphsOf(data?.content ?? null);
      if (!paras.length) throw new Error('source article has no text');
      return [{ title: data!.content.title ?? '', text: paras.join('\n\n') }];
    }
    case 'digest': {
      const { data } = await supabase
        .from('processed_news').select('content')
        .eq('user_id', ep.user_id).eq('source_type', 'news').in('status', ['ready', 'read'])
        .gt('created_at', new Date(Date.now() - DIGEST_WINDOW_MS).toISOString())
        .order('created_at', { ascending: false }).limit(DIGEST_STORIES);
      const items = (data ?? [])
        .map((r) => ({ title: r.content?.title ?? '', text: paragraphsOf(r.content).join('\n\n') }))
        .filter((it) => it.text.length > 0);
      if (!items.length) throw new Error('no recent feed articles for a digest');
      return items;
    }
    case 'text':
      return [{ title: ep.source_payload?.title ?? '', text: ep.source_payload?.text ?? '' }];
    case 'url': {
      const item = await fetchUrlText(ep.source_ref ?? '', Deno.env.get('JINA_API_KEY'));
      if (!item) throw new Error('could not fetch the URL');
      return [item];
    }
    case 'topic':
      return [];
  }
}

const dateLabel = (ymd: string | null) => {
  const m = ymd?.match(/^\d{4}-(\d{2})-(\d{2})$/);
  return m ? `${Number(m[1])}月${Number(m[2])}日` : undefined;
};

async function runScriptStage(supabase: SupabaseClient, episodeId: string) {
  const { data: ep } = await supabase.from('podcast_episodes').select('*').eq('id', episodeId).single<EpisodeRow>();
  if (!ep) return;
  try {
    const host = personaById(ep.cast_ids?.host ?? '');
    const guest = personaById(ep.cast_ids?.guest ?? '');
    if (!host || !guest) throw new Error('episode has no valid cast');
    const { data: prefs } = await supabase.from('user_preferences').select('jlpt_level').eq('user_id', ep.user_id).maybeSingle();
    const items = await loadSources(supabase, ep);
    const ai = new GoogleGenAI({ apiKey: Deno.env.get('GEMINI_API_KEY')!, httpOptions: { apiVersion: 'v1beta' } });
    const t0 = Date.now();
    const { script, usage } = await generateScript(ai, {
      kind: ep.source_kind,
      jlptLevel: prefs?.jlpt_level ?? 5,
      host,
      guest,
      topic: ep.source_kind === 'topic' ? ep.source_ref ?? '' : undefined,
      items,
      targetChars: ep.minutes * CHARS_PER_MINUTE,
      dateLabel: ep.source_kind === 'digest' ? dateLabel(ep.source_ref) : undefined,
    });
    await supabase.from('podcast_episodes').update({
      script,
      title: script.title,
      status: 'voicing',
      status_detail: null,
      usage: { ...(ep.usage ?? {}), script: { ...usage, ms: Date.now() - t0 } },
      updated_at: new Date().toISOString(),
    }).eq('id', episodeId);
  } catch (err) {
    await failEpisode(supabase, episodeId, 'script', err);
    return;
  }
  await startVoiceStage(supabase, episodeId);
}

// ── Voice stage ──────────────────────────────────────────────────────────────

/** Hand the voice stage to a fresh invocation (own wall-clock budget); fall
 *  back to running it here if the self-call can't be made. */
async function startVoiceStage(supabase: SupabaseClient, episodeId: string) {
  try {
    const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/generate-podcast`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'voice', episodeId }),
    });
    if (res.status === 202) return;
    console.warn(`[generate-podcast] voice self-call returned ${res.status}; voicing inline`);
  } catch (e) {
    console.warn('[generate-podcast] voice self-call failed; voicing inline:', e instanceof Error ? e.message : e);
  }
  await runVoiceStage(supabase, episodeId);
}

async function runVoiceStage(supabase: SupabaseClient, episodeId: string) {
  const { data: ep } = await supabase.from('podcast_episodes').select('*').eq('id', episodeId).single<EpisodeRow>();
  if (!ep?.script) return;
  try {
    const host = personaById(ep.cast_ids?.host ?? '');
    const guest = personaById(ep.cast_ids?.guest ?? '');
    if (!host || !guest) throw new Error('episode has no valid cast');
    const voiceOf: Record<'host' | 'guest', Persona> = { host, guest };
    const t0 = Date.now();
    const render = await renderDialogue(
      Deno.env.get('ELEVENLABS_API_KEY')!,
      ep.script.turns.map((t) => ({ text: t.text, voiceId: voiceOf[t.speaker].voiceId })),
    );
    const audioPath = `${ep.user_id}/${ep.id}.mp3`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(audioPath, render.mp3, {
      contentType: 'audio/mpeg',
      upsert: true,
    });
    if (upErr) throw new Error(`audio upload failed: ${upErr.message}`);
    await supabase.from('podcast_episodes').update({
      alignment: render.alignment,
      audio_path: audioPath,
      duration_ms: Math.round(render.durationSec * 1000),
      tts_model: ELEVEN_DIALOGUE_MODEL,
      status: 'ready',
      status_detail: null,
      usage: { ...(ep.usage ?? {}), tts: { chars: render.chars, requests: render.requests, ms: Date.now() - t0 } },
      updated_at: new Date().toISOString(),
    }).eq('id', episodeId);
  } catch (err) {
    await failEpisode(supabase, episodeId, 'voice', err);
  }
}

async function failEpisode(supabase: SupabaseClient, episodeId: string, stage: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[generate-podcast] ${stage} stage failed for ${episodeId}:`, msg);
  await supabase.from('podcast_episodes').update({
    status: 'failed',
    status_detail: `${stage}: ${msg}`.slice(0, 500),
    updated_at: new Date().toISOString(),
  }).eq('id', episodeId);
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

const isStale = (ep: { updated_at: string }) => Date.now() - new Date(ep.updated_at).getTime() > STALE_MS;

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

  // Internal: voice stage, invoked by the script stage with the service key.
  if (body.action === 'voice') {
    if (token !== serviceKey) return json(401, { error: 'unauthorized', errorKind: 'unauthorized' });
    runInBackground(runVoiceStage(supabase, String(body.episodeId)));
    return json(202, { ok: true });
  }

  // Server-side callers (a digest cron, ops scripts) act for a user with the
  // service key + body.userId; everyone else is the user in their JWT.
  let userId: string | undefined;
  if (typeof body.userId === 'string' && (await isServiceToken(token, serviceKey))) {
    userId = body.userId;
  } else {
    const { data: auth } = await supabase.auth.getUser(token);
    userId = auth?.user?.id;
  }
  if (!userId) return json(401, { error: 'sign in to make podcasts', errorKind: 'unauthorized' });

  // Retry a failed (or stale in-flight) episode from the stage it stopped at.
  if (body.action === 'retry') {
    const { data: ep } = await supabase
      .from('podcast_episodes').select('*').eq('id', String(body.episodeId)).eq('user_id', userId).maybeSingle<EpisodeRow>();
    if (!ep) return json(404, { error: 'episode not found', errorKind: 'not_found' });
    if (ep.status === 'ready') return json(200, { episode: ep });
    if (ep.status !== 'failed' && !isStale(ep)) return json(409, { error: 'episode is still being made', errorKind: 'episode_in_progress' });
    const stage = ep.script ? 'voicing' : 'scripting';
    const { data: updated } = await supabase.from('podcast_episodes')
      .update({ status: stage, status_detail: null, updated_at: new Date().toISOString() })
      .eq('id', ep.id).select(EPISODE_LIST_FIELDS).single();
    runInBackground(stage === 'voicing' ? startVoiceStage(supabase, ep.id) : runScriptStage(supabase, ep.id));
    return json(202, { episode: updated });
  }

  // ── Create ──
  const source = body.source ?? {};
  const kind = source.kind as PodcastSourceKind;
  const minutes = ALLOWED_MINUTES.includes(Number(body.minutes)) ? Number(body.minutes) : 5;
  let sourceRef: string | null = null;
  let sourcePayload: Record<string, unknown> | null = null;

  switch (kind) {
    case 'article': {
      if (typeof source.articleId !== 'string') return json(400, { error: 'articleId is required', errorKind: 'bad_request' });
      const { data } = await supabase.from('processed_news').select('id').eq('id', source.articleId).eq('user_id', userId).maybeSingle();
      if (!data) return json(404, { error: 'article not found', errorKind: 'not_found' });
      sourceRef = source.articleId;
      break;
    }
    case 'digest': {
      sourceRef = typeof source.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(source.date)
        ? source.date
        : new Date().toISOString().slice(0, 10);
      const { count } = await supabase
        .from('processed_news').select('id', { count: 'exact', head: true })
        .eq('user_id', userId).eq('source_type', 'news').in('status', ['ready', 'read'])
        .gt('created_at', new Date(Date.now() - DIGEST_WINDOW_MS).toISOString());
      if (!count) return json(422, { error: 'no recent feed articles to make a digest from', errorKind: 'digest_empty' });
      break;
    }
    case 'topic': {
      const topic = typeof source.topic === 'string' ? source.topic.trim() : '';
      if (topic.length < 2 || topic.length > 80) return json(400, { error: 'topic must be 2–80 characters', errorKind: 'bad_request' });
      sourceRef = topic;
      break;
    }
    case 'text': {
      const text = typeof source.text === 'string' ? source.text.replace(/\r\n?/g, '\n').trim() : '';
      if (text.length < 200) return json(400, { error: 'paste at least 200 characters', errorKind: 'text_too_short' });
      if (text.length > 20_000) return json(400, { error: 'text is over 20,000 characters', errorKind: 'text_too_long' });
      sourcePayload = { text, title: typeof source.title === 'string' ? source.title.slice(0, 200) : '' };
      break;
    }
    case 'url': {
      const url = typeof source.url === 'string' ? source.url.trim() : '';
      if (!/^https?:\/\/\S+$/i.test(url)) return json(400, { error: 'enter a valid http(s) URL', errorKind: 'bad_request' });
      sourceRef = url;
      break;
    }
    default:
      return json(400, { error: 'unknown source kind', errorKind: 'bad_request' });
  }

  const { data: recent } = await supabase
    .from('podcast_episodes')
    .select('id, source_kind, source_ref, status, cast_ids, updated_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50);
  const rows = recent ?? [];

  // One digest per day: hand back today's instead of making another.
  if (kind === 'digest') {
    const existing = rows.find((r) => r.source_kind === 'digest' && r.source_ref === sourceRef && r.status !== 'failed');
    if (existing) {
      const { data } = await supabase.from('podcast_episodes').select(EPISODE_LIST_FIELDS).eq('id', existing.id).single();
      return json(200, { episode: data, existing: true });
    }
  }
  const inFlight = rows.filter((r) => (r.status === 'scripting' || r.status === 'voicing') && !isStale(r));
  const duplicate = sourceRef != null && inFlight.find((r) => r.source_kind === kind && r.source_ref === sourceRef);
  if (duplicate) return json(409, { error: 'this episode is already being made', errorKind: 'episode_in_progress', episodeId: duplicate.id });
  if (inFlight.length >= MAX_IN_FLIGHT) return json(429, { error: 'two episodes are already being made — try again in a minute', errorKind: 'too_many_in_flight' });

  const history: PairHistory = rows
    .filter((r) => r.cast_ids?.host && r.cast_ids?.guest)
    .slice(0, ROTATION_HISTORY)
    .map((r) => ({ host: r.cast_ids.host, guest: r.cast_ids.guest }));
  const { host, guest } = pickPairing(history);

  const { data: episode, error } = await supabase.from('podcast_episodes').insert({
    user_id: userId,
    source_kind: kind,
    source_ref: sourceRef,
    source_payload: sourcePayload,
    minutes,
    status: 'scripting',
    cast_ids: { host: host.id, guest: guest.id },
    title: kind === 'topic' ? sourceRef : '',
  }).select(EPISODE_LIST_FIELDS).single();
  if (error || !episode) return json(500, { error: `could not create episode: ${error?.message}`, errorKind: 'server_error' });

  runInBackground(runScriptStage(supabase, episode.id));
  return json(202, { episode });
});
