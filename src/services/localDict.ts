// On-device JMDict (docs/offline-mode-plan.md › Offline word lookups).
//
// jmdict.ts asks Supabase first; this copy answers when the device is offline or
// the server query fails, so taps and article enrichment keep working on a
// flight. Built by scripts/build-jmdict-offline.mjs into public/jmdict/ (a
// manifest plus gzipped shards of trimmed entries) and imported once into
// IndexedDB, where multiEntry indexes on the kanji and kana forms make a lookup,
// or a whole article's batch, one transaction instead of a dictionary in memory.
//
// Best effort throughout: no IndexedDB, no DecompressionStream, or a failed
// import just means lookups stay online-only, as before.

import type { JMDictResult } from './jmdict';

const DB_NAME = 'yugen-jmdict';
const BASE = '/jmdict/';

/** Entry row as the build script writes it. */
export type Row = [string, string[], string[], string[][], string[], 0 | 1, number | null, number | null, 0 | 1];

export interface Stored {
  id: string;
  k: string[];
  r: string[];
  g: string[][];
  p: string[];
  uk: 0 | 1;
  j: number | null;
  f: number | null;
  c: 0 | 1;
}

interface Manifest {
  version: string;
  shards: string[];
  kanjiJlpt: Record<string, number>;
}

/** Install progress, kept in the meta store so an interrupted import resumes. */
interface Meta {
  version: string;
  done: string[];
  ready: boolean;
  kanjiJlpt: Record<string, number>;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;
let meta: Meta | null | undefined; // undefined = not read yet
let installing: Promise<void> | null = null;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function openDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        if (typeof indexedDB === 'undefined') return resolve(null);
        const open = indexedDB.open(DB_NAME, 1);
        open.onupgradeneeded = () => {
          const db = open.result;
          const entries = db.createObjectStore('entries', { keyPath: 'id' });
          entries.createIndex('k', 'k', { multiEntry: true });
          entries.createIndex('r', 'r', { multiEntry: true });
          db.createObjectStore('meta');
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => resolve(null);
        open.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

async function readMeta(): Promise<Meta | null> {
  if (meta !== undefined) return meta;
  const db = await openDb();
  try {
    meta = db ? ((await req(db.transaction('meta').objectStore('meta').get('install'))) as Meta | undefined) ?? null : null;
  } catch {
    meta = null;
  }
  return meta;
}

async function writeMeta(db: IDBDatabase, next: Meta): Promise<void> {
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put(next, 'install');
  await done(tx);
  meta = next;
}

/** True once a complete copy is on the device. */
export async function localDictReady(): Promise<boolean> {
  return !!(await readMeta())?.ready;
}

/** The browser says there's no connection (it can't tell a dead captive Wi-Fi, so callers also fall back on errors). */
export const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/** Shard bytes → rows. Vite's dev server sends .gz with Content-Encoding (already unzipped), production doesn't. */
async function readShard(res: Response): Promise<Row[]> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return JSON.parse(new TextDecoder().decode(bytes)) as Row[];
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text()) as Row[];
}

async function install(): Promise<void> {
  if (typeof DecompressionStream === 'undefined') return;
  // Data Saver on: don't pull megabytes in the background.
  if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;
  const db = await openDb();
  if (!db) return;
  const res = await fetch(`${BASE}manifest.json`, { cache: 'no-cache' });
  if (!res.ok) return;
  const manifest = (await res.json()) as Manifest;

  let cur = await readMeta();
  if (!cur || cur.version !== manifest.version) {
    // A new build: start over. Lookups go online-only until it finishes.
    const tx = db.transaction(['entries', 'meta'], 'readwrite');
    tx.objectStore('entries').clear();
    await done(tx);
    cur = { version: manifest.version, done: [], ready: false, kanjiJlpt: manifest.kanjiJlpt };
    await writeMeta(db, cur);
  }
  if (cur.ready) return;

  for (const shard of manifest.shards) {
    if (cur.done.includes(shard)) continue;
    const r = await fetch(BASE + shard);
    if (!r.ok) return; // try again next launch
    const rows = await readShard(r);
    const tx = db.transaction('entries', 'readwrite');
    const store = tx.objectStore('entries');
    for (const row of rows) store.put(fromRow(row));
    await done(tx);
    cur = { ...cur, done: [...cur.done, shard] };
    await writeMeta(db, cur);
  }
  await writeMeta(db, { ...cur, ready: true });
  navigator.storage?.persist?.().catch(() => {});
}

/**
 * Download and import the dictionary if this device doesn't have the current
 * build. Runs once per session, in the background; safe to call repeatedly.
 */
export function ensureLocalDict(): Promise<void> {
  if (!installing) {
    installing = install().catch((e) => {
      console.warn('[localDict] install failed:', e);
      installing = null; // allow a retry later in the session
    });
  }
  return installing;
}

/** Row → stored shape, and stored → what jmdict.ts returns. Exported for scripts/test-local-dict.mjs. */
export function fromRow([id, k, r, g, p, uk, j, f, c]: Row): Stored {
  return { id, k, r, g, p, uk, j, f, c };
}

export function toResult(e: Stored): JMDictResult {
  // Senses as the server shapes them, trimmed: the POS union and 'uk' ride on the
  // first sense (posMatches, isKanaPrimary and jmdictToWordDetails read across all).
  const senses = (e.g.length ? e.g : [[]]).map((gloss, i) => ({
    pos: i === 0 ? e.p : [],
    gloss,
    field: [] as string[],
    misc: i === 0 && e.uk ? ['uk'] : [],
  }));
  return {
    entryId: e.id,
    kanji: e.k,
    readings: e.r,
    senses,
    jlptLevel: e.j,
    freqRank: e.f,
    isCommon: !!e.c,
  };
}

async function store(): Promise<IDBObjectStore> {
  const db = await openDb();
  if (!db) throw new Error('local dictionary unavailable');
  return db.transaction('entries').objectStore('entries');
}

/** Entries written with `text` as a kanji form ('k') or kana form ('r'). */
export async function localByForm(text: string, form: 'k' | 'r', limit = 10): Promise<JMDictResult[]> {
  const rows = (await req((await store()).index(form).getAll(text, limit))) as Stored[];
  return rows.map(toResult);
}

/** Entry ids for many surfaces at once, per form, like the server's two `in('text', …)` queries. */
export async function localIdsByForms(texts: string[]): Promise<{ kanji: Map<string, Set<string>>; kana: Map<string, Set<string>> }> {
  const s = await store();
  const kanji = new Map<string, Set<string>>();
  const kana = new Map<string, Set<string>>();
  await Promise.all(texts.flatMap((t) => (['k', 'r'] as const).map(async (form) => {
    const ids = (await req(s.index(form).getAllKeys(t))) as string[];
    if (ids.length) (form === 'k' ? kanji : kana).set(t, new Set(ids));
  })));
  return { kanji, kana };
}

export async function localEntries(ids: string[]): Promise<JMDictResult[]> {
  const s = await store();
  const rows = await Promise.all(ids.map((id) => req(s.get(id)) as Promise<Stored | undefined>));
  return rows.filter((r): r is Stored => !!r).map(toResult);
}

export async function localKanjiJlpt(chars: Set<string>): Promise<Map<string, number>> {
  const levels = (await readMeta())?.kanjiJlpt ?? {};
  return new Map([...chars].flatMap((ch) => (levels[ch] != null ? [[ch, levels[ch]] as [string, number]] : [])));
}
