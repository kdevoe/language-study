/**
 * Client-side article enrichment.
 *
 * Turns raw Japanese paragraph text into interactive, dictionary-linked tokens:
 *   tokenize (kuromoji) → batch JMDict lookup by lemma → attach reading/meaning/JLPT.
 *
 * This replaces the old server passes (Gemini "tokenizer" + exact-surface JMDict
 * linking). It also auto-heals articles cached in the old content[] shape by
 * reconstructing their raw text and re-tokenizing.
 */

import type { ArticleBlock } from './api';
import type { WordDetails } from '../components/WordModal';
import { tokenizeToDisplay, TOKENIZER_VERSION, type CoarsePos, type DisplayToken } from './tokenizer';
import { lookupLemmasBatch, jmdictToWordDetails, type JMDictResult } from './jmdict';

/** Raw text of a block, reconstructed from the old content[] shape when needed. */
function rawTextOf(block: ArticleBlock): string {
  if (block.text) return block.text;
  if (block.content) return block.content.map(t => t.text).join('');
  return '';
}

/** True when every paragraph block already carries current-version enrichment. */
export function isEnriched(blocks: ArticleBlock[]): boolean {
  return blocks.every(
    b => b.type !== 'paragraph' || (b.tokenizerVersion === TOKENIZER_VERSION && !!b.content),
  );
}

/**
 * Enrich an article's paragraphs in place-of (returns a new array). yugen-box
 * blocks pass through untouched. Falls back to the raw block on any failure so a
 * tokenizer hiccup never blanks the article.
 */
export async function enrichArticle(blocks: ArticleBlock[]): Promise<ArticleBlock[]> {
  // 1. Tokenize every paragraph from its raw text.
  const perBlock: (DisplayToken[] | null)[] = await Promise.all(
    blocks.map(async (block) => {
      if (block.type !== 'paragraph') return null;
      const raw = rawTextOf(block);
      if (!raw) return null;
      try {
        return await tokenizeToDisplay(raw);
      } catch (e) {
        console.warn('[enrich] tokenize failed for a block:', e);
        return null;
      }
    }),
  );

  // 2. Gather unique lemmas + their coarse POS for a single batched lookup.
  const posByLemma = new Map<string, CoarsePos>();
  for (const tokens of perBlock) {
    if (!tokens) continue;
    for (const t of tokens) {
      if (t.lemma && !posByLemma.has(t.lemma)) posByLemma.set(t.lemma, t.pos ?? 'other');
    }
  }

  let byLemma = new Map<string, JMDictResult>();
  try {
    byLemma = await lookupLemmasBatch([...posByLemma.keys()], posByLemma);
  } catch (e) {
    console.warn('[enrich] JMDict batch lookup failed; rendering without links:', e);
  }

  // 3. Build enriched content[] per paragraph.
  return blocks.map((block, i) => {
    const tokens = perBlock[i];
    if (!tokens) return block; // yugen-box or un-tokenizable: leave as-is

    const content = tokens.map((tk) => {
      const item: NonNullable<ArticleBlock['content']>[number] = { text: tk.text };
      if (tk.furigana) item.furigana = tk.furigana;
      if (!tk.isInteractive) return item;

      item.isInteractive = true;
      if (tk.lemma) item.lemma = tk.lemma;

      const entry = tk.lemma ? byLemma.get(tk.lemma) : undefined;
      if (entry && tk.lemma) {
        const d = jmdictToWordDetails(tk.lemma, entry);
        item.jmdict_entry_id = d.jmdictEntryId;
        const details: WordDetails = {
          word: tk.lemma,
          reading: d.reading,
          meaning: d.meaning,
          furiganaMap: d.furiganaMap,
          jlptLevel: d.jlptLevel,
          jlptDerived: d.jlptDerived,
          pos: d.pos,
          jmdictEntryId: d.jmdictEntryId,
        };
        item.details = details;
      } else if (tk.furiganaMap) {
        // No JMDict entry (e.g. proper noun): keep the tokenizer's reading map so
        // the modal can still show furigana; tap falls back to dictionary-lookup.
        item.details = { word: tk.lemma ?? tk.text, reading: tk.furigana ?? '', meaning: '', furiganaMap: tk.furiganaMap };
      }
      return item;
    });

    return { ...block, text: rawTextOf(block), content, tokenizerVersion: TOKENIZER_VERSION };
  });
}
