/**
 * Spike: Haiku as the news editor over the RSS pool we already scrape (no web
 * search), history-aware, with full text fetched BEFORE anything is chosen.
 *
 *   [PLAN_ONLY=1] node --env-file=.env scripts/spike-curate-rss.mjs <out.json> [topic,topic…] [history.json] [fixtures-dir]
 *
 * history.json: `supabase db query` output over processed_news (d, status, title)
 * — opened vs swiped-away titles. fixtures-dir: where to write eval fixtures for
 * the Gemini pass (scripts/eval-article-rewrite.mjs --fixtures-dir).
 *
 * 1. Pool: the fetch-raw-news feeds for the topics; title / link / teaser
 *    (content:encoded when the feed ships it).
 * 2. Shortlist: Haiku sees the pool as one-line headlines + teasers, plus the
 *    reading history, and shortlists ~10 candidate stories (no repeats, many topics).
 * 3. Extract: every shortlisted item under 1,500 chars gets its full text — Jina
 *    first (today's extractor), then Claude web_fetch for whatever Jina misses.
 * 4. Pick: Haiku chooses 3 stories + 1 roundup from the shortlist, now seeing each
 *    item's real text length; thin candidates are off the table.
 * 5. Write: Haiku writes a clean English source article per piece, or replies
 *    INSUFFICIENT instead of padding.
 * 6. Fixtures: per piece, an A/B pair for the production rewrite prompt — A = the
 *    raw source block process-article would build today, B = Haiku's article —
 *    with a real N4 lexicon palette (from eval-010), so Gemini's output and the
 *    judge scores compare like for like.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const [out, topicArg, historyFile, fixturesDir] = process.argv.slice(2);
const KEY = process.env.ANTHROPIC_API_KEY;
if (!out || !KEY) { console.error('usage: node --env-file=.env scripts/spike-curate-rss.mjs <out.json> [topics] [history.json] [fixtures-dir]'); process.exit(1); }
const TOPICS = (topicArg ?? 'world,technology,science,japan,ai,space,food').split(',');
const MODEL = 'claude-haiku-5-5';
const PRICE = { in: 0.10, out: 0.50 };
const FULL = 1500; // process-article FULL_SOURCE_CHARS

// Subset of supabase/functions/fetch-raw-news FEED_LIST.
const FEEDS = [
  ['BBC', 'https://feeds.bbci.co.uk/news/rss.xml', 'world'],
  ['NPR', 'https://feeds.npr.org/1001/rss.xml', 'world'],
  ['Guardian', 'https://www.theguardian.com/world/rss', 'world'],
  ['The Verge', 'https://www.theverge.com/rss/index.xml', 'technology'],
  ['Ars Technica', 'https://feeds.arstechnica.com/arstechnica/index', 'technology'],
  ['Guardian Tech', 'https://www.theguardian.com/technology/rss', 'technology'],
  ['Guardian Sci', 'https://www.theguardian.com/science/rss', 'science'],
  ['BBC Science', 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', 'science'],
  ['Japan Times', 'https://www.japantimes.co.jp/feed/', 'japan'],
  ['Guardian Japan', 'https://www.theguardian.com/world/japan/rss', 'japan'],
  ['The Verge AI', 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', 'ai'],
  ['TechCrunch AI', 'https://techcrunch.com/category/artificial-intelligence/feed/', 'ai'],
  ['Guardian Space', 'https://www.theguardian.com/science/space/rss', 'space'],
  ['NASA', 'https://www.nasa.gov/news-release/feed/', 'space'],
  ['Guardian Food', 'https://www.theguardian.com/food/rss', 'food'],
  ['NPR Food', 'https://feeds.npr.org/1053/rss.xml', 'food'],
].filter(([, , t]) => TOPICS.includes(t));

const strip = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, '’').replace(/&#8216;|&lsquo;/g, '‘')
  .replace(/&#8220;|&ldquo;/g, '“').replace(/&#8221;|&rdquo;/g, '”').replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#\d+;/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (x, t) => { const m = x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m ? m[1] : ''; };

async function loadFeed([name, url, topic]) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'YugenStudy/1.0' }, signal: AbortSignal.timeout(8000) });
    const xml = await res.text();
    return [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/g)].slice(0, 12).map(([x]) => {
      const link = strip(tag(x, 'link')) || (x.match(/<link[^>]*href="([^"]+)"/)?.[1] ?? '');
      const body = strip(tag(x, 'content:encoded') || tag(x, 'content'));
      const teaser = strip(tag(x, 'description') || tag(x, 'summary'));
      return { outlet: name, topic, title: strip(tag(x, 'title')), url: link, text: (body.length > teaser.length ? body : teaser).slice(0, 4500), via: 'rss' };
    }).filter((i) => i.title && i.url);
  } catch { return []; }
}

// Keep prose, drop menus / link lists / image lines (both extractors return page markdown).
const prose = (t) => t.split('\n')
  .map((l) => l.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim())
  .filter((l) => l.split(/\s+/).length >= 12).join('\n\n');

async function jina(url) {
  const headers = { Accept: 'text/plain' };
  if (process.env.JINA_API_KEY) headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, { headers, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return '';
    const t = await res.text();
    return prose(t.split(/Markdown Content:\s*/i).pop() || t);
  } catch { return ''; }
}

