import { GROQ_CLUSTER as CLUSTER_MODEL } from '../_shared/models.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Sources ───────────────────────────────────────────────────────────────
// RSS is the primary discovery layer: free, unlimited, and multi-outlet, so
// the same story shows up across several feeds and clusters into much richer
// source material than a single NewsAPI query can (see #18 follow-up). NewsAPI
// remains a fallback for the rare case where every feed fails.
//
// Every feed is tagged with a topic id from the curated catalog (#10). The
// client mirrors the id/label catalog in src/data/feedTopics.ts — keep the two
// in sync when adding a topic. `category` stays the human label shown on cards.
const FEED_LIST: { name: string; url: string; category: string; topic: string }[] = [
  { name: 'BBC',        url: 'https://feeds.bbci.co.uk/news/rss.xml',            category: 'World',      topic: 'world' },
  { name: 'NPR',        url: 'https://feeds.npr.org/1001/rss.xml',               category: 'World',      topic: 'world' },
  { name: 'Guardian',   url: 'https://www.theguardian.com/world/rss',            category: 'World',      topic: 'world' },
  { name: 'BBC Tech',   url: 'https://feeds.bbci.co.uk/news/technology/rss.xml', category: 'Technology', topic: 'technology' },
  { name: 'The Verge',  url: 'https://www.theverge.com/rss/index.xml',           category: 'Technology', topic: 'technology' },
  { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index', category: 'Technology', topic: 'technology' },
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/',                     category: 'Technology', topic: 'technology' },
  { name: 'Engadget',   url: 'https://www.engadget.com/rss.xml',                 category: 'Technology', topic: 'technology' },
  { name: 'Wired',      url: 'https://www.wired.com/feed/rss',                   category: 'Technology', topic: 'technology' },
  { name: 'Guardian Tech', url: 'https://www.theguardian.com/technology/rss',    category: 'Technology', topic: 'technology' },
  { name: 'Guardian Sci',  url: 'https://www.theguardian.com/science/rss',       category: 'Science',    topic: 'science' },
  { name: 'BBC Science',   url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', category: 'Science', topic: 'science' },
  { name: 'BBC Business',  url: 'https://feeds.bbci.co.uk/news/business/rss.xml', category: 'Business',  topic: 'business' },
  { name: 'Guardian Business', url: 'https://www.theguardian.com/uk/business/rss', category: 'Business', topic: 'business' },
  { name: 'BBC Sport',     url: 'https://feeds.bbci.co.uk/sport/rss.xml',         category: 'Sports',    topic: 'sports' },
  { name: 'Guardian Sport', url: 'https://www.theguardian.com/us/sport/rss',      category: 'Sports',    topic: 'sports' },
  { name: 'Guardian Culture', url: 'https://www.theguardian.com/us/culture/rss',  category: 'Culture',   topic: 'culture' },
  { name: 'BBC Arts',      url: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml', category: 'Culture', topic: 'culture' },
  { name: 'BBC Health',    url: 'https://feeds.bbci.co.uk/news/health/rss.xml',   category: 'Health',    topic: 'health' },
  { name: 'NPR Health',    url: 'https://feeds.npr.org/1128/rss.xml',             category: 'Health',    topic: 'health' },
  { name: 'Japan Times',   url: 'https://www.japantimes.co.jp/feed/',             category: 'Japan',     topic: 'japan' },
  { name: 'Guardian Japan', url: 'https://www.theguardian.com/world/japan/rss',   category: 'Japan',     topic: 'japan' },
  { name: 'The Verge AI',  url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', category: 'AI', topic: 'ai' },
  { name: 'TechCrunch AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', category: 'AI', topic: 'ai' },
  { name: 'Guardian AI',   url: 'https://www.theguardian.com/technology/artificialintelligenceai/rss', category: 'AI', topic: 'ai' },
  { name: 'Guardian Space', url: 'https://www.theguardian.com/science/space/rss', category: 'Space',     topic: 'space' },
  { name: 'NASA',          url: 'https://www.nasa.gov/news-release/feed/',        category: 'Space',     topic: 'space' },
  { name: 'Polygon',       url: 'https://www.polygon.com/rss/index.xml/',         category: 'Gaming',    topic: 'gaming' },
  { name: 'Guardian Games', url: 'https://www.theguardian.com/games/rss',         category: 'Gaming',    topic: 'gaming' },
  { name: 'Guardian Environment', url: 'https://www.theguardian.com/us/environment/rss', category: 'Climate', topic: 'climate' },
  { name: 'NPR Climate',   url: 'https://feeds.npr.org/1167/rss.xml',             category: 'Climate',   topic: 'climate' },
  { name: 'Guardian Food', url: 'https://www.theguardian.com/food/rss',           category: 'Food',      topic: 'food' },
  { name: 'NPR Food',      url: 'https://feeds.npr.org/1053/rss.xml',             category: 'Food',      topic: 'food' },
  { name: 'Guardian Travel', url: 'https://www.theguardian.com/us/travel/rss',    category: 'Travel',    topic: 'travel' },
  { name: 'NPR Politics',  url: 'https://feeds.npr.org/1014/rss.xml',             category: 'Politics',  topic: 'politics' },
  { name: 'Guardian US Politics', url: 'https://www.theguardian.com/us-news/us-politics/rss', category: 'Politics', topic: 'politics' },
];
// The catalog's valid topic ids, and the set used when a user has never chosen
// (feed_topics NULL / absent) — exactly the pre-#10 hardcoded lineup.
const ALL_TOPICS = [...new Set(FEED_LIST.map((f) => f.topic))];
const DEFAULT_TOPICS = ['world', 'technology', 'science'];
// Pool sizing: ~132 items (the historical 11 feeds × 12) regardless of how many
// feeds the topic selection activates, so the clustering prompt and Groq cost
// stay flat when a user turns on every topic.
const POOL_TARGET = 132;
const MIN_ITEMS_PER_FEED = 6;
const MAX_ITEMS_PER_FEED = 12;
const FEED_TIMEOUT_MS = 8000;
const MAX_CARDS = 40;

// Source-material caps. A full-text feed (e.g. Ars) ships the whole article body
// in content:encoded; keep enough of it that process-article classifies the
// article as `full` (its FULL_SOURCE_CHARS = 1500 bar) instead of truncating to a
// teaser — the old flat 800-char cap landed full-text feeds as `partial` and also
// tripped process-article's Jina skip. A bare `description` is just a teaser, so
// keep it short (Jina backfills the body from the URL). process-article re-caps
// the lead source at LEAD_SOURCE_CHAR_CAP = 4500 (extras at 2500), so matching
// the lead cap here is the ceiling.
const FULLTEXT_BODY_CAP = 4500;  // content:encoded / Atom content — a real body
const TEASER_CAP = 800;          // description-only — Jina fills the rest
// The card preview (shown in the Feed and used only as a fallback snippet) never
// needs the whole body; the full text rides in each card's `sources[].teaser`.
// Keeping the preview small bounds the persisted articlesCache blob (see #54).
const PREVIEW_CHARS = 400;

// Buffer prioritization. source_kind is only known after process-article runs, so
// at card-build time we approximate richness from teaser size — the cheap proxy
// the #49 follow-up calls for. Tiers mirror process-article's classifier (a full
// body ≥1500 chars; a merged-teaser total ≥600) so the buffer prefers cards that
// will land as `full`/`partial` over bare snippets.
const FULL_BODY_CHARS = 1500;
const PARTIAL_TOTAL_CHARS = 600;

// Article IDs MUST be deterministic and stable across fetches. The client tracks
// dismissed/read articles by id; if the same story comes back with a new id on a
// later fetch, the dismiss filter no longer matches and it reappears in the feed.
// We derive the id from the lead story's URL (stable per story) via a small FNV-1a
// hash, falling back to the title when no URL is present.
function stableId(seed: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

const TOP_HEADLINES_URL = 'https://newsapi.org/v2/top-headlines';
const EVERYTHING_URL = 'https://newsapi.org/v2/everything';

// ── Clustering (dedup) ──────────────────────────────────────────────────────
// Clustering is used conservatively, only to DEDUPE same-story coverage across
// outlets (e.g. don't show four NASA Moon-base cards). Content richness comes
// from full-text extraction in process-article, not from merging, so we keep
// merges small and lean on the lead-source guard for any over-merge.
// llama-3.3-70b is used over the smaller scout model, which produced a
// catastrophic 91-item "misc" mega-bucket at real scale.
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
// Keep merges tight — over-merging suppresses unrelated articles and wastes
// extraction calls. The lead article is always primary; extras are corroboration.
const MAX_SOURCES_PER_CLUSTER = 3;

// NewsAPI fallback noise filters (only used when RSS yields nothing).
const QUALITY_SOURCES = [
  'bbc-news', 'the-verge', 'techcrunch', 'ars-technica', 'wired',
  'associated-press', 'bloomberg', 'business-insider', 'cnn',
  'nbc-news', 'engadget', 'the-next-web', 'abc-news', 'cbs-news',
  'the-washington-post', 'time',
].join(',');
const EXCLUDE_DOMAINS = [
  'pypi.org', 'github.com', 'npmjs.com',
  'readthedocs.io', 'readthedocs.org', 'arxiv.org',
].join(',');
const PACKAGE_RELEASE_TITLE = /^[\w.@/-]+\s+\d+\.\d+(?:\.\d+)?(?:[\w.-]+)?$/i;

// A normalized article from any source, before clustering.
interface PoolItem {
  title: string;
  teaser: string;
  url: string;
  date: string;
  source: string;   // outlet name — drives the multi-outlet cluster heuristic
  category: string;
}

// ── RSS/Atom parsing ──────────────────────────────────────────────────────
function stripHtml(s: string): string {
  return (s || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? m[1] : '';
}

function extractLink(block: string): string {
  const rss = block.match(/<link>([\s\S]*?)<\/link>/i);
  if (rss && rss[1].trim()) return stripHtml(rss[1]);
  const alt = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i);
  if (alt) return alt[1];
  const any = block.match(/<link[^>]*href=["']([^"']+)["']/i);
  if (any) return any[1];
  return '';
}

function parseFeed(xml: string, source: string, category: string): PoolItem[] {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi)
    || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi)
    || [];
  const out: PoolItem[] = [];
  for (const b of blocks) {
    const title = stripHtml(extractTag(b, 'title'));
    const desc = stripHtml(extractTag(b, 'description') || extractTag(b, 'summary'));
    // content:encoded (RSS) / content (Atom) is often the full body. When the
    // feed ships one, keep it under the generous full-text cap so it survives to
    // process-article as a real body; otherwise the bare description is a teaser
    // and gets the short cap (Jina backfills it downstream).
    const content = stripHtml(extractTag(b, 'content:encoded') || extractTag(b, 'content'));
    const teaser = content.length > desc.length
      ? content.slice(0, FULLTEXT_BODY_CAP)
      : desc.slice(0, TEASER_CAP);
    const url = extractLink(b);
    const date = stripHtml(extractTag(b, 'pubDate') || extractTag(b, 'published') || extractTag(b, 'updated'));
    out.push({ title, teaser, url, date, source, category });
  }
  return out;
}

function isValidItem(it: PoolItem): boolean {
  if (!it.title || it.title.length < 12) return false;
  if (it.title.includes('[Removed]')) return false;
  if (PACKAGE_RELEASE_TITLE.test(it.title.trim())) return false;
  if (!it.url) return false;
  if ((it.teaser || '').trim().length < 40) return false;
  return true;
}

// Registrable host, used by the multi-outlet heuristic. Feed *names* aren't
// enough — "BBC" and "BBC Tech" are different feeds from the same outlet
// (bbc.com), so they must not count as two outlets.
function domainOf(url: string): string {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return url; }
}

// Sanitize a client/DB-supplied topic selection down to known catalog ids.
// Anything unrecognized is dropped; an empty/absent result falls back to the
// defaults so a stale or corrupt preference can never zero out the feed.
function resolveTopics(raw: unknown): string[] {
  const picked = Array.isArray(raw)
    ? raw.filter((t): t is string => typeof t === 'string' && ALL_TOPICS.includes(t))
    : [];
  return picked.length > 0 ? [...new Set(picked)] : DEFAULT_TOPICS;
}

async function fetchFeeds(topics: string[]): Promise<PoolItem[]> {
  const feeds = FEED_LIST.filter((f) => topics.includes(f.topic));
  // Fewer active feeds → deeper per-feed reads; more feeds → shallower, so the
  // pool (and the clustering prompt built from it) stays near POOL_TARGET.
  const itemsPerFeed = Math.max(MIN_ITEMS_PER_FEED,
    Math.min(MAX_ITEMS_PER_FEED, Math.round(POOL_TARGET / Math.max(1, feeds.length))));
  const results = await Promise.allSettled(feeds.map(async (f) => {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), FEED_TIMEOUT_MS);
    try {
      const res = await fetch(f.url, { headers: { 'User-Agent': 'YugenStudy/1.0' }, signal: ctrl.signal });
      if (!res.ok) {
        console.warn(`[fetch-raw-news] feed ${f.name} HTTP ${res.status}`);
        return [] as PoolItem[];
      }
      const xml = await res.text();
      return parseFeed(xml, f.name, f.category).filter(isValidItem).slice(0, itemsPerFeed);
    } catch (e) {
      console.warn(`[fetch-raw-news] feed ${f.name} failed:`, e instanceof Error ? e.message : e);
      return [] as PoolItem[];
    } finally {
      clearTimeout(to);
    }
  }));

  const pool: PoolItem[] = [];
  const seenTitles = new Set<string>();
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const it of r.value) {
      const key = it.title.toLowerCase().slice(0, 60);
      if (seenTitles.has(key)) continue; // drop cross-feed exact dupes
      seenTitles.add(key);
      pool.push(it);
    }
  }
  console.log(`[fetch-raw-news] RSS pool: ${pool.length} items from ${feeds.length}/${FEED_LIST.length} feeds (topics: ${topics.join(',')})`);
  return pool;
}

