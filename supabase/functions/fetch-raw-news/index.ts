const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Sources ───────────────────────────────────────────────────────────────
// RSS is the primary discovery layer: free, unlimited, and multi-outlet, so
// the same story shows up across several feeds and clusters into much richer
// source material than a single NewsAPI query can (see #18 follow-up). NewsAPI
// remains a fallback for the rare case where every feed fails.
const FEED_LIST: { name: string; url: string; category: string }[] = [
  { name: 'BBC',        url: 'https://feeds.bbci.co.uk/news/rss.xml',            category: 'World' },
  { name: 'BBC Tech',   url: 'https://feeds.bbci.co.uk/news/technology/rss.xml', category: 'Technology' },
  { name: 'The Verge',  url: 'https://www.theverge.com/rss/index.xml',           category: 'Technology' },
  { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index', category: 'Technology' },
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/',                     category: 'Technology' },
  { name: 'NPR',        url: 'https://feeds.npr.org/1001/rss.xml',               category: 'World' },
  { name: 'Engadget',   url: 'https://www.engadget.com/rss.xml',                 category: 'Technology' },
  { name: 'Wired',      url: 'https://www.wired.com/feed/rss',                   category: 'Technology' },
  { name: 'Guardian',   url: 'https://www.theguardian.com/world/rss',            category: 'World' },
  { name: 'Guardian Tech', url: 'https://www.theguardian.com/technology/rss',    category: 'Technology' },
  { name: 'Guardian Sci',  url: 'https://www.theguardian.com/science/rss',       category: 'Science' },
];
const ITEMS_PER_FEED = 12;
const FEED_TIMEOUT_MS = 8000;
const MAX_CARDS = 40;

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
const CLUSTER_MODEL = 'llama-3.3-70b-versatile';
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
    // content:encoded (RSS) / content (Atom) is often the full body — keep the
    // longer of the two so feeds that ship full text (e.g. Ars) skip extraction.
    const content = stripHtml(extractTag(b, 'content:encoded') || extractTag(b, 'content'));
    const teaser = (content.length > desc.length ? content : desc).slice(0, 800);
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

async function fetchFeeds(): Promise<PoolItem[]> {
  const results = await Promise.allSettled(FEED_LIST.map(async (f) => {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), FEED_TIMEOUT_MS);
    try {
      const res = await fetch(f.url, { headers: { 'User-Agent': 'YugenStudy/1.0' }, signal: ctrl.signal });
      if (!res.ok) {
        console.warn(`[fetch-raw-news] feed ${f.name} HTTP ${res.status}`);
        return [] as PoolItem[];
      }
      const xml = await res.text();
      return parseFeed(xml, f.name, f.category).filter(isValidItem).slice(0, ITEMS_PER_FEED);
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
  console.log(`[fetch-raw-news] RSS pool: ${pool.length} items from ${FEED_LIST.length} feeds`);
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { page = 1 } = await req.json().catch(() => ({ page: 1 }));

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

    let pool = await fetchFeeds();
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

    const cards = clusters.slice(0, MAX_CARDS).map((cluster) => {
      const members = cluster.indices.map((i) => pool[i]);
      const lead = members[0];
      // The card title is the lead article's real headline — concrete and
      // trustworthy even when clustering is imperfect — not a model-generated
      // topic label (which can mislabel a loose merge).
      const mergedSnippet = members
        .map((m, n) => `${n + 1}. ${m.title} — ${m.teaser || m.title}`)
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