const usage = { input: 0, output: 0, calls: 0, fetches: 0 };
async function claude(body) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, ...body }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(j).slice(0, 300)}`);
  usage.input += j.usage.input_tokens; usage.output += j.usage.output_tokens; usage.calls++;
  usage.fetches += j.usage.server_tool_use?.web_fetch_requests ?? 0;
  return { ...j, text: j.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim() };
}
const ask = (prompt, maxTokens) => claude({ max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] });
const cost = (u) => (u.input_tokens * PRICE.in + u.output_tokens * PRICE.out) / 1e6;
const json = (t) => JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));

// Fallback extractor: Claude's web_fetch on a URL we already have (no search fee).
async function webFetch(url) {
  try {
    const r = await claude({
      max_tokens: 1024,
      tools: [{ type: 'web_fetch_20260318', name: 'web_fetch', max_uses: 1, allowed_callers: ['direct'], max_content_tokens: 12000 }],
      messages: [{ role: 'user', content: `Fetch ${url} and reply with just OK or FAILED.` }],
    });
    const res = r.content.find((b) => b.type === 'web_fetch_tool_result')?.content;
    return { text: res?.type === 'web_fetch_result' ? prose(res.content?.source?.data ?? '') : '', cost: cost(r.usage) };
  } catch { return { text: '', cost: 0 }; }
}

const t0 = Date.now();
const pool = (await Promise.all(FEEDS.map(loadFeed))).flat().map((it, id) => ({ id, ...it }));
console.log(`pool: ${pool.length} items from ${FEEDS.length} feeds (${TOPICS.join(', ')})`);

// Reading history: "read" = the reader opened it; "dismissed" = swiped away unread.
const history = historyFile ? JSON.parse(readFileSync(historyFile, 'utf8')).rows.filter((r) => r.title) : [];
const histList = (s) => history.filter((r) => r.status === s).map((r) => `- ${r.d}: ${r.title}`).join('\n');
const historyBlock = history.length ? `
READING HISTORY, last 30 days, newest first. "Opened" means the reader chose to read it; "Skipped" means they swiped it away without opening.
Opened:
${histList('read')}
Skipped:
${histList('dismissed')}
` : '';
const RULES = `How to choose, in priority order:
1. NO REPEATS (hard rule): never pick a story they've already been shown, opened or skipped, unless there's a substantial new development — then say what's new.
2. VARIETY FIRST: this is a study app; the reader wants to meet many different subjects and vocabularies. Spread across topics, and include at least one topic that is rare or absent in their recent history.
3. TASTE, LIGHTLY: use what they open to choose WHICH story to take within a topic and what angle to lead with — never to drop a topic. A skip is a weak signal about that one story (timing, headline, mood), not a dislike of its subject; never exclude a subject or company because of skips.
Always skip live blogs, quizzes, opinion columns, sports scores, celebrity gossip, and grim stories with nothing to learn from. Prefer concrete stories a learner can follow.`;
const EDITOR = `You are the news editor for a Japanese-learning reading app. The reader is curious and intermediate; they like ${TOPICS.join(', ')}.\n${historyBlock}\n${RULES}`;

// 2. Shortlist from headlines + teasers.
const listing = pool.map((i) => `[${i.id}] (${i.topic}, ${i.outlet}) ${i.title} — ${i.text.slice(0, 220)}`).join('\n');
const sl = await ask(`${EDITOR}

