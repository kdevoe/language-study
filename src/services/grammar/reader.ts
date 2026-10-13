/**
 * Grammar in the reader (#43, phase 1): runs the rules over an article's
 * paragraphs and maps a tapped piece onto the points it belongs to.
 *
 * Matches are character ranges over a block's text (its display items joined),
 * so a piece's own offsets decide what a tap opens (docs/grammar-plan.md):
 *   - a piece wholly inside a point's marked span (ば, なりません, ので) opens the
 *     grammar panel first;
 *   - any other piece the match touches, context included (直さなけれ, 住む), opens
 *     the word panel with the point in its PATTERNS rows.
 */
import { findGrammar, type GrammarMatch } from './engine';
import { STARTER_RULES } from './rules';
import { GRAMMAR_POINTS } from './catalogue';
import { getTokenizer } from '../tokenizer';

/** One point in one sentence, as the panels show it. */
export interface GrammarHit {
  id: string;
  sentence: string;
  /** The marked span, as offsets into `sentence` (この文では). */
  start: number;
  end: number;
  /** Where the span sits in the article, so the reader can light it up. */
  lit?: { block: number; start: number; end: number };
}

/** Matches for each block's text (null for a block with none, e.g. a yugen-box). */
export async function grammarForTexts(texts: (string | null)[]): Promise<GrammarMatch[][]> {
  const tokenizer = await getTokenizer();
  return texts.map((text) =>
    text ? findGrammar(tokenizer.tokenize(text), STARTER_RULES).filter((m) => GRAMMAR_POINTS[m.id]) : [],
  );
}

/** The point whose marked span holds the whole piece [start, end), if any. */
export const pointOf = (matches: GrammarMatch[], start: number, end: number) =>
  matches.find((m) => m.start <= start && end <= m.end && start < end);

/** Every point the piece [start, end) takes part in, context included. */
export const pointsTouching = (matches: GrammarMatch[], start: number, end: number) =>
  matches.filter((m) => m.ctxStart < end && start < m.ctxEnd);

/** A match as seen from a sentence starting at `sentStart` in block `block`. */
export const toHit = (m: GrammarMatch, block: number, sentence: string, sentStart: number): GrammarHit => ({
  id: m.id,
  sentence,
  start: Math.max(0, m.start - sentStart),
  end: Math.min(sentence.length, m.end - sentStart),
  lit: { block, start: m.start, end: m.end },
});
