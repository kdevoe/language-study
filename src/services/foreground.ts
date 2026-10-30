// Requests the reader is waiting on, so background work (the offline pack's
// downloads) can give way. The pack's first build moves well over 100 MB; run
// alongside the app's own requests on a phone connection, it starved them:
// articles, episodes and ハルカ timed out (Oct 25). Every Supabase request
// (REST, RPC, edge functions) goes through countedFetch; the pack's audio and
// cover downloads use plain fetch on signed URLs, so they don't count.

let busy = 0;
let lastDone = 0;
const onStart = new Set<() => void>();
const started = () => { busy++; onStart.forEach((fn) => fn()); };

// How long a Supabase request may take before it's given up. iOS can leave a
// request that was in flight when it suspended the app pending forever after
// it resumes; when that request is a token refresh, auth-js holds its lock
// across it and queues every later request behind it with no timeout, so
// nothing reaches the server again until the app is killed (Oct 29: episodes,
// songs and progress writes all stuck on a grey screen). A timed-out request
// fails like a dropped connection: the lock is released, the outbox keeps the
// write, the loader falls back to the offline pack. Edge functions are left
// alone: some run long by design, and ハルカ's chat stream has its own watchdog.
const TIMEOUT_MS: [RegExp, number][] = [
  [/\/auth\/v1\//, 20_000],
  [/\/rest\/v1\//, 45_000],
  [/\/storage\/v1\//, 60_000],
];

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

/** A signal that aborts after the path's timeout; none when the caller set its own or the path has none. */
function timeoutSignal(input: RequestInfo | URL, init?: RequestInit): AbortSignal | undefined {
  // The caller's own signal (or a Request carrying one) stands.
  if (init?.signal || (typeof Request !== 'undefined' && input instanceof Request)) return undefined;
  const ms = TIMEOUT_MS.find(([re]) => re.test(urlOf(input)))?.[1];
  if (!ms) return undefined;
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const ac = new AbortController();
  setTimeout(() => ac.abort(new DOMException('The request timed out.', 'TimeoutError')), ms);
  return ac.signal;
}

export const countedFetch: typeof fetch = async (input, init) => {
  started();
  try {
    const signal = timeoutSignal(input, init);
    return await fetch(input, signal ? { ...init, signal } : init);
  } finally {
    busy--;
    lastDone = Date.now();
  }
};

/** Also count a request made outside the Supabase client (ハルカ's stream). */
export async function foreground<T>(work: Promise<T>): Promise<T> {
  started();
  try {
    return await work;
  } finally {
    busy--;
    lastDone = Date.now();
  }
}

/** Resolves once nothing has been in flight for `quietMs`. */
export async function whenQuiet(quietMs = 3000): Promise<void> {
  for (;;) {
    const wait = busy > 0 ? 1000 : lastDone + quietMs - Date.now();
    if (wait <= 0) return;
    await new Promise((r) => setTimeout(r, wait));
  }
}

/**
 * A signal for one background download that aborts as soon as the app starts a
 * request of its own: waiting before a download isn't enough, since one song
 * takes a while on a phone and the reader shouldn't wait behind it. Call
 * `done` when the download ends.
 */
export function interruptible(): { signal: AbortSignal; done: () => void } {
  const ac = new AbortController();
  const stop = () => ac.abort();
  onStart.add(stop);
  return { signal: ac.signal, done: () => { onStart.delete(stop); } };
}
