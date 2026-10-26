// Grammar cards from the weekly recap (docs/grammar-cards-plan.md, database/43-44).
// A card is one rule with one schedule and a pool of sentences that test it: a
// Japanese sentence with a blank and two choices, one right and one wrong. Each
// review shows the sentence seen least recently, so the learner applies the rule
// instead of remembering a sentence. After the recap is stored, each pattern's
// rules become cards (or add sentences to a card the learner already has for that
// rule), and pools the learner has seen all of get topped up.
//
// The recap's examples are the learner's own text, so they're fenced as data.
// Every sentence is checked before it's stored: shape and length, Japanese only,
// no links, contacts or markup, then a Haiku pass that reads both filled-in
// versions and keeps it only if exactly the answer is natural. A sentence with
// two right answers would teach the wrong thing.
// deno-lint-ignore-file no-explicit-any
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CLAUDE_HAIKU, CLAUDE_SONNET } from '../_shared/models.ts';
import { callTool, emptyUsage } from '../_shared/claude.ts';
import { hasContact } from '../_shared/researchFilter.ts';
import { dataRule, fence } from '../_shared/untrusted.ts';
import type { RecapPattern } from './recap.ts';

export interface SentenceDraft {
  before: string;
  answer: string;
  wrong: string;
  after: string;
  from_slip: boolean;
}

interface RuleDraft {
  pattern: string;
  rule: string;
  explain: string;
  /** Set when the rule is one the learner already has a card for. */
  existing: string | null;
  sentences: SentenceDraft[];
}

const MAX_NEW_RULES = 6;        // new cards per recap
const NEW_POOL = 5;             // sentences written for a new rule
const MIN_POOL = 2;             // a new rule needs this many to become a card
const ADD_TO_EXISTING = 3;      // sentences a repeat slip adds to its card
const POOL_TARGET = 4;          // a smaller pool is topped up
const POOL_MAX = 12;            // a pool never grows past this
const TOPUP_CARDS = 6;          // pools topped up per run
const TOPUP_SENTENCES = 3;
const MAX_CHOICE = 8;
const MAX_SENTENCE = 40;
const MAX_EXPLAIN = 160;
const MAX_RULE = 60;

const SENTENCE_RULES = `Rules for every sentence:
- before + answer + after is the whole sentence, at most ${MAX_SENTENCE} characters, ending in 。 (or ？). Japanese only.
- answer and wrong: each 1-${MAX_CHOICE} characters, never empty. When one choice would be "nothing" (an extra の, a missing だ), make the blank span the whole phrase and offer the two phrases instead (勝つチャンス / 勝つのチャンス).
- Exactly one choice may be correct. Avoid pairs that both work in the sentence (に and で are both fine in many sentences; pick a verb or context that settles it).
- Vary the sentences: different words, situations and lengths, so none can be answered by remembering another.`;

const SENTENCE_SCHEMA = {
  type: 'object',
  properties: {
    before: { type: 'string' },
    answer: { type: 'string' },
    wrong: { type: 'string' },
    after: { type: 'string' },
    from_slip: { type: 'boolean' },
  },
  required: ['before', 'answer', 'wrong', 'after', 'from_slip'],
};

interface ExistingCard { id: string; pattern: string; rule: string; explain: string; sentences: { before: string; answer: string; wrong: string; after: string; shown_at: string | null }[] }

async function existingCards(admin: SupabaseClient, userId: string): Promise<ExistingCard[]> {
  const { data, error } = await admin.from('grammar_cards')
    .select('id, pattern, rule, explain, sentences:grammar_sentences(before, answer, wrong, after, shown_at)')
    .eq('user_id', userId).order('created_at', { ascending: false }).limit(60);
  if (error) throw error;
  return (data ?? []) as any[];
}

/** Write the cards for one recap (the newest when recapId is omitted). Skips a
 *  recap that already added sentences, so a re-run never doubles them. */
