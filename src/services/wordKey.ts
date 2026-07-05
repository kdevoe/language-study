/**
 * Canonical word-tracking key (issue #39).
 *
 * A word is tracked in exactly one place — the store's `wordDatabase` map, the
 * server's `user_word_progress.word_id`, and the Reader's grade/click dedup sets.
 * Historically each path derived its own key from a different string (kuromoji
 * `lemma` on passive reads, JMDict `details.word` on clicks, `entry_id` on sync),
 * so one word fragmented into several under-counted records and entry-less tokens
 * never synced.
 *
 * The fix: derive every key from one function. When a word is dictionary-linked we
 * key by its JMDict `entry_id` — this collapses conjugations and kana/kanji
 * variants that share an entry into a single record, and makes the local key equal
 * the server `word_id` (so sync/rehydrate are direct lookups). Only genuinely
 * unlinkable tokens (proper nouns, parse artifacts) fall back to their surface
 * form; those can't sync anyway (no id) and stay local-only by nature.
 *
 * entry_ids are JMDict sequence numbers (7-digit strings) and surfaces are Japanese
 * text, so the two key spaces don't collide in practice.
 */
export function canonicalWordKey(o: {
  jmdictEntryId?: string | null;
  lemma?: string | null;
  word?: string | null;
  text?: string | null;
}): string {
  return o.jmdictEntryId || o.lemma || o.word || o.text || '';
}

/** True when a key is a JMDict entry_id (all digits) rather than a surface form. */
export function isEntryIdKey(key: string): boolean {
  return /^\d+$/.test(key);
}
