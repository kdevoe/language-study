/**
 * Spike: can Claude's server-side web search + web fetch tools source content for
 * the news, long-form and podcast feeds, and what does it cost?
 *
 *   node --env-file=.env scripts/spike-web-search.mjs <out.json> [only-id]
 *
 * Each case asks the model to search, pick one source and fetch it, then answer with
 * a short JSON line. The page text is read straight from the web_fetch_tool_result
 * block, so the model never re-types the article (output tokens stay small). For
 * the podcast case the model writes a short multi-source brief instead.
 *
 * Cost = input/output tokens at the model's price + $10 per 1,000 searches
 * (web fetch has no per-call charge; fetched text is billed as input tokens).
 */
import { writeFileSync } from 'node:fs';

const [out, only] = process.argv.slice(2);
const KEY = process.env.ANTHROPIC_API_KEY;
if (!out || !KEY) { console.error('usage: node --env-file=.env scripts/spike-web-search.mjs <out.json> [case-id]'); process.exit(1); }

// $/MTok (prompts ≤100k tokens) — platform.claude.com pricing, Oct 2026.
const PRICE = {
  'claude-haiku-5-5': { in: 0.10, out: 0.50 },
  'claude-sonnet-5-5': { in: 2, out: 10 },
};
const SEARCH_COST = 10 / 1000;

const today = new Date().toISOString().slice(0, 10);
const PICK_JSON = 'Reply with ONLY one line of JSON: {"url":"…","title":"…","outlet":"…","published":"YYYY-MM-DD or unknown","why":"one short sentence"}';

const newsPrompt = (topic) => `Today is ${today}. Find ONE news article published in the last 3 days about: ${topic}.
Prefer a reputable outlet with a full, freely readable article (no paywall, not a live blog, not a video page). Search, pick the best candidate, then fetch it to confirm the full text is there; if the fetch is thin or paywalled, try another. ${PICK_JSON}`;

const longPrompt = (topic) => `Find ONE long-form, freely readable English piece (a magazine feature, long essay or in-depth explainer, ideally 2,500+ words) about: ${topic}.
Avoid paywalls, PDFs and listicles. Search, pick the best candidate, then fetch it to confirm the full text is there; if it's thin or paywalled, try another. ${PICK_JSON}`;

const podcastPrompt = (topic) => `Today is ${today}. I'm writing a 10-minute, two-host podcast for an intermediate Japanese learner about: ${topic}.
Search for 2-3 recent, reputable sources and write a source brief in English: 6-8 bullet points of concrete facts (numbers, names, dates), each with its source, then 3 discussion angles. Under 350 words. Fetch a page only if the search snippets aren't enough.`;

// Compiled long-form: the reader describes a topic, the model researches it and writes
// an original feature from several sources (then the normal import → parts → rewrite).
const compilePrompt = (topic) => `Today is ${today}. A reader asked for a long read on: "${topic}".
Research it: run a few searches, fetch the 2-3 most useful pages, then write an ORIGINAL magazine-style feature in plain English, about 2,000-2,500 words, with a title and 4-6 section headings. Synthesise across sources in your own words (no long quotes); use concrete facts, names, dates and numbers, and only claims your sources support. End with a "Sources" list of the URLs you used.`;

// Deeper podcast research: enough material for a 10-minute two-host episode.
const podcastDeepPrompt = (topic) => `Today is ${today}. I'm writing a 10-minute, two-host podcast for an intermediate Japanese learner about: "${topic}".
Research it (a few searches; fetch 1-2 pages if snippets are thin) and write a research pack in English: a 2-sentence hook, 10-12 bullet facts (numbers, names, dates) each tagged with its source, 2 short anecdotes or surprising details, 3 discussion angles, and a Sources list. Under 700 words.`;

