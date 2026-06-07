/**
 * Client-side morphological tokenizer (kuromoji.js + IPADIC).
 *
 * Replaces the old LLM "morphological analyzer" pass. A real dictionary-based
 * analyzer gives us, deterministically, for every token:
 *   - surface form  (鎮めて)        — what to display
 *   - basic form    (鎮める)        — the lemma to look up in JMDict
 *   - reading       (しずめて)       — the *contextual* reading, so furigana is right
 *   - part of speech (動詞/名詞…)    — to disambiguate JMDict senses
 *
 * The dictionary (~17 MB of *.dat.gz) is self-hosted under public/kuromoji-dict/
 * and loaded once per session. In the browser, @sglkc/kuromoji's `browser` field
 * swaps in a fetch + fflate loader automatically (see its package.json), so no
 * Node fs dependency leaks into the bundle.
 */

import type { IpadicFeatures, Tokenizer } from '@sglkc/kuromoji';
import { isKana, hasKanji, kataToHira, alignReading } from './furigana';

/** Bump when the tokenizer/dict or the enrichment shape changes, so cached
 *  articles stamped with an older version get re-enriched on next open. */
export const TOKENIZER_VERSION = 4;

/** Coarse part of speech, mapped from kuromoji's Japanese POS labels. */
export type CoarsePos = 'verb' | 'noun' | 'adjective' | 'adverb' | 'other';

export interface DisplayToken {
  /** Surface form, exactly as it appears in the text — what we render. */
  text: string;
  /** Hiragana reading of the surface. Present only when the surface has kanji. */
  furigana?: string;
  /** Dictionary/base form, used for JMDict lookup and SRS keying. */
  lemma?: string;
  /** Coarse POS, used to disambiguate JMDict candidates. */
  pos?: CoarsePos;
  /** Tappable content word (verb/noun/adjective/adverb). */
  isInteractive?: boolean;
  /** Per-kanji okurigana alignment for the modal furigana breakdown. */
  furiganaMap?: { kanji: string; kana: string }[];
}

const DIC_PATH = '/kuromoji-dict/';

let tokenizerPromise: Promise<Tokenizer<IpadicFeatures>> | null = null;

/**
 * Build (or reuse) the kuromoji tokenizer. Memoized for the session. kuromoji
 * (~380 KB) is dynamically imported so it stays out of the initial app bundle
 * and only loads when the reader first enriches an article.
 */
export function getTokenizer(): Promise<Tokenizer<IpadicFeatures>> {
  if (!tokenizerPromise) {
    tokenizerPromise = import('@sglkc/kuromoji').then(
      (mod) =>
        new Promise<Tokenizer<IpadicFeatures>>((resolve, reject) => {
          mod.default.builder({ dicPath: DIC_PATH }).build((err, tokenizer) => {
            if (err) reject(err);
            else resolve(tokenizer);
          });
        }),
    );
    // Allow a retry on the next call if the load/build fails.
    tokenizerPromise.catch(() => { tokenizerPromise = null; });
  }
  return tokenizerPromise;
}

// ── POS mapping ──────────────────────────────────────────────────────────────

function coarsePos(pos: string): CoarsePos {
  if (pos === '動詞') return 'verb';
  if (pos === '名詞') return 'noun';
  if (pos === '形容詞') return 'adjective';
  if (pos === '副詞') return 'adverb';
  return 'other';
}

// ── Inflection merge ─────────────────────────────────────────────────────────
// Fold conjugational tail onto its verb/adjective head so the tappable token is
// the whole inflected word (鎮めて), not a bare stem (鎮). We keep the head's
// basic_form as the lemma. Auxiliary *verbs* (いる/しまう/くる) are intentionally
// left separate (off by default) so 〜ている stays independently tappable.

/** A 助動詞 (auxiliary) always continues the preceding head. */
function isAuxiliary(t: IpadicFeatures): boolean {
  return t.pos === '助動詞';
}

/** The conjunctive 助詞 て/で binds the verb to what follows; merge it onto the head. */
function isConnectiveParticle(t: IpadicFeatures): boolean {
  return (
    t.pos === '助詞' &&
    t.pos_detail_1 === '接続助詞' &&
    (t.surface_form === 'て' || t.surface_form === 'で')
  );
}

/** A 動詞 in 連用接続/連用形 with no base of its own is part of the inflection (e.g. ない stems). */
function isInflectionSuffix(t: IpadicFeatures): boolean {
  // 接尾 verbs/adjectives and non-independent (非自立) suffixes that carry conjugation.
  return (
    (t.pos === '動詞' || t.pos === '形容詞') && t.pos_detail_1 === '接尾'
  );
}

interface MergedToken {
  surface: string;
  reading: string; // katakana, concatenated across the merged span
  lemma: string;
  pos: CoarsePos;
  isContent: boolean;
}

function mergeInflections(tokens: IpadicFeatures[]): MergedToken[] {
  const out: MergedToken[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const isHead = t.pos === '動詞' || t.pos === '形容詞';

    let surface = t.surface_form;
    let reading = t.reading && t.reading !== '*' ? t.reading : t.surface_form;
    const lemma = t.basic_form && t.basic_form !== '*' ? t.basic_form : t.surface_form;

    if (isHead) {
      // Consume the conjugational tail.
      while (i + 1 < tokens.length) {
        const next = tokens[i + 1];
        if (isAuxiliary(next) || isConnectiveParticle(next) || isInflectionSuffix(next)) {
          surface += next.surface_form;
          reading += next.reading && next.reading !== '*' ? next.reading : next.surface_form;
          i++;
        } else {
          break;
        }
      }
    }

    const cpos = coarsePos(t.pos);
    const isContent =
      (cpos === 'verb' || cpos === 'noun' || cpos === 'adjective' || cpos === 'adverb') &&
      t.pos_detail_1 !== '非自立' &&
      t.pos_detail_1 !== '接尾' &&
      t.pos_detail_1 !== '数'; // bare numbers aren't worth a dictionary tap

    out.push({ surface, reading, lemma, pos: cpos, isContent });
  }

  return out;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Tokenize Japanese text into display tokens with furigana + lemma.
 * Pure transform over the kuromoji output — no network beyond the dict load.
 */
export async function tokenizeToDisplay(text: string): Promise<DisplayToken[]> {
  const tokenizer = await getTokenizer();
  return displayFromRaw(tokenizer.tokenize(text));
}

/**
 * Pure transform from raw kuromoji tokens to display tokens (merge inflections,
 * align okurigana, classify content words). Separated out so it can be tested
 * without loading the dictionary.
 */
export function displayFromRaw(raw: IpadicFeatures[]): DisplayToken[] {
  const merged = mergeInflections(raw);

  return merged.map((m) => {
    const surfaceHasKanji = hasKanji(m.surface);
    const readingHira = kataToHira(m.reading);

    const token: DisplayToken = { text: m.surface };

    if (surfaceHasKanji) {
      token.furigana = readingHira;
      token.furiganaMap = alignReading(m.surface, readingHira);
    }

    if (m.isContent) {
      token.isInteractive = true;
      // Unknown words (proper nouns kuromoji can't analyze) have no usable lemma.
      if (hasKanji(m.lemma) || isKana(m.lemma[0] ?? '')) {
        token.lemma = m.lemma;
      }
      token.pos = m.pos;
    }

    return token;
  });
}
