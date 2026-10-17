// The news editor (docs/learner-memory-design.md §5): Haiku picks the learner's
// next stories from today's RSS pool, reading their memory, with full text
// fetched BEFORE the final pick so a thin source can never be chosen.
//
//   1. shortlist  Haiku sees the pool (headline + teaser), the profile, tonight's
//                 brief and the last 30 days of shown titles → ~10 stories across
//                 topics, same-story coverage grouped by id
//   2. extract    every shortlisted item under 1,500 chars gets its full text:
//                 keyed Jina first, then Claude web_fetch on the same URL
//   3. pick       Haiku orders the picks with each item's real text length
//                 visible; THIN items are off the table
//
// Rules (agreed 2026-10-17): no repeats (hard) > variety first (span topics, add
// a rare one) > taste lightly (a skip never excludes a subject).
// The rewrite stays with process-article: the spike's A/B showed Gemini writes
// as well from the raw sources as from a Haiku-written article
// (docs/spikes/curation-e2e.html), so the editor's value is choosing.
// deno-lint-ignore-file no-explicit-any
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { NEWS_EDITOR } from '../_shared/models.ts';
import { addUsage, anthropic, callTool, emptyUsage, type Usage } from '../_shared/claude.ts';
import { loadMemory, recentShown, renderMemory, topicCoverage } from '../_shared/learner.ts';

export interface EditorItem {
  title: string;
  teaser: string;
  url: string;
  date: string;
  source: string;
  category: string;
  topic: string;
}

export interface EditorPick {
  items: EditorItem[];   // lead first; teaser holds the full text we fetched
  topic: string;
  title: string;         // working title (English)
  summary: string;       // one line, English
  reason: string;        // why it was picked
}

const FULL = 1500;                // process-article FULL_SOURCE_CHARS
const SHORTLIST = 10;
const PICKS = 6;                  // enough for a few buffer refills
const JINA_TIMEOUT_MS = 20_000;
const MAX_TEXT = 9000;

/** Keep prose; drop menus, link lists and image lines (extractors return page markdown). */
const prose = (t: string) => t.split('\n')
  .map((l) => l.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim())
  .filter((l) => l.split(/\s+/).length >= 12).join('\n\n');

async function jina(url: string, key: string | undefined): Promise<string> {
  const headers: Record<string, string> = { 'User-Agent': 'YugenStudy/1.0', Accept: 'text/plain' };
  if (key) headers.Authorization = `Bearer ${key}`;
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, { headers, signal: AbortSignal.timeout(JINA_TIMEOUT_MS) });
    if (!res.ok) return '';
    const t = await res.text();
    return prose(t.split(/Markdown Content:\s*/i).pop() || t);
  } catch { return ''; }
}

/** Fallback extractor: Claude's web_fetch on a URL we already have ($0.001–0.003, no search fee). */
async function webFetch(url: string, usage: Usage): Promise<string> {
  try {
    const msg: any = await anthropic.messages.create({
      model: NEWS_EDITOR,
      max_tokens: 1024,
      tools: [{ type: 'web_fetch_20260318', name: 'web_fetch', max_uses: 1, allowed_callers: ['direct'], max_content_tokens: 12000 }],
      messages: [{ role: 'user', content: `Fetch ${url} and reply with just OK or FAILED.` }],
    } as any);
    addUsage(usage, msg.usage);
    const res = msg.content.find((b: any) => b.type === 'web_fetch_tool_result')?.content;
    return res?.type === 'web_fetch_result' ? prose(res.content?.source?.data ?? '') : '';
  } catch (e) {
    console.warn('[editor] web_fetch failed:', e instanceof Error ? e.message : e);
    return '';
  }
}

const RULES = `How to choose, in priority order:
1. NO REPEATS (hard rule): never pick a story they've already been shown (opened, finished, skipped or unread) unless there's a substantial new development — then say what's new.
2. VARIETY FIRST: this is a study app; the reader wants to meet many different subjects and vocabularies. Spread across their chosen topics, and include at least one topic that has been rare in their recent history (see coverage and the brief's due topics).
3. TASTE, LIGHTLY: use what they open, finish and tell their tutor to choose WHICH story to take within a topic and the angle — never to drop a topic. A skip is a weak signal about that one story (timing, headline, mood), not a dislike of its subject; never exclude a subject or company because of skips.
Always skip live blogs, quizzes, opinion columns, sports scores, celebrity gossip, and grim stories with nothing to learn from. Prefer concrete stories a learner can follow.`;