export async function writeGrammarCards(admin: SupabaseClient, userId: string, recapId?: string) {
  let q = admin.from('weekly_recaps').select('id, report').eq('user_id', userId);
  q = recapId ? q.eq('id', recapId) : q.order('week_end', { ascending: false }).limit(1);
  const { data: recap } = await q.maybeSingle();
  if (!recap) return { reason: 'no recap' };
  const { count } = await admin.from('grammar_sentences').select('id', { count: 'exact', head: true }).eq('recap_id', recap.id);
  if (count) return { reason: 'already has cards', sentences: count };
  const patterns = ((recap.report as any)?.patterns ?? []) as RecapPattern[];
  if (!patterns.length) return { reason: 'no patterns' };

  const jlpt = await jlptOf(admin, userId);
  const have = await existingCards(admin, userId);
  const usage = emptyUsage(CLAUDE_SONNET);

  const recapText = patterns.map((p, i) => [
    `Pattern ${i + 1}: ${p.short} (${p.title})`,
    `Rule: ${p.explain.join(' ')}`,
    'What they wrote → the correction (changed part):',
    ...p.examples.map((e) => `- ${e.was} → ${e.now}${e.fix ? ` (${e.fix})` : ''}`),
  ].join('\n')).join('\n\n');
  const cardText = have.map((c, i) => `${i + 1}. ${c.rule}`).join('\n');

  const prompt = `You write grammar flashcards for a Japanese learner at JLPT ${jlpt}, from the patterns their tutor found in their mistakes this week.

${dataRule(['recap', 'cards'])}

${fence('recap', recapText)}

The rules they already have cards for:
${fence('cards', cardText || '(none yet)')}

A card is ONE rule (one contrast) and a pool of sentences that test it. Each review shows a different sentence from the pool: one short, natural Japanese sentence with one blank, and two choices for the blank, the right one and a wrong one. The back shows the answer and the rule's explanation.

For each pattern, find the distinct rules its corrections show (one or two; a pattern like "だ / な / で" can hold several, e.g. "no な between an い-adjective and のに" and "a noun needs だ before と思う"). For each rule:
- If it's one of the rules they already have a card for (same contrast, even if worded differently), set existing to that rule's number and write ${ADD_TO_EXISTING} new sentences for it. rule and explain can be empty.
- Otherwise existing is 0, and write:
  - rule: the rule in a few English words, at most ${MAX_RULE} characters (e.g. "に for where you stay, で for where something happens").
  - explain: one or two short English sentences on the rule, general enough to fit every sentence in the pool, with Japanese words inline, at most ${MAX_EXPLAIN} characters. No markup.
  - ${NEW_POOL} sentences.
- In either case, at least one sentence built on one of their own sentences: the corrected sentence with the blank where the changed part is, and what they wrote there as the wrong choice. Set from_slip true and copy the words of their sentence exactly. The others are fresh everyday sentences with words at their level, from_slip false.
- pattern: the pattern's label exactly as given (the part before the parenthesis).
- When the rule is a contrast (に vs で), let the right answer differ across sentences, so the learner can't always pick the same one.

${SENTENCE_RULES}`;

  const out = await callTool<{ rules: any[] }>({
    model: CLAUDE_SONNET, prompt, name: 'write_cards', maxTokens: 6000, usage,
    description: 'Write the grammar flashcards.',
    schema: {
      type: 'object',
      properties: {
        rules: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              pattern: { type: 'string' },
              existing: { type: 'integer' },
              rule: { type: 'string' },
              explain: { type: 'string' },
              sentences: { type: 'array', items: SENTENCE_SCHEMA },
            },
            required: ['pattern', 'existing', 'rule', 'explain', 'sentences'],
          },
        },
      },
      required: ['rules'],
    },
  });

  const drafts = checkRules(out?.rules, patterns, have);
  const all = drafts.flatMap((r) => r.sentences);
  if (!all.length) return { reason: 'no card passed checks', costUsd: +usage.costUsd.toFixed(5) };
  const ok = await judgeSentences(all, usage);
  let cards = 0, added = 0;
  for (const r of drafts) {
    const keep = r.sentences.filter((s) => ok.has(s));
    if (r.existing) {
      if (!keep.length) continue;
      await insertSentences(admin, userId, r.existing, recap.id, keep);
      added += keep.length;
      continue;
    }
    if (keep.length < MIN_POOL || cards >= MAX_NEW_RULES) continue;
    await insertCard(admin, userId, recap.id, r, keep);
    cards++;
    added += keep.length;
  }
  if (!added) return { reason: 'no card passed the judge', drafted: all.length, costUsd: +usage.costUsd.toFixed(5) };
  return { cards, sentences: added, drafted: all.length, costUsd: +usage.costUsd.toFixed(5) };
}

/** Pools the learner has seen all of (or that are still small) get a few new
 *  sentences, checked and judged like the first ones. */
