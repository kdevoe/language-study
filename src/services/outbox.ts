// Writes that survive no connection (docs/offline-mode-plan.md, phase 3).
//
// Progress writes used to be fire-and-forget: offline, or on a weak signal, a
// grade, a review log row, a reading position or a play just failed and was lost
// (word schedules survived on the device, but the server, overnight daily-prep,
// ハルカ and other devices never saw them). send() tries a write now; if the
// device is offline or the failure is the network's (no response, 401 while a
// token can't refresh, 408, 429, 5xx), the write is queued in IndexedDB and
// replayed in order once the connection is back. A failure the server meant (a
// bad row, a policy) is returned to the caller as before and never queued.
//
// Order is kept: while anything is queued, new writes queue behind it, so an
// old grade can't land after a newer one. Inserts carry a client-made id and
// replay as insert-or-ignore, so a replay never doubles a log row. An op with a
// `key` replaces a queued op with the same key (a reading position: only the
// latest matters).
//
// Flushed on launch before the progress sync pulls (App.tsx), on 'online', when
// the app comes back to the foreground, and every minute while ops are waiting.

import { supabase } from './supabase';
import { done, openDb, req } from './idb';

type Row = Record<string, unknown>;

export type Op = (
  | { t: 'insert'; table: string; row: Row }
  | { t: 'upsert'; table: string; rows: Row | Row[]; onConflict?: string }
  | { t: 'update'; table: string; patch: Row; match: Record<string, string | number> }
  | { t: 'rpc'; fn: string; args: Row }
  | { t: 'call'; name: string; args: unknown[] }
) & { key?: string; tries?: number };

/** Server-side failures (5xx, 429) an op gets before it's dropped, so one bad op can't hold the queue for good. Network failures don't count. */
const MAX_TRIES = 5;

/** A result shaped like supabase-js's: the HTTP status says whether to retry. */
export interface SendResult { error: { message: string } | null; status: number; data?: unknown }

/** Replays for writes that need logic, not one query (registered by their module). */
const handlers = new Map<string, (...args: never[]) => Promise<SendResult>>();
export function registerReplay<A extends unknown[]>(name: string, fn: (...args: A) => Promise<SendResult>): void {
  handlers.set(name, fn as unknown as (...args: never[]) => Promise<SendResult>);
}

const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/** The network or a passing state failed, not the request: try again later. */
export const isRetryable = (status: number) => status === 0 || status === 401 || status === 408 || status === 429 || status >= 500;

let dbPromise: Promise<IDBDatabase | null> | null = null;
const db = () => (dbPromise ??= openDb('yugen-outbox', 1, (d) => d.createObjectStore('ops', { autoIncrement: true })));

// Fallback when IndexedDB is unavailable: kept for this session only.
const memory: Op[] = [];
let queued = 0; // ops waiting (IndexedDB or memory), so new writes keep their place behind them

async function enqueue(op: Op): Promise<void> {
  const d = await db();
  if (!d) {
    if (op.key) memory.splice(0, memory.length, ...memory.filter((o) => o.key !== op.key));
    memory.push(op);
    queued = memory.length;
    return;
  }
  const tx = d.transaction('ops', 'readwrite');
  const store = tx.objectStore('ops');
  if (op.key) {
    const [keys, ops] = await Promise.all([req(store.getAllKeys()), req(store.getAll())]);
    (ops as Op[]).forEach((o, i) => { if (o.key === op.key) store.delete(keys[i]); });
  }
  store.add(op);
  await done(tx);
  queued = await count();
}

async function count(): Promise<number> {
  const d = await db();
  if (!d) return memory.length;
  try { return await req(d.transaction('ops').objectStore('ops').count()); } catch { return 0; }
}