// ── NewsAPI fallback ─────────────────────────────────────────────────────
async function fetchNewsApiPool(page: number, newsApiKey: string): Promise<PoolItem[]> {
  const strategies = [
    { category: 'Technology', url: `${TOP_HEADLINES_URL}?country=us&category=technology&pageSize=20&page=${page}&apiKey=${newsApiKey}` },
    { category: 'Business', url: `${TOP_HEADLINES_URL}?country=us&category=business&pageSize=20&page=${page}&apiKey=${newsApiKey}` },
    { category: 'Technology', url: `${EVERYTHING_URL}?sources=${QUALITY_SOURCES}&excludeDomains=${EXCLUDE_DOMAINS}&sortBy=popularity&language=en&pageSize=20&page=${page}&apiKey=${newsApiKey}` },
  ];
  for (const { url, category } of strategies) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'YugenStudy/1.0' } });
      if (!res.ok) continue;
      const data = await res.json();
      const items: PoolItem[] = (data.articles ?? []).map((a: any) => ({
        title: a.title ?? '',
        teaser: (a.description || a.content || '').toString().trim(),
        url: a.url ?? '',
        date: a.publishedAt ?? '',
        source: a.source?.name || (a.url ? new URL(a.url).host : 'NewsAPI'),
        category,
      })).filter(isValidItem);
      if (items.length > 0) {
        console.log(`[fetch-raw-news] NewsAPI fallback picked ${items.length} articles`);
        return items;
      }
    } catch (e) {
      console.error('[fetch-raw-news] NewsAPI fallback error:', e);
    }
  }
  return [];
}

