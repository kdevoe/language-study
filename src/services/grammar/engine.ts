/**
 * Grammar-point matcher (#43, phase 0).
 *
 * Runs short patterns over the RAW kuromoji tokens (before tokenizer.ts folds
 * auxiliaries into the verb), so 直さ|なけれ|ば|なり|ませ|ん is still six tokens
 * a rule can step through. Pure and dependency-free: the same code runs in the
 * reader and in scripts/test-grammar-rules.mjs.
 *
 * A match is a character range over the tokenized text. The reader maps display
 * tokens onto these ranges to decide what a tap opens (docs/grammar-plan.md).
 */

/** The kuromoji (IPADIC) fields a rule can test. Structurally a subset of IpadicFeatures. */
export interface GrammarToken {
  surface_form: string;
  pos: string;
  pos_detail_1: string;
  conjugated_type: string;
  conjugated_form: string;
  basic_form: string;
}

type OneOrMany = string | string[];

/** A test on one token. Every given field must hold. ctype/cform match by prefix
 *  (cform '連用' covers 連用形, 連用タ接続 and 連用テ接続). */
export interface Cond {
  surface?: OneOrMany;
  lemma?: OneOrMany;
  pos?: OneOrMany;
  pos1?: OneOrMany;
  ctype?: OneOrMany;
  cform?: OneOrMany;
}

export interface Step extends Cond {
  /** The token must NOT match this. */
  not?: Cond;
  /** Part of the underlined point (default) or context that must be there but isn't marked. */
  mark?: boolean;
  /** Zero or one. */
  optional?: boolean;
  /** Zero or more, greedy (e.g. a trailing ます/た/ない tail). */
  star?: boolean;
  /** Alternatives, each a sequence of steps. Takes the longest that fits. */
  any?: Step[][];
}

export interface GrammarRule {
  id: string;
  steps: Step[];
  /** Rule ids this one hides when their span sits inside this one's. */
  suppresses?: string[];
}

export interface GrammarMatch {
  id: string;
  /** Character range of the marked part, end exclusive. */
  start: number;
  end: number;
  /** Token range of the whole match (context included), end exclusive. */
  tokenStart: number;
  tokenEnd: number;
}

const has = (want: OneOrMany | undefined, value: string, prefix = false) => {
  if (want === undefined) return true;
  const list = Array.isArray(want) ? want : [want];
  return list.some((w) => (prefix ? value.startsWith(w) : value === w));
};

export function tokenMatches(t: GrammarToken, c: Cond): boolean {
  return (
    has(c.surface, t.surface_form) &&
    has(c.lemma, t.basic_form) &&
    has(c.pos, t.pos) &&
    has(c.pos1, t.pos_detail_1) &&
    has(c.ctype, t.conjugated_type, true) &&
    has(c.cform, t.conjugated_form, true)
  );
}

/** One way a step sequence can match: where it ends and which tokens are marked. */
interface Path {
  end: number;
  marked: number[];
}

const isCondStep = (s: Step) => !s.any;

/** Every way `steps[si..]` can match starting at token `ti`. Longest first is picked by the caller. */
function walk(tokens: GrammarToken[], steps: Step[], si: number, ti: number): Path[] {
  if (si === steps.length) return [{ end: ti, marked: [] }];
  const step = steps[si];
  const out: Path[] = [];
  const mark = step.mark !== false;

  // Consume this step once, then continue with `next` (the index to resume at).
  const once = (next: number): Path[] => {
    const res: Path[] = [];
    if (step.any) {
      for (const alt of step.any) {
        for (const a of walk(tokens, alt, 0, ti)) {
          for (const rest of walk(tokens, steps, next, a.end)) {
            res.push({ end: rest.end, marked: [...(mark ? a.marked : []), ...rest.marked] });
          }
        }
      }
    } else if (ti < tokens.length && tokenMatches(tokens[ti], step) && !(step.not && tokenMatches(tokens[ti], step.not))) {
      for (const rest of walk(tokens, steps, next, ti + 1)) {
        res.push({ end: rest.end, marked: [...(mark ? [ti] : []), ...rest.marked] });
      }
    }
    return res;
  };

  if (step.star && isCondStep(step)) {
    // Greedy: consume as many as match, then try the rest from each point (longest first).
    let k = ti;
    const stops = [ti];
    while (k < tokens.length && tokenMatches(tokens[k], step) && !(step.not && tokenMatches(tokens[k], step.not))) stops.push(++k);
    for (const stop of stops.reverse()) {
      const consumed = mark ? Array.from({ length: stop - ti }, (_, i) => ti + i) : [];
      for (const rest of walk(tokens, steps, si + 1, stop)) out.push({ end: rest.end, marked: [...consumed, ...rest.marked] });
    }
    return out;
  }
  out.push(...once(si + 1));
  if (step.optional) out.push(...walk(tokens, steps, si + 1, ti));
  return out;
}

/** Character offset of each token (and one past the end). */
export function tokenOffsets(tokens: GrammarToken[]): number[] {
  const offs = [0];
  for (const t of tokens) offs.push(offs[offs.length - 1] + t.surface_form.length);
  return offs;
}

/** Run every rule over a token stream. Leftmost-longest per rule, then suppression across rules. */
export function findGrammar(tokens: GrammarToken[], rules: GrammarRule[]): GrammarMatch[] {
  const offs = tokenOffsets(tokens);
  const found: GrammarMatch[] = [];
  for (const rule of rules) {
    let ti = 0;
    while (ti < tokens.length) {
      const paths = walk(tokens, rule.steps, 0, ti).filter((p) => p.marked.length > 0);
      if (!paths.length) { ti++; continue; }
      const best = paths.reduce((a, b) => (b.end > a.end ? b : a));
      const first = Math.min(...best.marked);
      const last = Math.max(...best.marked);
      found.push({ id: rule.id, start: offs[first], end: offs[last + 1], tokenStart: ti, tokenEnd: best.end });
      ti = Math.max(best.end, ti + 1);
    }
  }
  const byId = new Map(rules.map((r) => [r.id, r]));
  return found
    .filter((m) => !found.some((o) => o !== m && byId.get(o.id)?.suppresses?.includes(m.id) && o.start <= m.start && m.end <= o.end))
    .sort((a, b) => a.start - b.start || b.end - a.end);
}