async function run(op: Op): Promise<SendResult> {
  try {
    switch (op.t) {
      case 'insert':
        return await supabase.from(op.table).upsert(op.row, { onConflict: 'id', ignoreDuplicates: true });
      case 'upsert':
        return await supabase.from(op.table).upsert(op.rows, op.onConflict ? { onConflict: op.onConflict } : undefined);
      case 'update': {
        let q = supabase.from(op.table).update(op.patch);
        for (const [col, v] of Object.entries(op.match)) q = q.eq(col, v);
        return await q;
      }
      case 'rpc':
        return await supabase.rpc(op.fn, op.args);
      case 'call': {
        const fn = handlers.get(op.name);
        if (!fn) return { error: { message: `no replay for ${op.name}` }, status: 400 };
        return await fn(...(op.args as never[]));
      }
    }
  } catch (e) {
    // A throw (rather than an error result) is the network: no response to judge.
    return { error: { message: e instanceof Error ? e.message : String(e) }, status: 0 };
  }
}

/**
 * Write now, or queue the write if it can't reach the server. Resolves with an
 * error only when the server refused it (the caller logs it as before), and
 * with `data` when it ran now. An 'insert' row gets its `id` here when it has none.
 */
export async function send(op: Op): Promise<{ error: { message: string } | null; data?: unknown }> {
  if (op.t === 'insert' && op.row.id == null) op = { ...op, row: { ...op.row, id: crypto.randomUUID() } };
  if (isOffline() || queued > 0) {
    await enqueue(op).catch((e) => console.warn('[outbox] could not queue a write:', e));
    if (!isOffline()) void flushOutbox();
    return { error: null };
  }
  const res = await run(op);
  if (!res.error) return { error: null, data: res.data };
  if (isRetryable(res.status)) {
    await enqueue(op).catch((e) => console.warn('[outbox] could not queue a write:', e));
    return { error: null };
  }
  return { error: res.error };
}

let flushing: Promise<void> | null = null;

/** Replay queued writes in order. Stops at the first one the network refuses; safe to call any time. */
export function flushOutbox(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    try {
      for (;;) {
        if (isOffline()) return;
        const next = await peek();
        if (!next) return;
        const res = await run(next.op);
        if (res.error && isRetryable(res.status)) {
          if (res.status === 0) return; // still no connection: keep it, try later
          const tries = (next.op.tries ?? 0) + 1;
          if (tries < MAX_TRIES) { await replace(next.id, { ...next.op, tries }); return; }
          console.warn(`[outbox] dropped a write after ${tries} server failures (${next.op.t}):`, res.error.message);
        } else if (res.error) {
          console.warn(`[outbox] dropped a write the server refused (${next.op.t}):`, res.error.message);
        }
        await remove(next.id);
      }
    } catch (e) {
      console.warn('[outbox] flush failed:', e);
    } finally {
      queued = await count();
      flushing = null;
    }
  })();
  return flushing;
}

async function peek(): Promise<{ id: IDBValidKey; op: Op } | null> {
  const d = await db();
  if (!d) return memory.length ? { id: 0, op: memory[0] } : null;
  const cursor = await req(d.transaction('ops').objectStore('ops').openCursor());
  return cursor ? { id: cursor.key, op: cursor.value as Op } : null;
}

async function replace(id: IDBValidKey, op: Op): Promise<void> {
  const d = await db();
  if (!d) { memory[0] = op; return; }
  const tx = d.transaction('ops', 'readwrite');
  tx.objectStore('ops').put(op, id);
  await done(tx);
}

async function remove(id: IDBValidKey): Promise<void> {
  const d = await db();
  if (!d) { memory.shift(); return; }
  const tx = d.transaction('ops', 'readwrite');
  tx.objectStore('ops').delete(id);
  await done(tx);
}

/** Sign-out: queued writes belong to that account and must not replay under another. */
export async function clearOutbox(): Promise<void> {
  memory.length = 0;
  queued = 0;
  const d = await db();
  if (!d) return;
  const tx = d.transaction('ops', 'readwrite');
  tx.objectStore('ops').clear();
  await done(tx).catch(() => {});
}

/** How many writes are waiting (for checks and tests). */
export const pendingWrites = count;

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { void flushOutbox(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void flushOutbox();
  });
  window.setInterval(() => { if (queued > 0) void flushOutbox(); }, 60_000);
  // Ops left from an earlier session keep their place ahead of new writes.
  void count().then((n) => { queued = n; });
}
