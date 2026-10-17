import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { runEditor, type EditorPick } from './editor.ts';
import { resolveCaller } from '../_shared/auth.ts';

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

// ── Two modes ────────────────────────────────────────────────────────────────
// mode 'edit' (ensure-buffer, with a userId): the Haiku news editor (editor.ts)
//   reads the learner's memory and the last 30 days of shown titles, shortlists,
//   fetches full text, then picks and orders ~6 stories. Each card arrives with
//   the full text in sources[].teaser plus topic / summary / reason. A run is
//   cached in news_editor_runs and reused until its picks are used up.
// default (the client's raw Feed): no LLM — the pool, same-story headlines
//   grouped by word overlap, topic-interleaved. (Replaces the Groq clustering.)
const EDITOR_CACHE_HOURS = 6;
// Same-story grouping: different outlets, headline word overlap at least this.
const SAME_STORY_OVERLAP = 0.5;
const MAX_SOURCES_PER_STORY = 3;

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
  source: string;   // outlet name — drives the multi-outlet grouping heuristic
  category: string;
  topic: string;    // catalog topic id (src/data/feedTopics.ts)
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

function parseFeed(xml: string, source: string, category: string, topic: string): PoolItem[] {
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
    out.push({ title, teaser, url, date, source, category, topic });
  }
  return out;
}

// Otherwise-English feeds occasionally carry non-English items — NASA publishes
// Spanish-language releases in its main feed — and the pipeline rewrites
// ENGLISH sources, so one slips through as a raw foreign headline in the Feed.
// Cheap stopword screen on the title: ≥3 distinct hits among high-frequency
// Spanish function words (or 2 + accented chars) is far beyond what English
// headlines with Spanish proper nouns produce ("Los Angeles" or "El Paso" hit 1).
const SPANISH_STOPWORDS = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'al', 'un', 'una', 'en',
  'por', 'para', 'con', 'como', 'su', 'más', 'año', 'nuevo', 'nueva', 'y',
]);
function looksNonEnglish(title: string): boolean {
  const hits = new Set(
    title.toLowerCase().split(/[^a-záéíóúüñ]+/).filter((t) => SPANISH_STOPWORDS.has(t)),
  );
  if (/[áéíóúñ¿¡]/.test(title)) hits.add(' accents');
  return hits.size >= 3;
}

function isValidItem(it: PoolItem): boolean {
  if (!it.title || it.title.length < 12) return false;
  if (it.title.includes('[Removed]')) return false;
  if (PACKAGE_RELEASE_TITLE.test(it.title.trim())) return false;
  if (looksNonEnglish(it.title)) return false;
  if (!it.url) return false;
  if ((it.teaser || '').trim().length < 40) return false;
  return true;
}

// Registrable domain, used by the multi-outlet heuristic and the outlet
// round-robin. Feed *names* aren't enough — "BBC" and "BBC Tech" are different
// feeds from the same outlet (bbc.com) — and neither is the bare host:
// www.nasa.gov and science.nasa.gov are ONE outlet, so subdomains must
// collapse. Keep 3 labels for two-part TLDs (co.uk, co.jp, com.au…), else 2.
function domainOf(url: string): string {
  try {
    const parts = new URL(url).host.replace(/^www\./, '').split('.');
    const n = parts.length >= 3
      && parts[parts.length - 2].length <= 3
      && parts[parts.length - 1].length === 2 ? 3 : 2;
    return parts.slice(-n).join('.');
  } catch { return url; }
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
      return parseFeed(xml, f.name, f.category, f.topic).filter(isValidItem).slice(0, itemsPerFeed);
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
        topic: category.toLowerCase(),
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

// ── Same-story grouping (client raw Feed) ───────────────────────────────────
// Dedupe same-story coverage across outlets without an LLM: two headlines from
// DIFFERENT outlets whose content words overlap ≥ SAME_STORY_OVERLAP (of the
// shorter headline) are one story. Conservative by design — a missed merge is a
// duplicate card, an over-merge hides a story. The buffer path doesn't use this;
// the Haiku editor groups coverage itself.
interface Cluster {
  topic: string;
  indices: number[];
}

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'was', 'with', 'as', 'at', 'by', 'from', 'after', 'over', 'its', 'it', 'be', 'has', 'have', 'new', 'says', 'say', 'how', 'why', 'what']);
const headlineWords = (t: string) => new Set(
  t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)),
);

function groupSameStory(pool: PoolItem[]): Cluster[] {
  const words = pool.map((p) => headlineWords(p.title));
  const used = new Set<number>();
  const clusters: Cluster[] = [];
  for (let i = 0; i < pool.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const indices = [i];
    const outlets = new Set([domainOf(pool[i].url)]);
    for (let j = i + 1; j < pool.length && indices.length < MAX_SOURCES_PER_STORY; j++) {
      if (used.has(j) || outlets.has(domainOf(pool[j].url))) continue;
      const a = words[i], b = words[j];
      const shared = [...a].filter((w) => b.has(w)).length;
      if (shared >= 2 && shared / Math.max(1, Math.min(a.size, b.size)) >= SAME_STORY_OVERLAP) {
        used.add(j);
        indices.push(j);
        outlets.add(domainOf(pool[j].url));
      }
    }
    clusters.push({ topic: pool[i].title, indices });
  }
  const merged = clusters.filter((c) => c.indices.length > 1).length;
  console.log(`[fetch-raw-news] ${pool.length} items -> ${clusters.length} cards (${merged} multi-outlet)`);
  return clusters;
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

// Round-robin across TOPICS first, so no topic can monopolize the top of the
// buffer. The old global richness-first ordering did exactly that once #10
// added topics whose feeds ship full bodies (NASA): every tier-2 card was one
// topic, and ensure-buffer claims in list order — three Space articles in a
// row. Richness still orders WITHIN each topic queue (full > partial >
// snippet, outlet-interleaved per tier), but since process-article now
// Jina-extracts any thin source, that's a cost optimization (buffer picks
// need fewer extraction calls), not a quality gate — it no longer deserves
// to outrank topic variety.
function rerankCards<T extends { sources: { teaser?: string }[]; originalUrl: string; category: string }>(cards: T[]): T[] {
  const byTopic = new Map<string, T[]>();
  for (const c of cards) {
    const q = byTopic.get(c.category);
    if (q) q.push(c); else byTopic.set(c.category, [c]);
  }
  const queues = [...byTopic.values()].map((group) => {
    const tiers: Record<number, T[]> = { 2: [], 1: [], 0: [] };
    for (const c of group) tiers[richnessTier(c)].push(c);
    return [
      ...roundRobinByOutlet(tiers[2]),
      ...roundRobinByOutlet(tiers[1]),
      ...roundRobinByOutlet(tiers[0]),
    ];
  });
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

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
});

