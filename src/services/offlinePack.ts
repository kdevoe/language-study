// The offline pack (docs/offline-mode-plan.md, phase 4): with "Keep for
// offline" on in Settings, the device keeps enough to read and listen without a
// connection, refreshed while online:
//
//   - the ready news buffer (up to 10 articles), enriched, so the feed and the
//     Reader work offline;
//   - the next parts of the 3 most recent active 本棚 works, from the reading
//     position on (only parts that already exist: packing never asks the server
//     to write anything);
//   - the 5 newest unfinished 番組 episodes, script and audio;
//   - songs from the reader's lists, then the most played, about 150 minutes,
//     with audio and covers.
//
// Records live in IndexedDB (packStore.ts, which the loaders read); audio is
// pinned in the audio cache so normal eviction leaves it alone. Built when the
// toggle goes on, then refreshed on launch or return to the app once it's over
// 6 hours old (not on a metered or Data Saver connection). Cleared when the
// toggle goes off and on sign-out.

import { useSyncExternalStore } from 'react';
import {
  ensureBuffer, fetchProcessedArticleById, fetchReadyBufferArticles, fetchWorkParts, fetchWorks,
  workPartArticleId, type NewsArticle,
} from './api';
import { enrichArticle, isEnriched } from './enrich';
import { ensureLocalDict } from './localDict';
import { pinAudio } from './audioCache';
import { episodeAudioUrl, fetchEpisode, fetchEpisodes, type PodcastEpisodeFull } from './podcasts';
import { fetchSong, fetchSongs, keepCovers, songFileUrl } from './songs';
import { loadPlaylists, type Playlist } from './playlists';
import { readListCache } from './listCache';
import { getTokenizer } from './tokenizer';
import { dropPacked, isOffline, packedKeys, putPacked, type PackKey } from './packStore';

const NEWS = 10;
const WORKS = 3;
const PARTS_PER_WORK = 6;
const EPISODES = 5;
const SONG_MINUTES = 150;
const SONGS = 40;
const STALE_MS = 6 * 3600_000;

export type PackPhase = 'none' | 'saving' | 'ready' | 'cleared';
export interface PackStatus { phase: PackPhase; done: number; total: number; bytes: number }

// What was built, for the next launch: when, for whom, how big. A small
// localStorage entry; the records themselves are in IndexedDB.
interface PackMeta { userId: string; builtAt: number; bytes: number }
const META_KEY = 'yugen-offline-pack';
const readMeta = (): PackMeta | null => {
  try { return JSON.parse(localStorage.getItem(META_KEY) ?? 'null') as PackMeta | null; } catch { return null; }
};
const writeMeta = (m: PackMeta | null) => {
  try { if (m) localStorage.setItem(META_KEY, JSON.stringify(m)); else localStorage.removeItem(META_KEY); } catch { /* quota or blocked */ }
};

// ── Status, for Settings ─────────────────────────────────────────────────────
let status: PackStatus = { phase: 'none', done: 0, total: 0, bytes: 0 };
const listeners = new Set<() => void>();
function setStatus(next: PackStatus) {
  status = next;
  listeners.forEach((fn) => fn());
}
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const usePackStatus = () => useSyncExternalStore(subscribe, () => status);

/** Status from what's on the device: 'cleared' when the pack should be there and isn't (the OS cleared it). */
async function settle(): Promise<void> {
  const meta = readMeta();
  const keys = await packedKeys();
  setStatus(meta && keys.length
    ? { phase: 'ready', done: 0, total: 0, bytes: meta.bytes }
    : { phase: 'cleared', done: 0, total: 0, bytes: 0 });
}

// ── Build ────────────────────────────────────────────────────────────────────
const sizeOf = (v: unknown) => new Blob([JSON.stringify(v)]).size;

async function enriched(article: NewsArticle): Promise<NewsArticle> {
  if (!article.blocks || isEnriched(article.blocks)) return article;
  return { ...article, blocks: await enrichArticle(article.blocks) };
}

let building: Promise<void> | null = null;

