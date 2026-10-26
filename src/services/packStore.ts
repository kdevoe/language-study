// Storage for the offline pack (offlinePack.ts builds it): articles, work part
// lists, episodes and songs as the loaders return them, keyed like
// `article:<id>`, in IndexedDB. Kept apart from the builder so the loaders
// (api.ts, podcasts.ts, songs.ts) can read it without an import cycle.

import { done, openDb, req } from './idb';

export type PackKey = `article:${string}` | `parts:${string}` | `episode:${string}` | `song:${string}` | 'news' | 'translations';

let dbPromise: Promise<IDBDatabase | null> | null = null;
export const packDb = () => (dbPromise ??= openDb('yugen-pack', 1, (d) => d.createObjectStore('items')));

export const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

export async function packed<T>(key: PackKey): Promise<T | null> {
  const d = await packDb();
  if (!d) return null;
  try {
    return ((await req(d.transaction('items').objectStore('items').get(key))) as T | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function putPacked(key: PackKey, value: unknown): Promise<void> {
  const d = await packDb();
  if (!d) return;
  const tx = d.transaction('items', 'readwrite');
  tx.objectStore('items').put(value, key);
  await done(tx);
}

export async function packedKeys(): Promise<string[]> {
  const d = await packDb();
  if (!d) return [];
  try { return (await req(d.transaction('items').objectStore('items').getAllKeys())) as string[]; } catch { return []; }
}

/** Delete these keys, or everything when none are given. */
export async function dropPacked(keys?: string[]): Promise<void> {
  const d = await packDb();
  if (!d) return;
  const tx = d.transaction('items', 'readwrite');
  const store = tx.objectStore('items');
  if (keys) keys.forEach((k) => store.delete(k));
  else store.clear();
  await done(tx).catch(() => {});
}

/**
 * Load from the server, or from the pack: first when the device is offline,
 * and as the fallback when the load fails. Without a packed copy the loader's
 * own result or error stands.
 */
export async function offlineFirst<T>(key: PackKey, loader: () => Promise<T>): Promise<T> {
  if (isOffline()) {
    const hit = await packed<T>(key);
    if (hit != null) return hit;
    return loader();
  }
  try {
    return await loader();
  } catch (e) {
    const hit = await packed<T>(key);
    if (hit != null) return hit;
    throw e;
  }
}

// Sentence translations made for packed articles (phase 6), sentence → English.
// Read once per session; the pack writes a fresh map on each build.
let translations: Promise<Record<string, string>> | null = null;

/** A packed translation of this sentence, if the pack has one. */
export async function packedTranslation(sentence: string): Promise<string | null> {
  translations ??= packed<Record<string, string>>('translations').then((m) => m ?? {});
  return (await translations)[sentence.trim()] ?? null;
}

/** After a build (or a clear): read the map again on next use. */
export const forgetTranslations = () => { translations = null; };