Step 1 of 2: from today's pool, SHORTLIST 10 candidate stories across at least 5 topics, plus 4-6 small items that could make a themed roundup. Where several outlets cover the same story, group all their ids. Full text will be fetched for your shortlist before the final pick.
Reply with ONLY JSON: {"profile":"2-3 sentences: what they tend to open, and which topics they've seen least lately","stories":[{"topic":"…","title":"working title","ids":[…]}],"roundupIds":[…]}

TODAY'S POOL:
${listing}`, 6000);
const shortlist = json(sl.text);
console.log(`shortlist: $${cost(sl.usage).toFixed(4)}  ${shortlist.stories.length} stories + ${shortlist.roundupIds.length} roundup items`);
console.log(`profile: ${shortlist.profile}`);

// 3. Extract full text for every shortlisted item that arrived thin.
const ids = [...new Set([...shortlist.stories.flatMap((s) => s.ids), ...shortlist.roundupIds])].filter((id) => pool[id]);
let fetchCost = 0;
await Promise.all(ids.map(async (id) => {
  const it = pool[id];
  if (it.text.length >= FULL) return;
  const j = await jina(it.url);
  if (j.length >= FULL) { Object.assign(it, { text: j.slice(0, 9000), via: 'jina' }); return; }
  const w = await webFetch(it.url);
  fetchCost += w.cost;
  const best = [[j, 'jina'], [w.text, 'web_fetch']].sort((a, b) => b[0].length - a[0].length)[0];
  if (best[0].length > it.text.length) Object.assign(it, { text: best[0].slice(0, 9000), via: best[1] });
}));
const viaCount = ids.reduce((m, id) => ({ ...m, [pool[id].via]: (m[pool[id].via] ?? 0) + 1 }), {});
console.log(`extract: ${ids.length} items → ${JSON.stringify(viaCount)}; thin after extraction: ${ids.filter((id) => pool[id].text.length < FULL).length}; web_fetch $${fetchCost.toFixed(4)}`);

// 4. Final pick, with real text lengths visible.
const line = (id) => `[${id}] (${pool[id].topic}, ${pool[id].outlet}, ${pool[id].text.length} chars${pool[id].text.length < FULL ? ' — THIN' : ''}) ${pool[id].title}`;
const pk = await ask(`${EDITOR}

Step 2 of 2: here is your shortlist, now with the FULL TEXT LENGTH we actually have for each item. Plan 4 pieces:
- 3 "story" pieces on 3 different topics. A story's items must add up to at least ${FULL} chars of real text, and every item you use should be ${FULL}+ chars unless it only adds a detail; never build a story on THIN items.
- 1 "roundup": 3-4 related items on a common theme (each ideally 1,000+ chars), with a theme title.
Together the 4 pieces must cover at least 4 different topics.
Reply with ONLY JSON: {"pieces":[{"kind":"story"|"roundup","topic":"…","title":"working title","ids":[…],"why":"one sentence","history":"repeat check, variety role, any taste signal used"}]}

SHORTLISTED STORIES:
${shortlist.stories.map((s) => `${s.title} (${s.topic})\n${s.ids.filter((id) => pool[id]).map(line).join('\n')}`).join('\n\n')}