// ── Clustering ──────────────────────────────────────────────────────────────
interface Cluster {
  topic: string;
  indices: number[];
}

// Group same-story coverage across outlets. Multi-item clusters are only kept
// merged if they span 2+ distinct outlets; a single-outlet multi-item group is
// almost always the model lumping one feed's section together (grab-bag), so we
// split those back into singletons. Degrades to one card per item on failure.
async function clusterArticles(pool: PoolItem[], groqKey: string | undefined): Promise<Cluster[]> {
  const singletons = (): Cluster[] => pool.map((p, i) => ({ topic: p.title, indices: [i] }));
  if (!groqKey || pool.length < 2) return singletons();

  const headlineList = pool.map((p, i) => `${i + 1}. [${p.source}] ${p.title}`).join('\n');
  const prompt = `Group these news headlines into topic clusters. Return JSON: {"clusters": [{"topic": "short topic label", "articles": [indices]}]}. Use 1-based indices.

Rules:
- ONLY group articles that cover the SAME specific story or event (e.g. the same product launch, the same court ruling, the same company's earnings).
- A shared THEME is NOT a story. Do NOT group articles merely because they share a broad subject like "AI", "social media", "space", or "climate". Two different AI announcements are two separate stories.
- DO NOT group by broad category. "Technology", "Gaming", "Business" are NOT valid clusters. Never create a leftover "misc" bucket.
- Example: three outlets reporting NASA's new moon base plan = ONE cluster. An article on Musk vs Altman and a separate article on the Pope discussing AI = TWO singletons (both mention AI, but are different stories).
- When in doubt, keep an article as its own singleton. Most clusters will be singletons; that is expected and correct.

Headlines:
${headlineList}`;

  try {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CLUSTER_MODEL,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      }),
    });
    if (!response.ok) {
      console.error(`[fetch-raw-news] clustering failed: ${response.status} ${await response.text()}`);
      return singletons();
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(raw);
    const rawClusters: any[] = Array.isArray(parsed) ? parsed : (parsed.clusters ?? []);
    if (!Array.isArray(rawClusters) || rawClusters.length === 0) return singletons();

    const used = new Set<number>();
    const clusters: Cluster[] = [];
    for (const c of rawClusters) {
      const idxRaw: any[] = Array.isArray(c?.articles) ? c.articles : [];
      const indices = idxRaw
        .map((n) => Number(n) - 1) // model returns 1-based indices
        .filter((n) => Number.isInteger(n) && n >= 0 && n < pool.length && !used.has(n))
        .slice(0, MAX_SOURCES_PER_CLUSTER);
      if (indices.length === 0) continue;
      indices.forEach((n) => used.add(n));

      const distinctOutlets = new Set(indices.map((n) => domainOf(pool[n].url))).size;
      if (indices.length > 1 && distinctOutlets < 2) {
        // Single-outlet grab-bag — trust nothing, emit as singletons.
        indices.forEach((n) => clusters.push({ topic: pool[n].title, indices: [n] }));
        continue;
      }
      const topic = (typeof c?.topic === 'string' && c.topic.trim()) || pool[indices[0]].title;
      clusters.push({ topic: topic.trim(), indices });
    }

    // Any item the model omitted becomes its own singleton so nothing is lost.
    pool.forEach((p, i) => {
      if (!used.has(i)) clusters.push({ topic: p.title, indices: [i] });
    });

    const merged = clusters.filter((c) => c.indices.length > 1).length;
    console.log(`[fetch-raw-news] ${pool.length} items -> ${clusters.length} cards (${merged} multi-outlet)`);
    return clusters.length > 0 ? clusters : singletons();
  } catch (err) {
    console.error('[fetch-raw-news] clustering error:', err);
    return singletons();
  }
}

