// Photos for ハルカ (docs/mockups/tutor-photo.html, design-system §6.17).
// The server never stores an image: it goes to her for one turn and the thread
// keeps a transcript. So the only copy that outlives the send is a small
// thumbnail here on the phone, for today's conversation, in IndexedDB (not
// localStorage: the persist blob already strains its quota).

export interface PhotoUpload { id: string; mediaType: 'image/jpeg'; data: string }
export interface PreparedPhoto { upload: PhotoUpload; thumb: string }

const SEND_EDGE = 1500;   // what she sees: enough to read a menu
const THUMB_EDGE = 480;   // what the thread shows: sharp at 170pt on a 3× screen

/** Shrink a picked photo on the phone: a JPEG to send and a small thumbnail.
 *  Redrawing also turns HEIC into JPEG and drops the location metadata. */
export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  const img = await loadImage(file);
  const send = draw(img, SEND_EDGE, 0.82);
  return {
    upload: { id: crypto.randomUUID(), mediaType: 'image/jpeg', data: send.slice(send.indexOf(',') + 1) },
    thumb: draw(img, THUMB_EDGE, 0.75),
  };
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('photo could not be read')); };
    img.src = url;
  });
}

/** A JPEG data URL at most `edge` px on the long side (never enlarged). */
function draw(img: HTMLImageElement, edge: number, quality: number): string {
  const scale = Math.min(1, edge / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

// ── Today's thumbnails, on this phone only ──────────────────────────────────

const DB = 'yugen-tutor';
const STORE = 'photos';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

/** Keep a thumbnail for today; anything from an earlier day goes. */
export async function keepThumb(id: string, day: string, thumb: string): Promise<void> {
  try {
    await withStore('readwrite', (s) => {
      s.put({ day, thumb }, id);
      const cur = s.openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return;
        if ((c.value as { day: string }).day !== day) c.delete();
        c.continue();
      };
    });
  } catch { /* private mode or blocked storage: the chip stands in */ }
}

export async function thumbsFor(ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!ids.length) return out;
  try {
    const all = await withStore<{ day: string; thumb: string }[]>('readonly', (s) => s.getAll());
    const keys = await withStore<IDBValidKey[]>('readonly', (s) => s.getAllKeys());
    (keys ?? []).forEach((k, i) => { if (ids.includes(String(k)) && all?.[i]) out[String(k)] = all[i].thumb; });
  } catch { /* none */ }
  return out;
}

/** The conversation ended: its photos go too. */
export async function clearThumbs(): Promise<void> {
  try { await withStore('readwrite', (s) => { s.clear(); }); } catch { /* nothing kept */ }
}
