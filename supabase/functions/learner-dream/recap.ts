// ハルカ's weekly recap (docs/mockups/weekly-recap.html, database/41). Written by
// the Sunday pass beside the profile re-check: the week's recasts (her <fix> tags
// carry what the learner wrote and why) and flashcard misses become 2-3 recurring
// patterns with the learner's own slips as examples, words that kept slipping,
// and what got solid. Mostly English; the learner opens it from her chat.
//
// The inputs are the learner's own text and ハルカ's replies, fenced all the same,
// and the report is checked before it's stored: every example must be something
// the learner actually wrote, every word one they actually missed, bounded
// lengths, no links, contacts or markup.
// deno-lint-ignore-file no-explicit-any
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CLAUDE_SONNET } from '../_shared/models.ts';
import { callTool, emptyUsage } from '../_shared/claude.ts';
import { hasContact } from '../_shared/researchFilter.ts';
import { dataRule, fence } from '../_shared/untrusted.ts';
import { grammarRatings, surfaces, utcDay } from '../_shared/learner.ts';

export interface RecapExample { was: string; now: string; fix?: string }
export interface RecapPattern { title: string; short: string; count: number; examples: RecapExample[]; explain: string[]; tip: string }
export interface RecapReport { intro: string; lede: string; patterns: RecapPattern[]; words: { word: string; meaning: string }[]; solid: string }

const MIN_FIXES = 4;          // fewer recasts than this in a week: nothing to find patterns in
const MAX_FIXES = 120;

