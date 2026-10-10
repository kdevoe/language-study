// Podcast episodes (#12, docs/podcast-design.md): rows in podcast_episodes are
// created and advanced by the generate-podcast edge function; the client lists
// its own rows (RLS), polls in-flight ones, streams audio from the private
// `podcasts` bucket via a signed URL, and writes back the listening position.
import { supabase } from './supabase';
import { invokeEdgeFn, isServerBusyError } from './api';
import type { SearchCorpus } from './archiveSearch';

const DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true';

export type EpisodeStatus = 'scripting' | 'voicing' | 'ready' | 'failed';
export type EpisodeSourceKind = 'article' | 'digest' | 'topic' | 'text' | 'url';

export interface PodcastEpisode {
  id: string;
  title: string;
  source_kind: EpisodeSourceKind;
  source_ref: string | null;
  minutes: number;
  status: EpisodeStatus;
  status_detail: string | null;
  cast_ids: { host: string; guest: string } | null;
  duration_ms: number | null;
  listen_position_ms: number;
  listened_at: string | null;
  created_at: string;
}

export interface PodcastTurn {
  speaker: 'host' | 'guest';
  text: string;
}

export interface PodcastVocab {
  word: string;
  reading: string;
  meaning: string;
}

/** Per turn: start/end seconds and each character's start time in ms. */
export interface TurnAlignment {
  start: number;
  end: number;
  t: number[];
}

export interface PodcastEpisodeFull extends PodcastEpisode {
  script: { title: string; turns: PodcastTurn[]; vocab: PodcastVocab[] } | null;
  alignment: TurnAlignment[] | null;
  audio_path: string | null;
}

export type EpisodeSource =
  | { kind: 'article'; articleId: string }
  | { kind: 'digest'; date: string }
  | { kind: 'topic'; topic: string }
  | { kind: 'text'; text: string; title?: string }
  | { kind: 'url'; url: string };

const LIST_FIELDS =
  'id, title, source_kind, source_ref, minutes, status, status_detail, cast_ids, duration_ms, listen_position_ms, listened_at, created_at';

export const isInFlight = (ep: Pick<PodcastEpisode, 'status'>) => ep.status === 'scripting' || ep.status === 'voicing';

/** Local calendar date (YYYY-MM-DD) — one digest per day in the user's timezone. */
export function localDateKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Dev mode ─────────────────────────────────────────────────────────────────
// VITE_DEV_MODE has no auth session, so RLS hides every row. A demo episode can
// be exported to public/podcast-dev/ (git-ignored) with
// `node scripts/spike-podcast.mjs export-dev <episodeId>`; dev mode serves that.
async function devEpisode(): Promise<PodcastEpisodeFull | null> {
  try {
    const res = await fetch('/podcast-dev/episode.json');
    return res.ok ? ((await res.json()) as PodcastEpisodeFull) : null;
  } catch {
    return null;
  }
}

export async function fetchEpisodes(): Promise<PodcastEpisode[]> {
  if (DEV_MODE) {
    const ep = await devEpisode();
    return ep ? [ep] : [];
  }
  const { data, error } = await supabase
    .from('podcast_episodes')
    .select(LIST_FIELDS)
    .order('created_at', { ascending: false })
    // The list groups by month now, so it holds the whole archive (a daily
    // digest is about 365 rows a year). Stays under PostgREST's 1000-row cap.
    .limit(900);
  if (error) throw error;
  return (data ?? []) as PodcastEpisode[];
}

/** Japanese script + English source per episode, for search (loaded on first search). */
export async function fetchEpisodeSearchText(): Promise<SearchCorpus> {
  const corpus: SearchCorpus = new Map();
  if (DEV_MODE) return corpus;
  const { data, error } = await supabase
    .from('podcast_episodes')
    .select('id, source_ref, source_payload, turns:script->turns')
    .order('created_at', { ascending: false })
    .limit(900);
  if (error) throw error;
  for (const row of data ?? []) {
    const turns = (row.turns ?? []) as unknown as PodcastTurn[];
    const payload = (row.source_payload ?? {}) as Record<string, unknown>;
    const en = [row.source_ref, payload.title, payload.text, payload.url]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .join('\n');
    corpus.set(row.id, { ja: turns.map((t) => t.text).join(' '), en });
  }
  return corpus;
}