export async function topUpGrammarCards(admin: SupabaseClient, userId: string) {
  const have = await existingCards(admin, userId);
  const due = have
    .filter((c) => c.sentences.length < POOL_MAX
      && (c.sentences.length < POOL_TARGET || c.sentences.every((s) => s.shown_at != null)))
    .slice(0, TOPUP_CARDS);
  if (!due.length) return { reason: 'no pool needs sentences' };
  const jlpt = await jlptOf(admin, userId);
  const usage = emptyUsage(CLAUDE_SONNET);

  const cardText = due.map((c, i) => [
    `Card ${i + 1}: ${c.rule}`,
    `Explanation on the back: ${c.explain}`,
    'Sentences it already has:',
    ...c.sentences.map((s) => `- ${s.before}［${s.answer} / ${s.wrong}］${s.after}`),
  ].join('\n')).join('\n\n');

  const prompt = `You write grammar flashcards for a Japanese learner at JLPT ${jlpt}. Each card below is one rule with a pool of sentences; each review shows a different one. The learner has seen these pools through, so each card needs fresh sentences.

${dataRule(['cards'])}

${fence('cards', cardText)}

For each card, write ${TOPUP_SENTENCES} new sentences testing the same rule (number = the card's number). Each is one short, natural Japanese sentence with one blank, and two choices for the blank, the right one and a wrong one, of the same kind as the card's existing choices. Make them unlike the existing ones: new words and situations. from_slip is always false. The explanation on the back must still fit.

${SENTENCE_RULES}`;

  const out = await callTool<{ cards: { n: number; sentences: any[] }[] }>({
    model: CLAUDE_SONNET, prompt, name: 'write_sentences', maxTokens: 3000, usage,
    description: 'Write the new sentences.',
    schema: {
      type: 'object',
      properties: {
        cards: {
          type: 'array',
          items: {
            type: 'object',
            properties: { n: { type: 'integer' }, sentences: { type: 'array', items: SENTENCE_SCHEMA } },
            required: ['n', 'sentences'],
          },
        },
      },
      required: ['cards'],
    },
  });

  const byCard = new Map<string, SentenceDraft[]>();
  for (const c of (Array.isArray(out?.cards) ? out.cards : [])) {
    const card = due[(c?.n ?? 0) - 1];
    if (!card || byCard.has(card.id)) continue;
    const seen = new Set(card.sentences.map((s) => squash(s.before + s.answer + s.after)));
    const room = Math.min(TOPUP_SENTENCES, POOL_MAX - card.sentences.length);
    byCard.set(card.id, checkSentences(c?.sentences, [], seen).map((s) => ({ ...s, from_slip: false })).slice(0, room));
  }
  const all = [...byCard.values()].flat();
  if (!all.length) return { reason: 'no sentence passed checks', costUsd: +usage.costUsd.toFixed(5) };
  const ok = await judgeSentences(all, usage);
  let added = 0;
  for (const [cardId, list] of byCard) {
    const keep = list.filter((s) => ok.has(s));
    if (!keep.length) continue;
    await insertSentences(admin, userId, cardId, null, keep);
    added += keep.length;
  }
  return { cards: due.length, sentences: added, drafted: all.length, costUsd: +usage.costUsd.toFixed(5) };
}

async function jlptOf(admin: SupabaseClient, userId: string): Promise<string> {
  const { data: prefs } = await admin.from('user_preferences').select('jlpt_level').eq('user_id', userId).maybeSingle();
  return prefs?.jlpt_level ? `N${prefs.jlpt_level}` : 'N5';
}

/** The card, its first sentence (a slip first) copied onto it for apps that
 *  haven't updated (database/44), then its pool. */
async function insertCard(admin: SupabaseClient, userId: string, recapId: string, r: RuleDraft, sentences: SentenceDraft[]) {
  const ordered = [...sentences].sort((a, b) => Number(b.from_slip) - Number(a.from_slip));
  const first = ordered[0];
  const { data, error } = await admin.from('grammar_cards').insert({
    user_id: userId, recap_id: recapId, pattern: r.pattern, rule: r.rule, explain: r.explain,
    before: first.before, answer: first.answer, wrong: first.wrong, after: first.after, from_slip: first.from_slip,
  }).select('id').single();
  if (error) throw error;
  await insertSentences(admin, userId, data.id, recapId, ordered);
}

async function insertSentences(admin: SupabaseClient, userId: string, cardId: string, recapId: string | null, sentences: SentenceDraft[]) {
  const { error } = await admin.from('grammar_sentences').insert(
    sentences.map((s) => ({ ...s, user_id: userId, card_id: cardId, recap_id: recapId })),
  );
  if (error) throw error;
}

// ── Checks ───────────────────────────────────────────────────────────────────

const squash = (s: string) => s.replace(/[\s。、！？!?]/g, '');
// Kana, kanji, Japanese punctuation, and the odd Latin letter or digit (F1, 3時).
const JAPANESE = /^[぀-ヿ㐀-鿿豈-﫿々〆〜ー・、。！？「」『』（）0-9０-９A-Za-zＡ-Ｚａ-ｚ]*$/;

function part(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length <= max && JAPANESE.test(s) ? s : null;
}

