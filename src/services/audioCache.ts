// On-device copies of generated audio (docs/audio-cache-retention.md).
//
// Episodes and songs stream from private buckets through signed URLs, and each
// signed URL is new, so the browser's HTTP cache never matches a second time.
// This keeps whole files in the Cache API keyed by their storage path instead:
// a hit plays from a blob: URL (instant, offline, no download); a miss streams
// as before while saveAudio() fetches the full file in the background.
//
// Everything here is best effort. iOS may clear PWA storage at any time, and
// the Cache API can be missing or throw, so a miss always falls back to
// streaming. Least recently used files are evicted past each kind's cap.
// Files the offline pack holds (offlinePack.ts) are pinned: never evicted, and
// not counted toward the caps.

import { cleanJoinedMp3 } from './mp3';

export type AudioKind = 'podcast' | 'music';

const CAPS: Record<AudioKind, { entries: number; bytes: number }> = {
  podcast: { entries: 5, bytes: 30 * 1024 * 1024 },
  music: { entries: 50, bytes: 150 * 1024 * 1024 },
};

/** Per kind: storage path → size, last use and whether the offline pack holds it. Kept as one small entry in the same cache. */
type Index = Record<string, { bytes: number; usedAt: number; pinned?: boolean }>;

const INDEX_KEY = '/audio-cache/__index';
const keyFor = (path: string) => `/audio-cache/${path}`;
const saving = new Set<string>();

/** Podcast MP3s are joined from several pieces; drop their stale per-piece
 *  headers (services/mp3.ts). Also repairs copies saved before that fix. */
export async function cleanPodcastBlob(blob: Blob): Promise<Blob> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const clean = cleanJoinedMp3(bytes);
  return clean === bytes ? blob : new Blob([clean], { type: 'audio/mpeg' });
}

async function open(kind: AudioKind): Promise<Cache | null> {
  try {
    if (typeof caches === 'undefined') return null;
    return await caches.open(`${kind}-audio`);
  } catch {
    return null;
  }
}

async function readIndex(cache: Cache): Promise<Index> {
  try {
    const res = await cache.match(INDEX_KEY);
    return res ? ((await res.json()) as Index) : {};
  } catch {
    return {};
  }
}

function writeIndex(cache: Cache, index: Index): Promise<void> {
  return cache.put(INDEX_KEY, new Response(JSON.stringify(index), { headers: { 'Content-Type': 'application/json' } }));
}

/** A blob: URL for the saved file, or null. The caller revokes it when done. */
export async function cachedAudioUrl(kind: AudioKind, path: string): Promise<string | null> {
  const cache = await open(kind);
  if (!cache) return null;
  try {
    const res = await cache.match(keyFor(path));
    if (!res) return null;
    const saved = await res.blob();
    const blob = kind === 'podcast' ? await cleanPodcastBlob(saved) : saved;
    const index = await readIndex(cache);
    index[path] = { ...index[path], bytes: blob.size, usedAt: Date.now() };
    await writeIndex(cache, index);
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

/** Fetch the whole file from `url` and keep it under `path`. Fire and forget. */
export async function saveAudio(kind: AudioKind, path: string, url: string): Promise<void> {
  const id = `${kind}:${path}`;
  if (saving.has(id)) return;
  saving.add(id);
  try {
    const cache = await open(kind);
    if (!cache || (await cache.match(keyFor(path)))) return;
    const res = await fetch(url);
    if (!res.ok) return;
    const fetched = await res.blob();
    const blob = kind === 'podcast' ? await cleanPodcastBlob(fetched) : fetched;
    const cap = CAPS[kind];
    if (blob.size > cap.bytes) return;
    await cache.put(keyFor(path), new Response(blob, { headers: { 'Content-Type': blob.type || 'audio/mpeg' } }));
    const index = await readIndex(cache);
    index[path] = { ...index[path], bytes: blob.size, usedAt: Date.now() };
    // Evict least recently used until within the cap (never the file just saved, never a pinned one).
    const byAge = Object.entries(index).filter(([, e]) => !e.pinned).sort((a, b) => a[1].usedAt - b[1].usedAt);
    let total = byAge.reduce((n, [, e]) => n + e.bytes, 0);
    let count = byAge.length;
    for (const [p, e] of byAge) {
      if (count <= cap.entries && total <= cap.bytes) break;
      if (p === path) continue;
      await cache.delete(keyFor(p));
      delete index[p];
      total -= e.bytes;
      count -= 1;
    }
    await writeIndex(cache, index);
    navigator.storage?.persist?.().catch(() => {});
  } catch (e) {
    console.warn('[audioCache] save failed:', e);
  } finally {
    saving.delete(id);
  }
}

/**
 * Pin exactly these paths for the offline pack (fetching any not saved yet from
 * `urlFor`); every other file of the kind goes back to normal LRU. Returns the
 * pinned files' total size. A file that can't be fetched is left out.
 */
export async function pinAudio(kind: AudioKind, paths: string[], urlFor: (path: string) => Promise<string>): Promise<number> {
  const cache = await open(kind);
  if (!cache) return 0;
  const want = new Set(paths);
  // Pin what's already here (and unpin the rest) first, then each new file as it
  // lands, so saving one pack file can't evict another.
  const index = await readIndex(cache);
  for (const [p, e] of Object.entries(index)) e.pinned = want.has(p) || undefined;
  await writeIndex(cache, index);
  for (const path of paths) {
    if (index[path]) continue;
    try { await saveAudio(kind, path, await urlFor(path)); } catch (e) { console.warn('[audioCache] pin fetch failed:', e); }
    const now = await readIndex(cache);
    if (now[path]) { now[path].pinned = true; await writeIndex(cache, now); }
  }
  const final = await readIndex(cache);
  return Object.values(final).reduce((n, e) => n + (e.pinned ? e.bytes : 0), 0);
}

/** Drop saved copies, e.g. when the user deletes episodes. */
export async function forgetAudio(kind: AudioKind, paths: string[]): Promise<void> {
  const cache = await open(kind);
  if (!cache || paths.length === 0) return;
  try {
    const index = await readIndex(cache);
    for (const p of paths) {
      await cache.delete(keyFor(p));
      delete index[p];
    }
    await writeIndex(cache, index);
  } catch {
    /* best effort */
  }
}
