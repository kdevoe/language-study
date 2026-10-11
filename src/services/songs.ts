// Generated songs (聞く › 音楽, docs/music-design.md): rows in `songs` are made
// and advanced by the generate-song edge function; the client lists its own
// rows (RLS), polls in-flight ones, plays audio and shows covers from the
// private `music` bucket via signed URLs, and writes back play stats.
import { supabase } from './supabase';
import { invokeEdgeFn, isServerBusyError } from './api';
import { writeListCache } from './listCache';
import { forgetAudio } from './audioCache';

const DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true';

export type SongStatus = 'writing' | 'composing' | 'ready' | 'failed';

export interface Song {
  id: string;
  title: string;
  style_key: string;
  theme: string | null;
  minutes: number;
  status: SongStatus;
  status_detail: string | null;
  origin: 'manual' | 'auto';
  cover_path: string | null;
  duration_ms: number | null;
  play_count: number;
  last_played_at: string | null;
  created_at: string;
}

export interface SongSection {
  name: string;
  lines: string[];
  duration_ms: number;
}

export interface SongFull extends Song {
  plan: { title: string; sections: SongSection[]; vocab: { word: string; reading: string; meaning: string }[] } | null;
  /** Per section, per line: when it's sung (ms), or null when it couldn't be matched. */
  timing: ({ start: number; end: number } | null)[][] | null;
  audio_path: string | null;
}

export interface NewSong {
  style: string; // a preset id or 'custom'
  request?: string;
  theme?: string;
  minutes: number;
}

const LIST_FIELDS = 'id, title, style_key, theme, minutes, status, status_detail, origin, cover_path, duration_ms, play_count, last_played_at, created_at';

export const isSongInFlight = (s: Pick<Song, 'status'>) => s.status === 'writing' || s.status === 'composing';

// ── Dev mode ─────────────────────────────────────────────────────────────────
// No auth session, so RLS hides every row: dev mode serves a demo song from
// public/music-dev/ (git-ignored) — song.json plus its audio and cover.
async function devSong(): Promise<SongFull | null> {
  try {
    const res = await fetch('/music-dev/song.json');
    return res.ok ? ((await res.json()) as SongFull) : null;
  } catch {
    return null;
  }
}

export async function fetchSongs(): Promise<Song[]> {
  if (DEV_MODE) {
    const s = await devSong();
    return s ? [s] : [];
  }
  const { data, error } = await supabase
    .from('songs').select(LIST_FIELDS)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  const songs = (data ?? []) as Song[];
  writeListCache('songs', songs);
  return songs;
}

export async function fetchSong(id: string): Promise<SongFull> {
  if (DEV_MODE) {
    const s = await devSong();
    if (s && s.id === id) return s;
  }
  const { data, error } = await supabase
    .from('songs').select(`${LIST_FIELDS}, plan, timing, audio_path`)
    .eq('id', id).single();
  if (error) throw error;
  return data as SongFull;
}

export async function createSong(song: NewSong): Promise<Song> {
  const data = await invokeEdgeFn<{ song: Song }>('generate-song', song, 30_000);
  return data.song;
}

export async function retrySong(id: string): Promise<Song> {
  const data = await invokeEdgeFn<{ song: Song }>('generate-song', { action: 'retry', songId: id }, 30_000);
  return data.song;
}

/** Delete songs with their audio and cover (and any copy saved on this device). */
export async function deleteSongs(ids: string[]): Promise<void> {
  if (DEV_MODE || ids.length === 0) return;
  const { data: rows } = await supabase.from('songs').select('audio_path, cover_path').in('id', ids);
  const audio = (rows ?? []).map((r) => r.audio_path).filter((p): p is string => !!p);
  const files = [...audio, ...(rows ?? []).map((r) => r.cover_path).filter((p): p is string => !!p)];
  forgetAudio('music', audio);
  if (files.length) {
    const { error } = await supabase.storage.from('music').remove(files);
    if (error) console.warn('[songs] file delete failed (row still deleted):', error);
  }
  const { error } = await supabase.from('songs').delete().in('id', ids);
  if (error) throw error;
}

/** Signed URL for a file in the private `music` bucket (dev: served from public/). */
export async function songFileUrl(path: string): Promise<string> {
  if (DEV_MODE && path.startsWith('/')) return path;
  const { data, error } = await supabase.storage.from('music').createSignedUrl(path, 6 * 3600);
  if (error || !data) throw error ?? new Error('could not sign song URL');
  return data.signedUrl;
}

// ── Covers ───────────────────────────────────────────────────────────────────
// Signed URLs carry a new token each time, which would defeat the browser's
// image cache, so each cover's URL is signed for a week and reused until it
// nears expiry (kept in memory and a small localStorage map).
const COVER_TTL_S = 7 * 86_400;
const COVER_KEY = 'yugen-cover-urls';
let coverMemo: Record<string, { url: string; exp: number }> | null = null;

function loadCoverMemo() {
  if (coverMemo) return coverMemo;
  try {
    coverMemo = JSON.parse(localStorage.getItem(COVER_KEY) ?? '{}') ?? {};
  } catch {
    coverMemo = {};
  }
  return coverMemo!;
}

/** Cover URLs for these paths, signing only the ones not already held. */
export async function coverUrls(paths: string[]): Promise<Record<string, string>> {
  const memo = loadCoverMemo();
  const now = Date.now();
  const out: Record<string, string> = {};
  const need: string[] = [];
  for (const p of paths) {
    if (DEV_MODE && p.startsWith('/')) out[p] = p;
    else if (memo[p] && memo[p].exp - now > 86_400_000) out[p] = memo[p].url;
    else need.push(p);
  }
  if (need.length) {
    const { data } = await supabase.storage.from('music').createSignedUrls(need, COVER_TTL_S);
    for (const d of data ?? []) {
      if (!d.signedUrl || !d.path) continue;
      out[d.path] = d.signedUrl;
      memo[d.path] = { url: d.signedUrl, exp: now + COVER_TTL_S * 1000 };
    }
    // Keep only what's still in use, so the map can't grow without bound.
    const keep = new Set(paths);
    for (const k of Object.keys(memo)) if (!keep.has(k) && memo[k].exp < now) delete memo[k];
    try { localStorage.setItem(COVER_KEY, JSON.stringify(memo)); } catch { /* quota or blocked: memory covers this session */ }
  }
  return out;
}

/** Count a play (opening the song). */
export async function recordPlay(song: Pick<Song, 'id' | 'play_count'>): Promise<void> {
  if (DEV_MODE) return;
  const { error } = await supabase.from('songs')
    .update({ play_count: song.play_count + 1, last_played_at: new Date().toISOString() })
    .eq('id', song.id);
  if (error) console.error('[songs] recordPlay failed:', error);
}

/** User-facing message for a failed create/retry call. */
export async function songErrorMessage(error: unknown): Promise<string> {
  const e = error as { context?: Response } | null;
  let kind = '';
  try {
    kind = (await e?.context?.clone().json())?.errorKind ?? '';
  } catch {
    // body wasn't JSON
  }
  switch (kind) {
    case 'too_many_in_flight': return 'いま2曲を作成中です。少し待ってからもう一度試してください。';
    case 'daily_limit': return '今日はもう10曲作りました。また明日。';
    case 'song_in_progress': return 'この曲はまだ作成中です。';
    case 'bad_request': return '入力を確認してください。';
    case 'unauthorized': return 'ログインしてください。';
  }
  if (isServerBusyError(error)) return 'サーバーが混み合っています。少し待ってからもう一度試してください。';
  return '曲を作れませんでした。もう一度試してください。';
}
