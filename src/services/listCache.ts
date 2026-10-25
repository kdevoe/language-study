// Last-loaded lists (本棚 works, 番組 episodes, 音楽 songs and lists, 今日's news picks), so a page shows its
// cards the moment it mounts and refreshes them in the background, instead of
// a skeleton on every visit. Tabs unmount when you switch away, and a fresh
// load waits on getSession() (which may refresh an expired token first), so
// without this every visit starts empty.
//
// Kept in memory for the session and mirrored to a small localStorage key for
// the next launch. The persisted copy is capped and only ever a convenience:
// every read and write is guarded (private mode, quota — see the persist-blob
// quota incident), and a miss just means the old skeleton path.

const PREFIX = 'yugen-list-cache:';
const MAX_ROWS = 50;

export type ListCacheKey = 'works' | 'episodes' | 'news' | 'songs' | 'playlists';

const memory = new Map<ListCacheKey, unknown[]>();

/** The last list loaded for this key, or null if there isn't one yet. */
export function readListCache<T>(key: ListCacheKey): T[] | null {
  const hit = memory.get(key);
  if (hit) return hit as T[];
  try {
    const raw = localStorage.getItem(PREFIX + key);
    const items: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(items)) return null;
    memory.set(key, items);
    return items as T[];
  } catch {
    return null;
  }
}

export function writeListCache<T>(key: ListCacheKey, items: T[]): void {
  const kept = items.slice(0, MAX_ROWS);
  memory.set(key, kept);
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(kept));
  } catch {
    // Quota or storage blocked: the in-memory copy still covers this session.
  }
}

// Last-loaded values the same way (進捗's activity stats per period, the JLPT level
// totals), so 進捗 draws at once and refreshes behind it.
export type ValueCacheKey = 'activity:week' | 'activity:month' | 'activity:all' | 'jlpt-totals';
const VALUE_KEYS: ValueCacheKey[] = ['activity:week', 'activity:month', 'activity:all', 'jlpt-totals'];
const values = new Map<ValueCacheKey, unknown>();

/** The last value stored for this key, or null if there isn't one yet. */
export function readValueCache<T>(key: ValueCacheKey): T | null {
  if (values.has(key)) return values.get(key) as T;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    values.set(key, v);
    return v as T;
  } catch {
    return null;
  }
}

export function writeValueCache<T>(key: ValueCacheKey, value: T): void {
  values.set(key, value);
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Quota or storage blocked: the in-memory copy still covers this session.
  }
}

/** Sign-out (or a session that ends): another account must never see these cards. */
export function clearListCaches(): void {
  memory.clear();
  values.clear();
  for (const key of ['works', 'episodes', 'news', 'songs', 'playlists', ...VALUE_KEYS]) {
    try { localStorage.removeItem(PREFIX + key); } catch { /* storage blocked */ }
  }
}
