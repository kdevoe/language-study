// Grammar cards from the weekly recap (docs/grammar-cards-plan.md, database/43).
// After the recap is stored, each of its patterns becomes 2-3 cards: a Japanese
// sentence with a blank and two choices, one right and one wrong, with a short
// English explanation. At least one per pattern is built on the learner's own
// slip (the wrong choice is what they wrote). They come up in the 単語 session.
//
// The recap's examples are the learner's own text, so they're fenced as data.
// Every card is checked before it's stored: shape and length, Japanese only, no
// links, contacts or markup, then a Haiku pass that reads both filled-in
// sentences and keeps the card only if exactly the answer is natural. A card
// with two right answers would teach the wrong thing.
// deno-lint-ignore-file no-explicit-any
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CLAUDE_HAIKU, CLAUDE_SONNET } from '../_shared/models.ts';
import { callTool, emptyUsage } from '../_shared/claude.ts';
import { hasContact } from '../_shared/researchFilter.ts';
import { dataRule, fence } from '../_shared/untrusted.ts';
import type { RecapPattern } from './recap.ts';

export interface GrammarCardDraft {
  pattern: string;
  before: string;
  answer: string;
  wrong: string;
  after: string;
  explain: string;
  from_slip: boolean;
}

const PER_PATTERN = 3;
const MAX_CARDS = 9;
const MAX_CHOICE = 8;
const MAX_SENTENCE = 40;
const MAX_EXPLAIN = 160;

/** Write the cards for one recap (the newest when recapId is omitted). Skips a
 *  recap that already has cards, so a re-run never doubles them. */
export async function writeGrammarCards(admin: SupabaseClient, userId: string, recapId?: string) {
  let q = admin.from('weekly_recaps').select('id, report').eq('user_id', userId);
  q = recapId ? q.eq('id', recapId) : q.order('week_end', { ascending: false }).limit(1);
  const { data: recap } = await q.maybeSingle();
  if (!recap) return { reason: 'no recap' };
  const { count } = await admin.from('grammar_cards').select('id', { count: 'exact', head: true }).eq('recap_id', recap.id);
  if (count) return { reason: 'already has cards', cards: count };
  const patterns = ((recap.report as any)?.patterns ?? []) as RecapPattern[];
  if (!patterns.length) return { reason: 'no patterns' };

  const { data: prefs } = await admin.from('user_preferences').select('jlpt_level').eq('user_id', userId).maybeSingle();
  const jlpt = prefs?.jlpt_level ? `N${prefs.jlpt_level}` : 'N5';
  const usage = emptyUsage(CLAUDE_SONNET);

  const recapText = patterns.map((p, i) => [
    `Pattern ${i + 1}: ${p.short} (${p.title})`,
    `Rule: ${p.explain.join(' ')}`,
    'What they wrote → the correction (changed part):',
    ...p.examples.map((e) => `- ${e.was} → ${e.now}${e.fix ? ` (${e.fix})` : ''}`),
  ].join('\n')).join('\n\n');

  const prompt = `You write grammar flashcards for a Japanese learner at JLPT ${jlpt}, from the patterns their tutor found in their mistakes this week.

${dataRule(['recap'])}

${fence('recap', recapText)}

Each card is one short, natural Japanese sentence with one blank, and two choices for the blank: the right one and a wrong one. The learner picks one; the back shows the answer and your explanation.

For each pattern write ${PER_PATTERN} cards (2 if the pattern is thin):
- At least one built on one of their own sentences: the corrected sentence with the blank where the changed part is, and what they wrote there as the wrong choice. Set from_slip true and copy the words of their sentence exactly.
- The others: fresh everyday sentences testing the same rule, with words at their level. from_slip false.

Rules for every card:
- before + answer + after is the whole sentence, at most ${MAX_SENTENCE} characters, ending in 。 (or ？). Japanese only.
- answer and wrong: each 1-${MAX_CHOICE} characters, never empty. When one choice would be "nothing" (an extra の, a missing だ), make the blank span the whole phrase and offer the two phrases instead (勝つチャンス / 勝つのチャンス).
- Exactly one choice may be correct. Avoid pairs that both work in the sentence (に and で are both fine in many sentences; pick a verb or context that settles it).
- explain: one or two short English sentences on why, with the Japanese words inline, at most ${MAX_EXPLAIN} characters. No markup.
- pattern: the pattern's label exactly as given (the part before the parenthesis).`;

  const out = await callTool<{ cards: any[] }>({
    model: CLAUDE_SONNET, prompt, name: 'write_cards', maxTokens: 3000, usage,
    description: 'Write the grammar flashcards.',
    schema: {
      type: 'object',
      properties: {
        cards: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              pattern: { type: 'string' },
              before: { type: 'string' },
              answer: { type: 'string' },
              wrong: { type: 'string' },
              after: { type: 'string' },
              explain: { type: 'string' },
              from_slip: { type: 'boolean' },
            },
            required: ['pattern', 'before', 'answer', 'wrong', 'after', 'explain', 'from_slip'],
          },
        },
      },
      required: ['cards'],
    },
  });

  const drafts = checkCards(out?.cards, patterns);
  if (!drafts.length) return { reason: 'no card passed checks', costUsd: +usage.costUsd.toFixed(5) };
  const kept = await judgeCards(drafts, usage);
  if (!kept.length) return { reason: 'no card passed the judge', drafted: drafts.length, costUsd: +usage.costUsd.toFixed(5) };

  const { error } = await admin.from('grammar_cards').insert(
    kept.map((c) => ({ ...c, user_id: userId, recap_id: recap.id })),
  );
  if (error) throw error;
  return { cards: kept.length, drafted: drafts.length, slips: kept.filter((c) => c.from_slip).length, costUsd: +usage.costUsd.toFixed(5) };
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