const FIX_RE = /<fix\s+was="([^"]*)"(?:\s+why="([^"]*)")?\s*>([\s\S]*?)<\/fix>/g;

export async function writeRecap(admin: SupabaseClient, userId: string) {
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  const weekEnd = utcDay(new Date(Date.now() - 86400_000));
  const weekStart = utcDay(new Date(Date.now() - 7 * 86400_000));

  const [hers, mine, reviews, kanji, digests, prefs, cardLog] = await Promise.all([
    admin.from('tutor_messages').select('text').eq('user_id', userId).eq('role', 'assistant')
      .gt('created_at', since).like('text', '%<fix%').order('created_at').limit(300),
    admin.from('tutor_messages').select('text').eq('user_id', userId).eq('role', 'user')
      .gt('created_at', since).not('text', 'is', null).order('created_at').limit(400),
    admin.from('srs_review_log').select('word_id, rating').eq('user_id', userId)
      .eq('source', 'flashcard').gt('reviewed_at', since).limit(3000),
    admin.from('kanji_review_log').select('kanji, rating').eq('user_id', userId)
      .eq('source', 'flashcard').gt('reviewed_at', since).limit(3000),
    admin.from('learner_digests').select('day, text').eq('user_id', userId).gte('day', weekStart)
      .order('day').limit(7),
    admin.from('user_preferences').select('jlpt_level, grammar_progress').eq('user_id', userId).maybeSingle(),
    // Last week's grammar cards (grammarCards.ts): what they picked on each.
    admin.from('grammar_review_log').select('picked, correct, card:grammar_cards(pattern, rule, before, answer, after), sentence:grammar_sentences(before, answer, after)')
      .eq('user_id', userId).gt('reviewed_at', since).limit(500),
  ]);

  // Recasts with what the learner wrote. A tag without was= has no evidence.
  const fixes: { was: string; now: string; why: string }[] = [];
  for (const r of (hers.data ?? []) as { text: string }[]) {
    for (const m of r.text.matchAll(FIX_RE)) {
      const was = m[1].trim(), now = m[3].trim();
      if (was && now && was !== now) fixes.push({ was, now, why: (m[2] ?? '').trim() });
    }
  }
  const learnerText = ((mine.data ?? []) as { text: string }[]).map((r) => r.text);

  // Flashcard misses, worst first.
  const byWord = new Map<string, { again: number; hard: number; n: number }>();
  for (const r of (reviews.data ?? []) as { word_id: string; rating: number }[]) {
    const w = byWord.get(r.word_id) ?? { again: 0, hard: 0, n: 0 };
    w.n++;
    if (r.rating === 1) w.again++;
    if (r.rating === 2) w.hard++;
    byWord.set(r.word_id, w);
  }
  const missed = [...byWord.entries()].filter(([, w]) => w.again + w.hard > 0)
    .sort((a, b) => (b[1].again * 2 + b[1].hard) - (a[1].again * 2 + a[1].hard)).slice(0, 40);
  const names = await surfaces(admin, missed.map(([id]) => id));
  const glosses = await firstGlosses(admin, missed.map(([id]) => id));
  const missLines = missed.map(([id, w]) => `${names[id] ?? id} (${glosses[id] ?? '?'}): Again ×${w.again}, Hard ×${w.hard}, of ${w.n}`);
  const missedSurfaces = new Set(missed.map(([id]) => names[id]).filter(Boolean));
  const kanjiAgain = [...new Set(((kanji.data ?? []) as { kanji: string; rating: number }[]).filter((r) => r.rating === 1).map((r) => r.kanji))];
  const totalReviews = (reviews.data ?? []).length;
  const cardLines = grammarCardLines((cardLog.data ?? []) as any[]);

  if (fixes.length < MIN_FIXES) return { reason: 'too few corrections', fixes: fixes.length };

  const usage = emptyUsage(CLAUDE_SONNET);
  const jlpt = prefs.data?.jlpt_level ? `N${prefs.data.jlpt_level}` : 'unknown';
  const prompt = `You are ハルカ, a friendly Japanese tutor inside Yugen, writing the learner's weekly recap for ${weekStart} to ${weekEnd}. They read it on Sunday in a sheet opened from your chat. It is mostly in English (they're at JLPT ${jlpt}), with their own Japanese as examples.

What it's for: show the few mistakes that keep coming back, so they can fix them. Find what the slips have in common (adjective types, particles, verb forms, word choice), not a list of every slip. Be warm and plain, never a scold.

${dataRule(['corrections', 'learner', 'misses', 'cards', 'days'])}

CORRECTIONS THIS WEEK (your recasts in chat: what they wrote → what you said back, and why)
${fence('corrections', fixes.slice(0, MAX_FIXES).map((f) => `- ${f.was} → ${f.now}${f.why ? ` (${f.why})` : ''}`).join('\n'))}

WHAT THEY WROTE THIS WEEK
${fence('learner', learnerText.join('\n').slice(-8000))}

FLASHCARD MISSES (${totalReviews} reviews this week)
${fence('misses', [missLines.join('\n') || '(none)', kanjiAgain.length ? `Kanji forgotten: ${kanjiAgain.slice(0, 30).join('')}` : ''].filter(Boolean).join('\n'))}
Grammar they rated themselves: ${grammarRatings(prefs.data?.grammar_progress ?? {})}

GRAMMAR CARDS (from earlier recaps' patterns: the sentence, then how they did)
${fence('cards', cardLines || '(none this week)')}

THE WEEK, DAY BY DAY
${fence('days', ((digests.data ?? []) as any[]).map((d) => `${d.day}: ${d.text}`).join('\n') || '(none)')}

Call write_recap with:
- teaser: one short, casual Japanese line you'd say on the Home card that the recap is ready and names the main pattern, at their level (e.g. 「今週のまとめができたよ。い形容詞とな形容詞が、まだちょっと混ざってるね。」). At most 60 characters.
- intro: one short Japanese line opening the report, in your voice.
- lede: 1-2 English sentences: the overall picture, encouraging and honest.
- patterns: 2-3 patterns, most frequent first, each backed by at least 2 corrections above:
  - title: a plain English sentence naming the pattern ("い and な adjectives get mixed up").
  - short: a 2-4 word label for it ("い / な adjectives").
  - count: how many corrections above belong to it.
  - examples: 2-5 of them. was = exactly what they wrote, copied character for character from the corrections; now = the corrected Japanese; fix = the part of now that changed (a substring of now).
  - explain: 1-2 short English paragraphs on the rule, with a few Japanese words inline. No markup.
  - tip: one sentence, a concrete thing to check for this week.
- words: 0-6 words from FLASHCARD MISSES that kept slipping (word exactly as listed, meaning in 1-3 English words).
- solid: one or two English sentences on something that went well this week (a pattern they used naturally, longer sentences, a grammar card pattern they now get right), from the evidence. Never invent.
A grammar card pattern they keep missing can count toward a pattern above, if the corrections show it too.
Only use what's above. Don't count a typo as a pattern.`;

  const out = await callTool<RecapReport & { teaser: string }>({
    model: CLAUDE_SONNET, prompt, name: 'write_recap', maxTokens: 4000, usage,
    description: "Write this week's recap of recurring mistakes.",
    schema: {
      type: 'object',
      properties: {
        teaser: { type: 'string' },
        intro: { type: 'string' },
        lede: { type: 'string' },
        patterns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              short: { type: 'string' },
              count: { type: 'integer' },
              examples: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { was: { type: 'string' }, now: { type: 'string' }, fix: { type: 'string' } },
                  required: ['was', 'now', 'fix'],
                },
              },
              explain: { type: 'array', items: { type: 'string' } },
              tip: { type: 'string' },
            },
            required: ['title', 'short', 'count', 'examples', 'explain', 'tip'],
          },
        },
        words: {
          type: 'array',
          items: { type: 'object', properties: { word: { type: 'string' }, meaning: { type: 'string' } }, required: ['word', 'meaning'] },
        },
        solid: { type: 'string' },
      },
      required: ['teaser', 'intro', 'lede', 'patterns', 'words', 'solid'],
    },
  });

  const checked = checkRecap(out, fixes, learnerText, missedSurfaces);
  if (!checked) return { reason: 'recap failed checks', costUsd: +usage.costUsd.toFixed(5) };
  const { teaser, report } = checked;
  const title = report.patterns.map((p) => p.short).join(' · ');
  const { data: row, error } = await admin.from('weekly_recaps').upsert(
    { user_id: userId, week_start: weekStart, week_end: weekEnd, title, teaser, report, usage },
    { onConflict: 'user_id,week_end' },
  ).select('id').single();
  if (error) throw error;
  return { id: row.id as string, patterns: report.patterns.length, words: report.words.length, costUsd: +usage.costUsd.toFixed(5) };
}