ROUNDUP CANDIDATES:
${shortlist.roundupIds.filter((id) => pool[id]).map(line).join('\n')}`, 6000);
const plan = json(pk.text);
console.log(`pick: $${cost(pk.usage).toFixed(4)}`);
for (const p of plan.pieces) console.log(`  ${p.kind.padEnd(8)} (${p.topic}) ${p.title}  [${p.ids.map((id) => `${id}:${pool[id]?.text.length}`).join(', ')}]\n           ${p.history}`);
if (process.env.PLAN_ONLY) process.exit(0);

// 5. Write the English source articles.
const pieces = [];
await Promise.all(plan.pieces.map(async (p, n) => {
  const items = p.ids.map((id) => pool[id]).filter(Boolean);
  const sources = items.map((it, k) => `SOURCE ${k + 1} — ${it.outlet}: ${it.title}\n${it.text}`).join('\n\n');
  const brief = p.kind === 'roundup'
    ? `Write a roundup titled around "${p.title}": a 2-sentence intro, then one short section per item (80-130 words each) and a one-line close.`
    : 'Write one news article (400-550 words) telling this story clearly: what happened, who is involved, why it matters, what comes next. Combine the sources; where they differ, say so briefly.';
  const w = await ask(`You write clean English source articles that will be rewritten into simple Japanese for a learner. ${brief}
Rules: plain, concrete English; keep names, numbers and dates; no quotes longer than one sentence; only facts the sources support; ignore navigation text, ads, captions and "read more" boilerplate. Don't define everyday words — the Japanese rewrite handles the learner's level. Start with a title line, then the text. No headings for story pieces.
If the sources don't hold enough real reporting for this (they're teasers, paywall stubs or mostly boilerplate), reply with exactly INSUFFICIENT and nothing else.

${sources}`, 4000);
  pieces[n] = { ...p, items: items.map(({ id, outlet, title, url, text, via }) => ({ id, outlet, title, url, chars: text.length, via })), cost: cost(w.usage), article: w.text, words: w.text.split(/\s+/).length, insufficient: w.text.trim() === 'INSUFFICIENT' };
}));
for (const p of pieces) console.log(`write ${p.kind.padEnd(8)} $${p.cost.toFixed(4)}  ${p.insufficient ? 'INSUFFICIENT' : `${p.words}w`}  ${p.title}`);

const total = (usage.input * PRICE.in + usage.output * PRICE.out) / 1e6;
console.log(`haiku total $${total.toFixed(4)} (${usage.calls} calls, ${usage.fetches} web fetches), ${((Date.now() - t0) / 1000).toFixed(0)}s`);

// 6. A/B fixtures for the Gemini pass, on a real N4 lexicon palette.
if (fixturesDir) {
  mkdirSync(fixturesDir, { recursive: true });
  const base = JSON.parse(readFileSync('scripts/eval-fixtures/eval-010-vaccine-n4-lexicon.json', 'utf8'));
  // process-article buildSourceBlock: up to 4 sources, lead 4,500 chars, others 2,500, 7,000 total.
  const block = (items) => items.slice(0, 4).map((it, k) => `${k + 1}. ${it.title} — ${it.text.slice(0, k === 0 ? 4500 : 2500)}`).join('\n\n').slice(0, 7000);
  pieces.forEach((p, n) => {
    if (p.insufficient) return;
    const items = p.ids.map((id) => pool[id]).filter(Boolean);
    const [title, ...rest] = p.article.split('\n');
    const fx = (suffix, srcTitle, text, note) => ({
      id: `SPIKE-${n + 1}${suffix}`, note,
      source: { title: srcTitle, text, sources: [] },
      profile: { ...base.profile, targetParagraphs: 5 },
      palette: base.palette,
    });
    writeFileSync(`${fixturesDir}/spike-${n + 1}a.json`, JSON.stringify(fx('A', items[0].title, block(items), `Today's pipeline: raw source block (${items.length} source(s)) — ${p.title}`), null, 2));
    writeFileSync(`${fixturesDir}/spike-${n + 1}b.json`, JSON.stringify(fx('B', title.replace(/^[#*\s]+|[*\s]+$/g, ''), rest.join('\n').trim(), `Haiku-edited source — ${p.title}`), null, 2));
  });
  console.log(`fixtures → ${fixturesDir}`);
}

writeFileSync(out, JSON.stringify({ topics: TOPICS, poolSize: pool.length, history: history.length, shortlist, extract: viaCount, plan, pieces, total }, null, 2));