/**
 * Delete episodes and their MP3s. Audio goes first (best effort): once the row
 * is gone nothing points at the object any more. Needs the storage delete
 * policy from database/29_archive_delete.sql.
 */
export async function deleteEpisodes(ids: string[]): Promise<void> {
  if (DEV_MODE || ids.length === 0) return;
  const { data: rows } = await supabase.from('podcast_episodes').select('audio_path').in('id', ids);
  const paths = (rows ?? []).map((r) => r.audio_path).filter((p): p is string => !!p);
  if (paths.length) {
    const { error } = await supabase.storage.from('podcasts').remove(paths);
    if (error) console.warn('[podcasts] audio delete failed (row still deleted):', error);
  }
  const { error } = await supabase.from('podcast_episodes').delete().in('id', ids);
  if (error) throw error;
}

export async function fetchEpisode(id: string): Promise<PodcastEpisodeFull> {
  if (DEV_MODE) {
    const ep = await devEpisode();
    if (ep && ep.id === id) return ep;
  }
  const { data, error } = await supabase
    .from('podcast_episodes')
    .select(`${LIST_FIELDS}, script, alignment, audio_path`)
    .eq('id', id)
    .single();
  if (error) throw error;
  return data as PodcastEpisodeFull;
}

/** `instructions`: optional listener request (≤300 chars) steering focus/tone. */
export async function createEpisode(source: EpisodeSource, minutes = 5, instructions?: string): Promise<PodcastEpisode> {
  const data = await invokeEdgeFn<{ episode: PodcastEpisode }>('generate-podcast', { source, minutes, instructions }, 30_000);
  return data.episode;
}

export async function retryEpisode(id: string): Promise<PodcastEpisode> {
  const data = await invokeEdgeFn<{ episode: PodcastEpisode }>('generate-podcast', { action: 'retry', episodeId: id }, 30_000);
  return data.episode;
}

/** Signed URL for the episode's MP3 (private bucket). */
export async function episodeAudioUrl(ep: PodcastEpisodeFull): Promise<string> {
  if (DEV_MODE && ep.audio_path?.startsWith('/')) return ep.audio_path;
  if (!ep.audio_path) throw new Error('episode has no audio yet');
  const { data, error } = await supabase.storage.from('podcasts').createSignedUrl(ep.audio_path, 6 * 3600);
  if (error || !data) throw error ?? new Error('could not sign audio URL');
  return data.signedUrl;
}

/** Persist where the listener is (debounced by the caller); `finished` stamps listened_at. */
export async function saveListenPosition(id: string, positionMs: number, finished = false): Promise<void> {
  if (DEV_MODE) return;
  const patch: Record<string, unknown> = { listen_position_ms: Math.max(0, Math.round(positionMs)) };
  if (finished) patch.listened_at = new Date().toISOString();
  const { error } = await supabase.from('podcast_episodes').update(patch).eq('id', id);
  if (error) console.error('[podcasts] saveListenPosition failed:', error);
}

/** User-facing message for a failed create/retry call. */
export async function episodeErrorMessage(error: unknown): Promise<string> {
  const e = error as { context?: Response } | null;
  let kind = '';
  try {
    kind = (await e?.context?.clone().json())?.errorKind ?? '';
  } catch {
    // body wasn't JSON
  }
  switch (kind) {
    case 'digest_empty': return 'まだ今日のニュースがありません。ニュースを読んでからもう一度試してください。';
    case 'too_many_in_flight': return 'いま2つのエピソードを作成中です。少し待ってからもう一度試してください。';
    case 'episode_in_progress': return 'このエピソードはすでに作成中です。';
    case 'text_too_short': return 'テキストは200字以上貼り付けてください。';
    case 'text_too_long': return 'テキストは20,000字以内にしてください。';
    case 'bad_request': return '入力を確認してください。';
    case 'unauthorized': return 'ログインしてください。';
    case 'not_found': return 'この記事はまだ保存されていません。少し待ってからもう一度試してください。';
  }
  if (isServerBusyError(error)) return 'サーバーが混み合っています。少し待ってからもう一度試してください。';
  return 'エピソードを作れませんでした。もう一度試してください。';
}