// ── Buffer re-rank by source richness ────────────────────────────────────────
// Richness tier from a card's sources' teaser sizes: 2 = a full body is present,
// 1 = enough merged teaser to build a partial, 0 = snippet. Mirrors
// process-article's classifySourceFullness on the data we have before extraction.
function richnessTier(card: { sources: { teaser?: string }[] }): number {
  const lens = card.sources.map((s) => (s.teaser || '').length);
  const maxLen = lens.length ? Math.max(...lens) : 0;
  const total = Math.min(7000, lens.reduce((a, b) => a + Math.min(b, 2500), 0));
  if (maxLen >= FULL_BODY_CHARS) return 2;
  if (total >= PARTIAL_TOTAL_CHARS) return 1;
  return 0;
}

// Round-robin cards across outlets (preserving each outlet's internal order) so a
// single full-text outlet (e.g. Ars) can't monopolize the top of the buffer.
function roundRobinByOutlet<T extends { originalUrl: string }>(cards: T[]): T[] {
  const byOutlet = new Map<string, T[]>();
  for (const c of cards) {
    const k = domainOf(c.originalUrl);
    const q = byOutlet.get(k);
    if (q) q.push(c); else byOutlet.set(k, [c]);
  }
  const queues = [...byOutlet.values()];
  const out: T[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const q of queues) {
      const c = q.shift();
      if (c) { out.push(c); progressed = true; }
    }
  }
  return out;
}