export async function runEditor(opts: {
  admin: SupabaseClient;
  userId: string;
  pool: EditorItem[];
  topics: string[];
  jinaKey: string | undefined;
}): Promise<{ picks: EditorPick[]; usage: Usage }> {
  const { admin, userId, topics, jinaKey } = opts;
  const pool = opts.pool.map((it, id) => ({ ...it, id, via: 'rss' }));
  const usage = emptyUsage(NEWS_EDITOR);

  const [memory, shown] = await Promise.all([loadMemory(admin, userId), recentShown(admin, userId, 30)]);
  const coverage = topicCoverage(shown);
  const editor = `You are the news editor for Yugen, a Japanese-learning reading app. Each story you pick is rewritten into Japanese at the reader's level, so a story with real reporting beats a thin one.
Their chosen topics: ${topics.join(', ')}.

${renderMemory(memory, { brief: true })}
${memory.brief ? `Editor brief from last night: due topics ${memory.brief.editor.dueTopics.join(', ') || 'none'}; angles ${memory.brief.editor.angles.join('; ') || 'none'}; follow-ups ${memory.brief.editor.followUps.join('; ') || 'none'}.` : ''}

TOPIC COVERAGE, last 30 days (shown / opened): ${topics.map((t) => `${t} ${coverage[t]?.shown ?? 0}/${coverage[t]?.opened ?? 0}`).join(', ')}

ALREADY SHOWN, last 30 days (newest first):
${shown.map((s) => `- ${s.day} [${s.topic || '?'}] ${s.title} — ${s.outcome}`).join('\n') || '(nothing yet)'}

${RULES}`;

  // 1. Shortlist from headlines + teasers.
  const listing = pool.map((i) => `[${i.id}] (${i.topic}, ${i.source}) ${i.title} — ${i.teaser.slice(0, 220)}`).join('\n');
  const sl = await callTool<{ stories: { topic: string; title: string; ids: number[] }[] }>({
    model: NEWS_EDITOR, usage, maxTokens: 6000, name: 'shortlist',
    description: 'Shortlist candidate stories from the pool.',
    prompt: `${editor}

Step 1 of 2: from today's pool, SHORTLIST ${SHORTLIST} candidate stories across as many of their topics as the pool allows (at least ${Math.min(5, topics.length)}). Where several outlets cover the same story, group all their ids in one story (lead outlet first). Full text will be fetched for your shortlist before the final pick.

TODAY'S POOL:
${listing}`,
    schema: {
      type: 'object',
      properties: {
        stories: {
          type: 'array',
          items: {
            type: 'object',
            properties: { topic: { type: 'string' }, title: { type: 'string' }, ids: { type: 'array', items: { type: 'integer' } } },
            required: ['topic', 'title', 'ids'],
          },
        },
      },
      required: ['stories'],
    },
  });
  const stories = (sl.stories ?? [])
    .map((s) => ({ ...s, ids: [...new Set(s.ids)].filter((id) => pool[id]).slice(0, 4) }))
    .filter((s) => s.ids.length > 0);
  if (!stories.length) throw new Error('editor shortlist empty');

  // 2. Full text for every shortlisted item that arrived thin.
  const ids = [...new Set(stories.flatMap((s) => s.ids))];
  await Promise.all(ids.map(async (id) => {
    const it = pool[id];
    if (it.teaser.length >= FULL) return;
    const j = await jina(it.url, jinaKey);
    if (j.length >= FULL) { Object.assign(it, { teaser: j.slice(0, MAX_TEXT), via: 'jina' }); return; }
    const w = await webFetch(it.url, usage);
    const best = w.length > j.length ? { text: w, via: 'web_fetch' } : { text: j, via: 'jina' };
    if (best.text.length > it.teaser.length) Object.assign(it, { teaser: best.text.slice(0, MAX_TEXT), via: best.via });
  }));
  const via = ids.reduce((m: Record<string, number>, id) => ({ ...m, [pool[id].via]: (m[pool[id].via] ?? 0) + 1 }), {});
  const thin = ids.filter((id) => pool[id].teaser.length < FULL).length;
  console.log(`[editor] shortlist ${stories.length} stories / ${ids.length} items → ${JSON.stringify(via)}, thin ${thin}`);

  // 3. Final pick with real lengths visible.
  const line = (id: number) => {
    const n = pool[id].teaser.length;
    return `[${id}] (${pool[id].topic}, ${pool[id].source}, ${n} chars${n < FULL ? ' — THIN' : ''}) ${pool[id].title}`;
  };
  const pk = await callTool<{ picks: { ids: number[]; topic: string; title: string; summary: string; reason: string }[] }>({
    model: NEWS_EDITOR, usage, maxTokens: 6000, name: 'pick',
    description: 'Choose and order the stories to publish.',
    prompt: `${editor}

Step 2 of 2: here is your shortlist with the FULL TEXT LENGTH we actually have for each item. Choose up to ${PICKS} stories, in the order they should be published:
- A story's lead item must be ${FULL}+ chars of real text; add other outlets' items only if they bring facts. Never build a story on THIN items.
- Order for variety: consecutive picks on different topics, and the first two on two different topics. Put a rarely-seen topic within the first three.
- summary: one plain English line saying what the story is about. reason: one line on why you picked it for this reader (variety role, interest, follow-up) — their tutor may quote it.

SHORTLIST:
${stories.map((s) => `${s.title} (${s.topic})\n${s.ids.map(line).join('\n')}`).join('\n\n')}`,
    schema: {
      type: 'object',
      properties: {
        picks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ids: { type: 'array', items: { type: 'integer' } },
              topic: { type: 'string' },
              title: { type: 'string' },
              summary: { type: 'string' },
              reason: { type: 'string' },
            },
            required: ['ids', 'topic', 'title', 'summary', 'reason'],
          },
        },
      },
      required: ['picks'],
    },
  });

  const picks: EditorPick[] = [];
  for (const p of pk.picks ?? []) {
    const items = [...new Set(p.ids)].map((id) => pool[id]).filter(Boolean);
    // Enforce the gate in code too: the lead must be full text.
    const lead = items.findIndex((it) => it.teaser.length >= FULL);
    if (lead < 0) continue;
    const ordered = [items[lead], ...items.filter((_, k) => k !== lead)].slice(0, 4);
    picks.push({
      items: ordered.map(({ id: _id, via: _via, ...rest }) => rest),
      topic: topics.includes(p.topic) ? p.topic : ordered[0].topic,
      title: p.title, summary: p.summary, reason: p.reason,
    });
  }
  console.log(`[editor] ${picks.length} picks (${picks.map((p) => p.topic).join(', ')}) $${usage.costUsd.toFixed(4)}`);
  return { picks, usage };
}