/** A card from a group of pool items (lead first) — the shape the Feed and ensure-buffer read. */
function buildCard(members: PoolItem[], extra: Record<string, unknown> = {}) {
  const lead = members[0];
  // Preview only — trim each member so a full-text body doesn't bloat the
  // persisted card. The untrimmed body rides in `sources[].teaser` and is what
  // process-article builds the article from.
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
    topic: lead.topic,
    sourceCount: members.length,
    sources: members.map((m) => ({ title: m.title, url: m.url, teaser: m.teaser })),
    blocks: [{ type: 'paragraph', content: [{ text: mergedSnippet }] }],
    ...extra,
  };
}

type Card = ReturnType<typeof buildCard>;

/** Editor mode: reuse a recent run while it still has unclaimed picks, else run the editor. */
async function editorCards(userId: string, topics: string[]): Promise<{ cards: Card[]; cached: boolean } | null> {
  if (!Deno.env.get('ANTHROPIC_API_KEY')) return null;
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const since = new Date(Date.now() - EDITOR_CACHE_HOURS * 3600_000).toISOString();
  const { data: run } = await admin.from('news_editor_runs').select('cards')
    .eq('user_id', userId).gt('created_at', since)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (run?.cards?.length) {
    const ids = (run.cards as Card[]).map((c) => c.id);
    const { data: taken } = await admin.from('processed_news').select('id').eq('user_id', userId).in('id', ids);
    const takenIds = new Set((taken ?? []).map((r: { id: string }) => r.id));
    const left = (run.cards as Card[]).filter((c) => !takenIds.has(c.id));
    if (left.length > 0) return { cards: left, cached: true };
  }

  const pool = await fetchFeeds(topics);
  if (pool.length === 0) return null;
  const { picks, usage } = await runEditor({ admin, userId, pool, topics, jinaKey: Deno.env.get('JINA_API_KEY') });
  const cards = picks.map((p: EditorPick) => buildCard(p.items as PoolItem[], {
    topic: p.topic,
    summary: p.summary,
    reason: p.reason,
    category: FEED_LIST.find((f) => f.topic === p.topic)?.category ?? p.items[0].category,
  }));
  if (cards.length) await admin.from('news_editor_runs').insert({ user_id: userId, cards, usage });
  return { cards, cached: false };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Signed-in users or the service role (_shared/auth.ts): the feed spends
    // NewsAPI quota and, in editor mode, Claude tokens.
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const caller = await resolveCaller(req, createClient(Deno.env.get('SUPABASE_URL')!, serviceKey), serviceKey);
    if (!caller) return json({ error: 'sign in required', errorKind: 'unauthorized' }, 401);

    const { page = 1, topics: rawTopics, userId, mode } = await req.json().catch(() => ({ page: 1 }));
    const topics = resolveTopics(rawTopics);

    // RSS is multi-outlet and fetched fresh each session; it doesn't paginate
    // like NewsAPI. Serve the full batch on page 1 and signal end-of-feed for
    // later pages rather than re-fetch (which would churn ids and surface
    // duplicates).
    if (page > 1) return json({ articles: [] });

    // Editor mode is server-to-server only (ensure-buffer sends the service key):
    // it spends Claude tokens and reads the learner's memory.
    if (mode === 'edit' && typeof userId === 'string' && caller.kind === 'service') {
      try {
        const edited = await editorCards(userId, topics);
        if (edited && edited.cards.length > 0) {
          console.log(`[fetch-raw-news] editor: ${edited.cards.length} cards${edited.cached ? ' (cached run)' : ''}`);
          return json({ articles: edited.cards, editor: true, cached: edited.cached });
        }
        console.warn('[fetch-raw-news] editor returned nothing — falling back to the raw pool');
      } catch (e) {
        console.error('[fetch-raw-news] editor failed — falling back to the raw pool:', e);
      }
    }

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
      return json({ articles: [], warning: 'No articles found' });
    }

    const allCards = groupSameStory(pool).map((c) => buildCard(c.indices.map((i) => pool[i])));

    // Interleave topics (richest first within each), then cap. ensure-buffer
    // claims these in order, so the buffer inherits the topic mix.
    const cards = rerankCards(allCards).slice(0, MAX_CARDS);
    const tierCounts = allCards.reduce((acc, c) => { acc[richnessTier(c)]++; return acc; }, { 0: 0, 1: 0, 2: 0 } as Record<number, number>);
    console.log(`[fetch-raw-news] ${allCards.length} cards (full=${tierCounts[2]} partial=${tierCounts[1]} snippet=${tierCounts[0]}) -> top ${cards.length}, topic-interleaved`);

    return json({ articles: cards });
  } catch (err) {
    console.error('[fetch-raw-news] Error:', err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
