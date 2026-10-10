// On-device search for the LISTEN and LIBRARY archives (mockup
// docs/mockups/archive-organize.html). Queries can be English or Japanese:
// each item exposes its Japanese text (title, script / article body) and its
// English source (topic, pasted text, URL, raw import), matched as substrings.

/** Searchable text for one archive item, loaded lazily on first search. */
export interface SearchText {
  ja: string;
  en: string;
}

export type SearchCorpus = Map<string, SearchText>;

/**
 * Fold one character for matching: NFKC (full-width ASCII, half-width kana),
 * lowercase, katakana → hiragana. Only one-for-one results are kept, so a
 * folded string has the same length as the original and a match index maps
 * straight back for highlighting.
 */
function foldChar(ch: string): string {
  let c = ch.normalize('NFKC');
  if (c.length !== 1) c = ch;
  c = c.toLowerCase();
  if (c.length !== 1) c = ch;
  const code = c.charCodeAt(0);
  // Katakana ァ (U+30A1) … ヶ (U+30F6) sit 0x60 above their hiragana.
  if (code >= 0x30a1 && code <= 0x30f6) return String.fromCharCode(code - 0x60);
  return c;
}

export function fold(s: string): string {
  let out = '';
  for (const ch of s) {
    // Astral characters (emoji) are two UTF-16 units; keep them as-is so the
    // folded length still equals the original's.
    out += ch.length === 1 ? foldChar(ch) : ch;
  }
  return out;
}

/** Index of `q` in `text` (both raw), or -1. Empty queries never match. */
export function findIn(text: string | null | undefined, q: string): number {
  const fq = fold(q.trim());
  if (!text || !fq) return -1;
  return fold(text).indexOf(fq);
}

export interface Snippet {
  where: 'ja' | 'en';
  before: string;
  match: string;
  after: string;
}

/** A short window of `text` around the match at `index`, for a result card. */
export function snippetAt(text: string, index: number, length: number, where: 'ja' | 'en', radius = 34): Snippet {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  const clean = (s: string) => s.replace(/\s+/g, ' ');
  return {
    where,
    before: (start > 0 ? '…' : '') + clean(text.slice(start, index)),
    match: text.slice(index, index + length),
    after: clean(text.slice(index + length, end)) + (end < text.length ? '…' : ''),
  };
}

export interface MatchResult {
  hit: boolean;
  /** Set when the hit is in the body text rather than the visible card. */
  snippet?: Snippet;
}

/**
 * Match an item: first its visible card text (title, tag), then the Japanese
 * body, then the English source. A body hit returns a snippet to show on the
 * card, since the matched words aren't otherwise visible.
 */
export function matchItem(visible: string[], body: SearchText | undefined, q: string): MatchResult {
  const query = q.trim();
  if (!query) return { hit: true };
  if (visible.some((v) => findIn(v, query) >= 0)) return { hit: true };
  if (body) {
    for (const where of ['ja', 'en'] as const) {
      const i = findIn(body[where], query);
      if (i >= 0) return { hit: true, snippet: snippetAt(body[where], i, query.length, where) };
    }
  }
  return { hit: false };
}