/** One line per grammar card (one rule) reviewed this week: right/wrong counts,
 *  and the sentences missed with what was picked. Old log rows have no sentence. */
type Shown = { before: string; answer: string; after: string };
function grammarCardLines(rows: { picked: string | null; correct: boolean; card: (Shown & { pattern: string; rule: string | null }) | null; sentence: Shown | null }[]): string {
  const by = new Map<string, { pattern: string; rule: string; right: number; wrong: string[] }>();
  for (const r of rows) {
    if (!r.card) continue;
    const s = r.sentence ?? r.card;
    const key = r.card.rule ?? `${r.card.before}＿${r.card.after}`;
    const c = by.get(key) ?? { pattern: r.card.pattern, rule: key, right: 0, wrong: [] };
    if (r.correct) c.right++;
    else c.wrong.push(`${s.before}＿${s.after} (picked ${r.picked ?? '?'}, answer ${s.answer})`);
    by.set(key, c);
  }
  return [...by.values()].sort((a, b) => b.wrong.length - a.wrong.length).slice(0, 30)
    .map((c) => `- [${c.pattern}] ${c.rule}: right ×${c.right}${c.wrong.length ? `, wrong ×${c.wrong.length}: ${[...new Set(c.wrong)].slice(0, 4).join('; ')}` : ''}`)
    .join('\n');
}

// ── Checks ───────────────────────────────────────────────────────────────────

const squash = (s: string) => s.replace(/\s+/g, '');
/** Plain text within a length: no links, contacts or markup. */
function clean(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > max || /[<>]/.test(s) || hasContact(s)) return null;
  return s;
}

export function checkRecap(
  out: any, fixes: { was: string }[], learnerText: string[], missed: Set<string>,
): { teaser: string; report: RecapReport } | null {
  const teaser = clean(out?.teaser, 80);
  const intro = clean(out?.intro, 120);
  const lede = clean(out?.lede, 400);
  if (!teaser || !intro || !lede) return null;
  const wrote = new Set(fixes.map((f) => squash(f.was)));
  const said = learnerText.map(squash);
  // An example counts only if the learner really wrote it: a recast's was, or
  // words from one of their messages.
  const real = (was: string) => wrote.has(squash(was)) || said.some((t) => t.includes(squash(was)));

  const patterns: RecapPattern[] = [];
  for (const p of (Array.isArray(out?.patterns) ? out.patterns : []).slice(0, 3)) {
    const title = clean(p?.title, 90), short = clean(p?.short, 32), tip = clean(p?.tip, 220);
    const explain = (Array.isArray(p?.explain) ? p.explain : []).map((e: unknown) => clean(e, 420)).filter(Boolean).slice(0, 2) as string[];
    const examples: RecapExample[] = [];
    for (const e of (Array.isArray(p?.examples) ? p.examples : []).slice(0, 5)) {
      const was = clean(e?.was, 60), now = clean(e?.now, 60);
      if (!was || !now || was === now || !real(was)) continue;
      const fix = clean(e?.fix, 60);
      examples.push({ was, now, ...(fix && now.includes(fix) ? { fix } : {}) });
    }
    if (!title || !short || !tip || !explain.length || examples.length < 2) continue;
    const count = Math.min(fixes.length, Math.max(examples.length, Number.isInteger(p?.count) ? p.count : 0));
    patterns.push({ title, short, count, examples, explain, tip });
  }
  if (!patterns.length) return null;

  const words = (Array.isArray(out?.words) ? out.words : [])
    .map((w: any) => ({ word: clean(w?.word, 20), meaning: clean(w?.meaning, 40) }))
    .filter((w: { word: string | null; meaning: string | null }) => w.word && w.meaning && missed.has(w.word))
    .slice(0, 6) as { word: string; meaning: string }[];
  const solid = clean(out?.solid, 320) ?? '';
  return { teaser, report: { intro, lede, patterns, words, solid } };
}

async function firstGlosses(admin: SupabaseClient, ids: string[]): Promise<Record<string, string>> {
  const uniq = [...new Set(ids.filter((id) => /^\d+$/.test(id)))];
  if (!uniq.length) return {};
  const { data } = await admin.from('jmdict_senses').select('entry_id, gloss, id').in('entry_id', uniq).order('id');
  const out: Record<string, string> = {};
  for (const r of (data ?? []) as { entry_id: string; gloss: string[] }[]) out[r.entry_id] ??= (r.gloss ?? []).slice(0, 2).join('; ');
  return out;
}
