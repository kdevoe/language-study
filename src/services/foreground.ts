// Requests the reader is waiting on, so background work (the offline pack's
// downloads) can give way. The pack's first build moves well over 100 MB; run
// alongside the app's own requests on a phone connection, it starved them:
// articles, episodes and ハルカ timed out (Oct 25). Every Supabase request
// (REST, RPC, edge functions) goes through countedFetch; the pack's audio and
// cover downloads use plain fetch on signed URLs, so they don't count.

let busy = 0;
let lastDone = 0;

export const countedFetch: typeof fetch = async (...args) => {
  busy++;
  try {
    return await fetch(...args);
  } finally {
    busy--;
    lastDone = Date.now();
  }
};

/** Also count a request made outside the Supabase client (ハルカ's stream). */
export async function foreground<T>(work: Promise<T>): Promise<T> {
  busy++;
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