/** Build or refresh the pack now (single-flight). New records land before stale ones go, so a failed refresh keeps the last pack. */
export function buildPack(userId: string): Promise<void> {
  if (building) return building;
  building = (async () => {
    const written = new Set<string>();
    let bytes = 0;
    let done = 0;
    let total = 0;
    const tick = () => setStatus({ phase: 'saving', done, total, bytes: 0 });
    const put = async (key: PackKey, value: unknown) => {
      await putPacked(key, value);
      written.add(key);
      bytes += sizeOf(value);
    };
    tick();
    try {
      void navigator.storage?.persist?.().catch(() => {});
      // The dictionary (one-time, large) downloads alongside; online
      // enrichment below doesn't need it.
      const dict = ensureLocalDict();

      // Plan everything first so progress has a total.
      await ensureBuffer(userId);
      const [news, works, episodes, songs] = await Promise.all([
        fetchReadyBufferArticles(userId, NEWS),
        // A failed list fails the build, which keeps the last pack whole.
        fetchWorks(userId),
        fetchEpisodes(),
        fetchSongs(),
      ]);
      const activeWorks = works.filter((w) => w.status === 'active' && w.partReady).slice(0, WORKS);
      const freshEpisodes = episodes.filter((e) => e.status === 'ready' && !e.listened_at).slice(0, EPISODES);
      await loadPlaylists().catch(() => {});
      const inLists = new Set((readListCache<Playlist>('playlists') ?? []).flatMap((p) => p.song_ids));
      const ready = songs.filter((s) => s.status === 'ready');
      const ranked = [
        ...ready.filter((s) => inLists.has(s.id)),
        ...ready.filter((s) => !inLists.has(s.id)).sort((a, b) => b.play_count - a.play_count),
      ];
      let minutes = 0;
      const pickedSongs = ranked.filter((s) => {
        if (minutes >= SONG_MINUTES) return false;
        minutes += s.minutes || 3;
        return true;
      }).slice(0, SONGS);
      const partIds = activeWorks.map((w) => {
        const from = w.readingPosition?.partIndex ?? 1;
        return (w.parts ?? [])
          .filter((p) => p.index >= from && p.status !== 'failed' && p.status !== 'pending')
          .slice(0, PARTS_PER_WORK)
          .map((p) => (p.index === 1 && w.partArticleId ? w.partArticleId : workPartArticleId(w.id, p.index)));
      });
      total = news.length + partIds.flat().length + freshEpisodes.length + pickedSongs.length;
      tick();

      // News: the feed's list, and each article ready to open.
      await put('news', news);
      for (const a of news) {
        await put(`article:${a.id}`, await enriched(a));
        done++; tick();
      }

      // 本棚: each work's part list (for 目次) and its next parts.
      for (const [i, w] of activeWorks.entries()) {
        await put(`parts:${w.id}`, await fetchWorkParts(w.id, userId));
        for (const id of partIds[i]) {
          const a = await fetchProcessedArticleById(id, userId).catch(() => null);
          if (a) await put(`article:${id}`, await enriched(a));
          done++; tick();
        }
      }

      // 番組: script now, audio pinned below.
      const fullEpisodes: PodcastEpisodeFull[] = [];
      for (const e of freshEpisodes) {
        const full = await fetchEpisode(e.id).catch(() => null);
        if (full) { await put(`episode:${e.id}`, full); fullEpisodes.push(full); }
      }
      const byPath = new Map(fullEpisodes.filter((e) => e.audio_path).map((e) => [e.audio_path!, e]));
      bytes += await pinAudio('podcast', [...byPath.keys()], (path) => {
        done++; tick();
        return episodeAudioUrl(byPath.get(path)!);
      });
      done = news.length + partIds.flat().length + freshEpisodes.length; tick();

      // 音楽: lyrics and timing, audio, covers.
      const audioPaths: string[] = [];
      const covers: string[] = [];
      for (const s of pickedSongs) {
        const full = await fetchSong(s.id).catch(() => null);
        if (!full) continue;
        await put(`song:${s.id}`, full);
        if (full.audio_path) audioPaths.push(full.audio_path);
        if (full.cover_path) covers.push(full.cover_path);
      }
      await keepCovers(covers).catch(() => {});
      bytes += await pinAudio('music', audioPaths, (path) => {
        done++; tick();
        return songFileUrl(path);
      });

      // Japanese text in the players is tokenized on the device: keep the
      // tokenizer's dictionary in the service worker's cache.
      await getTokenizer().catch(() => {});
      await dict;

      const stale = (await packedKeys()).filter((k) => !written.has(k));
      await dropPacked(stale);
      writeMeta({ userId, builtAt: Date.now(), bytes });
      setStatus({ phase: 'ready', done: total, total, bytes });
    } catch (e) {
      console.warn('[offlinePack] build failed:', e);
      await settle();
    } finally {
      building = null;
    }
  })();
  return building;
}

/** Toggle off, sign-out: drop the records and let the audio go back to normal eviction. */
export async function clearPack(): Promise<void> {
  await building?.catch(() => {});
  writeMeta(null);
  await dropPacked();
  const none = () => Promise.reject(new Error('unused'));
  await Promise.all([pinAudio('podcast', [], none), pinAudio('music', [], none)]);
  setStatus({ phase: 'none', done: 0, total: 0, bytes: 0 });
}

/** A metered or Data Saver connection, where a background refresh shouldn't run. */
function metered(): boolean {
  const c = (navigator as Navigator & { connection?: { saveData?: boolean; type?: string } }).connection;
  return !!c && (c.saveData === true || c.type === 'cellular');
}

/**
 * Launch and return to the app: show the pack's status, and refresh it when it
 * is missing, older than 6 hours, or another account's.
 */
export async function refreshPackIfStale(userId: string, enabled: boolean): Promise<void> {
  if (!enabled) return;
  if (!building) await settle();
  if (isOffline() || metered()) return;
  const meta = readMeta();
  if (meta && meta.userId !== userId) { writeMeta(null); await dropPacked(); }
  const fresh = meta && meta.userId === userId && Date.now() - meta.builtAt < STALE_MS && status.phase === 'ready';
  if (!fresh) await buildPack(userId);
}