/** Shape, length, script and content checks; a slip card must really be built
 *  on one of the learner's corrections, or it's kept as a fresh one. */
export function checkCards(raw: unknown, patterns: RecapPattern[]): GrammarCardDraft[] {
  const labels = new Map(patterns.map((p) => [squash(p.short), p]));
  const perPattern = new Map<string, number>();
  const seen = new Set<string>();
  const out: GrammarCardDraft[] = [];
  for (const c of (Array.isArray(raw) ? raw : [])) {
    const p = labels.get(squash(String(c?.pattern ?? '')));
    if (!p) continue;
    const before = part(c?.before, MAX_SENTENCE), after = part(c?.after, MAX_SENTENCE);
    const answer = part(c?.answer, MAX_CHOICE), wrong = part(c?.wrong, MAX_CHOICE);
    if (before == null || after == null || !answer || !wrong || answer === wrong) continue;
    const sentence = before + answer + after;
    if (sentence.length > MAX_SENTENCE || !/[。？]$/.test(sentence) || !(before + after).trim()) continue;
    const explain = typeof c?.explain === 'string' ? c.explain.trim() : '';
    if (!explain || explain.length > MAX_EXPLAIN || /[<>]/.test(explain) || hasContact(explain) || /https?:|www\./i.test(explain)) continue;
    if (seen.has(squash(sentence))) continue;
    if ((perPattern.get(p.short) ?? 0) >= PER_PATTERN) continue;
    // Their own sentence: the right version contains their correction, the wrong one what they wrote.
    const fromSlip = c?.from_slip === true && p.examples.some((e) =>
      squash(sentence).includes(squash(e.now)) && squash(before + wrong + after).includes(squash(e.was)));
    seen.add(squash(sentence));
    perPattern.set(p.short, (perPattern.get(p.short) ?? 0) + 1);
    out.push({ pattern: p.short, before, answer, wrong, after, explain, from_slip: fromSlip });
    if (out.length >= MAX_CARDS) break;
  }
  return out;
}

/** A second reader (Haiku, which didn't write them) reads each card's two filled-in
 *  sentences. Kept only when the answer's is natural and the wrong one's isn't. */
async function judgeCards(cards: GrammarCardDraft[], usage: ReturnType<typeof emptyUsage>): Promise<GrammarCardDraft[]> {
  const lines = cards.map((c, i) => `${i + 1}. A: ${c.before}${c.answer}${c.after}\n   B: ${c.before}${c.wrong}${c.after}`).join('\n');
  const prompt = `You check Japanese grammar flashcards. Each card offers two versions of a sentence, A and B, that differ in one place. Judge each version on its own: is it grammatical, natural Japanese that a native speaker would accept? Be strict about B: if B is also acceptable (even if less common), say so.

${lines}`;
  const out = await callTool<{ verdicts: { n: number; a_ok: boolean; b_ok: boolean }[] }>({
    model: CLAUDE_HAIKU, prompt, name: 'judge_cards', maxTokens: 1200, usage,
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
  return cards.filter((_, i) => ok.has(i + 1));
}
