// 音楽 lists (database/34_playlists.sql): named lists of the reader's own songs.
// One small shared store, so the shelf on 音楽, a list's page and the player's
// リストに追加 sheet all see the same lists. Every change is applied locally
// first and rolled back if the server refuses it. Lists are ordered last used
// first (touched_at: made, or a song added).
import { useSyncExternalStore } from 'react';
import { supabase } from './supabase';
import { readListCache, writeListCache } from './listCache';

const DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true';

export interface Playlist {
  id: string;
  name: string;
  created_at: string;
  touched_at: string;
  /** In list order. */
  song_ids: string[];
}

export const PLAYLIST_NAME_MAX = 40;

// ── Store ────────────────────────────────────────────────────────────────────
let lists: Playlist[] = readListCache<Playlist>('playlists') ?? [];
let loaded = readListCache('playlists') !== null;
let snapshot = { lists, loaded };
const listeners = new Set<() => void>();

function set(next: Playlist[], isLoaded = loaded) {
  lists = [...next].sort((a, b) => b.touched_at.localeCompare(a.touched_at));
  loaded = isLoaded;
  snapshot = { lists, loaded };
  if (loaded) writeListCache('playlists', lists);
  listeners.forEach((fn) => fn());
}
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

/** The reader's lists (last used first) and whether they've loaded at least once. */
export function usePlaylists() {
  return useSyncExternalStore(subscribe, () => snapshot);
}

const patch = (id: string, fn: (p: Playlist) => Playlist) => set(lists.map((p) => (p.id === id ? fn(p) : p)));
const nowIso = () => new Date().toISOString();

/** Run a server write; on failure put the lists back as they were and rethrow. */
async function withRollback(write: () => PromiseLike<{ error: unknown }>) {
  const before = lists;
  if (DEV_MODE) return;
  const { error } = await write();
  if (error) {
    set(before);
    throw error;
  }
}

// ── Last played ──────────────────────────────────────────────────────────────
// Home's 音楽 block plays the list you last played. Kept per device: it's a
// shortcut, not a record.
const LAST_LIST_KEY = 'yugen-last-list';
/** すべての曲: built on the client from every ready song, never stored. */
export const ALL_LIST_ID = 'all';

export function markListPlayed(id: string) {
  try { localStorage.setItem(LAST_LIST_KEY, id); } catch { /* storage blocked */ }
}
export function lastPlayedListId(): string | null {
  try { return localStorage.getItem(LAST_LIST_KEY); } catch { return null; }
}

// ── Reads ────────────────────────────────────────────────────────────────────
let inflight: Promise<void> | null = null;
export function loadPlaylists(): Promise<void> {
  if (DEV_MODE) { set(lists, true); return Promise.resolve(); }
  inflight ??= (async () => {
    try {
      const { data, error } = await supabase
        .from('playlists')
        .select('id, name, created_at, touched_at, playlist_songs(song_id, position)')
        .order('touched_at', { ascending: false })
        .limit(200);
      // Before 34_playlists.sql is applied the table is missing: no lists, no shelf errors.
      if (error) { console.warn('[playlists] load failed:', error.message); return; }
      set((data ?? []).map((r) => ({
        id: r.id, name: r.name, created_at: r.created_at, touched_at: r.touched_at,
        song_ids: [...(r.playlist_songs ?? [])].sort((a, b) => a.position - b.position).map((s) => s.song_id),
      })), true);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

// ── Writes ───────────────────────────────────────────────────────────────────
/** Make a list, optionally already holding songs. Resolves with the new list. */
export async function createPlaylist(name: string, songIds: string[] = []): Promise<Playlist> {
  const clean = name.trim().slice(0, PLAYLIST_NAME_MAX);
  let row: Pick<Playlist, 'id' | 'created_at' | 'touched_at'>;
  if (DEV_MODE) {
    row = { id: crypto.randomUUID(), created_at: nowIso(), touched_at: nowIso() };
  } else {
    const { data, error } = await supabase.from('playlists').insert({ name: clean }).select('id, created_at, touched_at').single();
    if (error || !data) throw error ?? new Error('playlist not created');
    row = data;
    if (songIds.length) {
      const { error: e2 } = await supabase.from('playlist_songs').insert(songIds.map((song_id, position) => ({ playlist_id: row.id, song_id, position })));
      if (e2) console.error('[playlists] songs not added to new list:', e2);
    }
  }
  const list: Playlist = { ...row, name: clean, song_ids: songIds };
  set([list, ...lists]);
  return list;
}

export function addToPlaylist(id: string, songIds: string[]): Promise<void> {
  const list = lists.find((p) => p.id === id);
  if (!list) return Promise.resolve();
  const fresh = songIds.filter((s) => !list.song_ids.includes(s));
  if (!fresh.length) return Promise.resolve();
  const start = list.song_ids.length;
  const touched = nowIso();
  const before = lists;
  patch(id, (p) => ({ ...p, song_ids: [...p.song_ids, ...fresh], touched_at: touched }));
  if (DEV_MODE) return Promise.resolve();
  return (async () => {
    const { error } = await supabase.from('playlist_songs').insert(fresh.map((song_id, k) => ({ playlist_id: id, song_id, position: start + k })));
    if (error) { set(before); throw error; }
    await supabase.from('playlists').update({ touched_at: touched }).eq('id', id);
  })();
}

export function removeFromPlaylist(id: string, songId: string): Promise<void> {
  patch(id, (p) => ({ ...p, song_ids: p.song_ids.filter((s) => s !== songId) }));
  return withRollback(() => supabase.from('playlist_songs').delete().eq('playlist_id', id).eq('song_id', songId));
}

/** Put a removed song back where it was (元に戻す). */
export function restoreToPlaylist(id: string, songId: string, index: number): Promise<void> {
  const list = lists.find((p) => p.id === id);
  if (!list || list.song_ids.includes(songId)) return Promise.resolve();
  const order = [...list.song_ids];
  order.splice(Math.min(index, order.length), 0, songId);
  patch(id, (p) => ({ ...p, song_ids: order }));
  return withRollback(() => supabase.from('playlist_songs').upsert(order.map((song_id, position) => ({ playlist_id: id, song_id, position }))));
}

export function reorderPlaylist(id: string, songIds: string[]): Promise<void> {
  patch(id, (p) => ({ ...p, song_ids: songIds }));
  return withRollback(() => supabase.from('playlist_songs').upsert(songIds.map((song_id, position) => ({ playlist_id: id, song_id, position }))));
}

export function renamePlaylist(id: string, name: string): Promise<void> {
  const clean = name.trim().slice(0, PLAYLIST_NAME_MAX);
  if (!clean) return Promise.resolve();
  patch(id, (p) => ({ ...p, name: clean }));
  return withRollback(() => supabase.from('playlists').update({ name: clean }).eq('id', id));
}

export function deletePlaylist(id: string): Promise<void> {
  set(lists.filter((p) => p.id !== id));
  return withRollback(() => supabase.from('playlists').delete().eq('id', id));
}

/** A deleted song leaves every list (the database cascades; this keeps the store in step). */
export function forgetSongInPlaylists(songId: string) {
  if (lists.some((p) => p.song_ids.includes(songId))) set(lists.map((p) => ({ ...p, song_ids: p.song_ids.filter((s) => s !== songId) })));
}

/** Sign-out: another account must never see these lists. */
export function resetPlaylists() {
  lists = [];
  loaded = false;
  snapshot = { lists, loaded };
  listeners.forEach((fn) => fn());
}