/** English text within a length: no links, contacts or markup. */
function english(v: unknown, max: number): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > max || /[<>]/.test(s) || hasContact(s) || /https?:|www\./i.test(s)) return null;
  return s;
}

/** Shape, length and script checks on a list of sentences; a slip sentence must
 *  really be built on one of the learner's corrections, or it counts as fresh.
 *  `seen` (squashed sentences) is shared, so no sentence appears twice. */
export function checkSentences(raw: unknown, examples: RecapPattern['examples'], seen: Set<string>): SentenceDraft[] {
  const out: SentenceDraft[] = [];
  for (const c of (Array.isArray(raw) ? raw : [])) {
    const before = part(c?.before, MAX_SENTENCE), after = part(c?.after, MAX_SENTENCE);
    const answer = part(c?.answer, MAX_CHOICE), wrong = part(c?.wrong, MAX_CHOICE);
    if (before == null || after == null || !answer || !wrong || answer === wrong) continue;
    const sentence = before + answer + after;
    if (sentence.length > MAX_SENTENCE || !/[。？]$/.test(sentence) || !(before + after).trim()) continue;
    if (seen.has(squash(sentence))) continue;
    // Their own sentence: the right version contains their correction, the wrong one what they wrote.
    const fromSlip = c?.from_slip === true && examples.some((e) =>
      squash(sentence).includes(squash(e.now)) && squash(before + wrong + after).includes(squash(e.was)));
    seen.add(squash(sentence));
    out.push({ before, answer, wrong, after, from_slip: fromSlip });
  }
  return out;
}

/** The rules a recap produced: each tied to a pattern of this recap, a new one
 *  with a rule and explanation, an existing one by its number in `have`. */
export function checkRules(raw: unknown, patterns: RecapPattern[], have: ExistingCard[]): RuleDraft[] {
  const labels = new Map(patterns.map((p) => [squash(p.short), p]));
  const seen = new Set(have.flatMap((c) => c.sentences.map((s) => squash(s.before + s.answer + s.after))));
  const out: RuleDraft[] = [];
  for (const r of (Array.isArray(raw) ? raw : [])) {
    const p = labels.get(squash(String(r?.pattern ?? '')));
    if (!p) continue;
    const ex = Number.isInteger(r?.existing) && r.existing > 0 ? have[r.existing - 1] : undefined;
    if (ex) {
      if (out.some((o) => o.existing === ex.id) || ex.sentences.length >= POOL_MAX) continue;
      const room = Math.min(ADD_TO_EXISTING, POOL_MAX - ex.sentences.length);
      out.push({ pattern: p.short, rule: ex.rule, explain: ex.explain, existing: ex.id, sentences: checkSentences(r?.sentences, p.examples, seen).slice(0, room) });
      continue;
    }
    const rule = english(r?.rule, MAX_RULE), explain = english(r?.explain, MAX_EXPLAIN);
    if (!rule || !explain) continue;
    out.push({ pattern: p.short, rule, explain, existing: null, sentences: checkSentences(r?.sentences, p.examples, seen).slice(0, NEW_POOL) });
  }
  return out;
}

/** A second reader (Haiku, which didn't write them) reads each sentence's two
 *  filled-in versions. Kept only when the answer's is natural and the wrong one's isn't. */
async function judgeSentences(list: SentenceDraft[], usage: ReturnType<typeof emptyUsage>): Promise<Set<SentenceDraft>> {
  const lines = list.map((c, i) => `${i + 1}. A: ${c.before}${c.answer}${c.after}\n   B: ${c.before}${c.wrong}${c.after}`).join('\n');
  const prompt = `You check Japanese grammar flashcards. Each card offers two versions of a sentence, A and B, that differ in one place. Judge each version on its own: is it grammatical, natural Japanese that a native speaker would accept? Be strict about B: if B is also acceptable (even if less common), say so.

${lines}`;
  const out = await callTool<{ verdicts: { n: number; a_ok: boolean; b_ok: boolean }[] }>({
    model: CLAUDE_HAIKU, prompt, name: 'judge_cards', maxTokens: 3000, usage,
    description: 'Judge both versions of each card.',
    schema: {
      type: 'object',
      properties: {
        verdicts: {
          type: 'array',
          items: {
            type: 'object',
            properties: { n: { type: 'integer' }, a_ok: { type: 'boolean' }, b_ok: { type: 'boolean' } },
            required: ['n', 'a_ok', 'b_ok'],
          },
        },
      },
      required: ['verdicts'],
    },
  });
  const ok = new Set((out?.verdicts ?? []).filter((v) => v.a_ok === true && v.b_ok === false).map((v) => v.n));
  return new Set(list.filter((_, i) => ok.has(i + 1)));
}