const CASES = [
  { id: 'compile-konbini', feed: 'compiled', model: 'claude-haiku-5-5', maxTokens: 16000, prompt: compilePrompt('how Japanese convenience stores became a cultural institution, and where they are heading') },
  { id: 'compile-konbini-sonnet', feed: 'compiled', model: 'claude-sonnet-5-5', maxTokens: 16000, prompt: compilePrompt('how Japanese convenience stores became a cultural institution, and where they are heading') },
  { id: 'compile-fusion', feed: 'compiled', model: 'claude-haiku-5-5', maxTokens: 16000, prompt: compilePrompt('where fusion energy really stands in 2026: the private startups, ITER, and what is hype') },
  { id: 'podcast-deep-akiya', feed: 'podcast', model: 'claude-haiku-5-5', maxTokens: 8000, prompt: podcastDeepPrompt("Japan's empty houses (akiya) and the people moving into them") },
  { id: 'news-japan', feed: 'news', model: 'claude-haiku-5-5', prompt: newsPrompt('Japan (society, culture or economy — not sports)') },
  { id: 'news-ai', feed: 'news', model: 'claude-haiku-5-5', prompt: newsPrompt('artificial intelligence') },
  { id: 'news-science', feed: 'news', model: 'claude-haiku-5-5', prompt: newsPrompt('a science discovery') },
  { id: 'news-food', feed: 'news', model: 'claude-haiku-5-5', prompt: newsPrompt('food or cooking') },
  { id: 'news-space-sonnet', feed: 'news', model: 'claude-sonnet-5-5', prompt: newsPrompt('space exploration') },
  { id: 'news-space-haiku', feed: 'news', model: 'claude-haiku-5-5', prompt: newsPrompt('space exploration') },
  { id: 'long-design', feed: 'long-form', model: 'claude-haiku-5-5', prompt: longPrompt('Japanese and Scandinavian minimalism in home design') },
  { id: 'long-sushi', feed: 'long-form', model: 'claude-haiku-5-5', prompt: longPrompt('the history of sushi') },
  { id: 'long-chips', feed: 'long-form', model: 'claude-haiku-5-5', prompt: longPrompt('custom AI chips and the semiconductor race') },
  { id: 'podcast-moon', feed: 'podcast', model: 'claude-haiku-5-5', prompt: podcastPrompt('the race to build a base on the Moon') },
  { id: 'podcast-trains-sonnet', feed: 'podcast', model: 'claude-sonnet-5-5', prompt: podcastPrompt("Japan's shinkansen and high-speed rail") },
  // Fetch-only fallback: we already have the URL (from RSS) and Jina failed on it.
  // No search fee; the page text is the only real cost.
  ...[
    ['fetch-livescience', 'https://www.livescience.com/space/astronomy/white-dwarf-stars-can-be-purple-pink-and-even-green-surprising-new-study-finds'],
    ['fetch-tomshardware', 'https://www.tomshardware.com/tech-industry/semiconductors/custom-ai-asics-examined-from-broadcom-to-mtia'],
  ].map(([id, url]) => ({
    id, feed: 'fetch-only', model: 'claude-haiku-5-5', fetchOnly: true,
    prompt: `Fetch ${url} and confirm the full article text is there. ${PICK_JSON}`,
  })),
];

const TOOLS = [
  { type: 'web_search_20260318', name: 'web_search', max_uses: 4, allowed_callers: ['direct'] },
  { type: 'web_fetch_20260318', name: 'web_fetch', max_uses: 3, allowed_callers: ['direct'], max_content_tokens: 30000 },
];

async function call(body) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json).slice(0, 400)}`);
  return json;
}

async function run(c) {
  const t0 = Date.now();
  const messages = [{ role: 'user', content: c.prompt }];
  const content = [];
  const usage = { input: 0, output: 0, searches: 0, fetches: 0 };
  const stops = [];
  // pause_turn: resend the assistant content as-is to let the server continue.
  for (let turn = 0; turn < 6; turn++) {
    const r = await call({ model: c.model, max_tokens: c.maxTokens ?? 4096, messages, tools: c.fetchOnly ? TOOLS.filter((t) => t.name === 'web_fetch') : TOOLS });
    content.push(...r.content);
    usage.input += (r.usage.input_tokens ?? 0) + (r.usage.cache_read_input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0);
    usage.output += r.usage.output_tokens ?? 0;
    usage.searches += r.usage.server_tool_use?.web_search_requests ?? 0;
    usage.fetches += r.usage.server_tool_use?.web_fetch_requests ?? 0;
    stops.push(r.stop_reason);
    if (r.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: r.content });
  }
  const p = PRICE[c.model];
  const cost = (usage.input * p.in + usage.output * p.out) / 1e6 + usage.searches * SEARCH_COST;

  const queries = content.filter((b) => b.type === 'server_tool_use' && b.name === 'web_search').map((b) => b.input.query);
  const searchHits = content.filter((b) => b.type === 'web_search_tool_result' && Array.isArray(b.content))
    .flatMap((b) => b.content.map((h) => ({ url: h.url, title: h.title, age: h.page_age })));
  const fetches = content.filter((b) => b.type === 'web_fetch_tool_result').map((b) => {
    const r = b.content;
    if (r.type !== 'web_fetch_result') return { error: r.error_code };
    const text = r.content?.source?.data ?? '';
    return { url: r.url, title: r.content?.title, words: text.split(/\s+/).filter(Boolean).length, text };
  });
  const answer = content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  let pick = null;
  if (c.feed !== 'podcast' && c.feed !== 'compiled') { try { pick = JSON.parse(answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1)); } catch { /* not JSON */ } }
  const picked = pick ? fetches.filter((f) => f.url).find((f) => f.url === pick.url) ?? fetches.filter((f) => f.url).at(-1) : null;
  const blocks = content.map((b) => b.type);
  return { ...c, ms: Date.now() - t0, usage, cost, stops, blocks, queries, searchHits, fetches, answer, pick, picked };
}

const results = [];
for (const c of CASES.filter((x) => !only || x.id === only)) {
  try {
    const r = await run(c);
    results.push(r);
    console.log(`${r.id.padEnd(22)} ${r.model.padEnd(18)} $${r.cost.toFixed(4)}  in ${r.usage.input}  out ${r.usage.output}  searches ${r.usage.searches}  fetches ${r.usage.fetches}  ${(r.ms / 1000).toFixed(0)}s  ${r.picked ? `${r.picked.words}w ${r.picked.url}` : r.feed === 'podcast' || r.feed === 'compiled' ? `${r.answer.split(/\s+/).length}w brief` : 'no pick'}`);
  } catch (e) {
    results.push({ ...c, error: String(e) });
    console.log(`${c.id.padEnd(22)} ERROR ${e}`);
  }
}
writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`wrote ${out}`);