// Prefer richer source material into the buffer (full text > partial > snippet),
// keeping topic variety by interleaving outlets within each richness tier.
function rerankByRichness<T extends { sources: { teaser?: string }[]; originalUrl: string }>(cards: T[]): T[] {
  const tiers: Record<number, T[]> = { 2: [], 1: [], 0: [] };
  for (const c of cards) tiers[richnessTier(c)].push(c);
  return [
    ...roundRobinByOutlet(tiers[2]),
    ...roundRobinByOutlet(tiers[1]),
    ...roundRobinByOutlet(tiers[0]),
  ];
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { page = 1, topics: rawTopics } = await req.json().catch(() => ({ page: 1 }));
    const topics = resolveTopics(rawTopics);

    // RSS is multi-outlet and fetched fresh each session; it doesn't paginate
    // like NewsAPI. Serve the full clustered batch on page 1 and signal
    // end-of-feed for later pages rather than re-fetch/re-cluster (which would
    // churn ids and surface duplicates).
    if (page > 1) {
      return new Response(JSON.stringify({ articles: [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const groqKey = Deno.env.get('GROQ_API_KEY');

    let pool = await fetchFeeds(topics);
    if (pool.length === 0) {
      const newsApiKey = Deno.env.get('NEWS_API_KEY');
      if (newsApiKey) {
        console.warn('[fetch-raw-news] RSS empty — falling back to NewsAPI');
        pool = await fetchNewsApiPool(page, newsApiKey);
      }
    }

    if (pool.length === 0) {
      console.error('[fetch-raw-news] No articles from any source.');
      return new Response(JSON.stringify({ articles: [], warning: 'No articles found' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const clusters = await clusterArticles(pool, groqKey);

    const allCards = clusters.map((cluster) => {
      const members = cluster.indices.map((i) => pool[i]);
      const lead = members[0];
      // The card title is the lead article's real headline — concrete and
      // trustworthy even when clustering is imperfect — not a model-generated
      // topic label (which can mislabel a loose merge).
      // Preview only — trim each member so a full-text body doesn't bloat the
      // persisted card. The untrimmed body rides in `sources[].teaser` below and
      // is what process-article actually builds the article from.
      const mergedSnippet = members
        .map((m, n) => `${n + 1}. ${m.title} — ${(m.teaser || m.title).slice(0, PREVIEW_CHARS)}`)
        .join('\n');
      const when = lead.date ? new Date(lead.date) : new Date();

      return {
        id: `${lead.title.substring(0, 15)}-${stableId(lead.url || lead.title)}`,
        title: lead.title,
        originalUrl: lead.url,
        date: (isNaN(when.getTime()) ? new Date() : when).toLocaleDateString(),
        readTime: `${Math.min(2 + members.length, 8)} min read`,
        category: lead.category,
        sourceCount: members.length,
        sources: members.map((m) => ({ title: m.title, url: m.url, teaser: m.teaser })),
        blocks: [
          {
            type: 'paragraph',
            content: [{ text: mergedSnippet }],
          },
        ],
      };
    });

    // Prefer richer sources into the buffer, then cap. ensure-buffer claims these
    // in order, so full-text cards get produced before snippet-only ones.
    const cards = rerankByRichness(allCards).slice(0, MAX_CARDS);
    const tierCounts = allCards.reduce((acc, c) => { acc[richnessTier(c)]++; return acc; }, { 0: 0, 1: 0, 2: 0 } as Record<number, number>);
    console.log(`[fetch-raw-news] ${allCards.length} cards (full=${tierCounts[2]} partial=${tierCounts[1]} snippet=${tierCounts[0]}) -> top ${cards.length} re-ranked by richness`);

    return new Response(JSON.stringify({ articles: cards }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[fetch-raw-news] Error:', err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
