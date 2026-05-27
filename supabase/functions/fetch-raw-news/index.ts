import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const TOP_HEADLINES_URL = 'https://newsapi.org/v2/top-headlines';
const EVERYTHING_URL = 'https://newsapi.org/v2/everything';

// Topic clustering. Grouping related headlines from a single fetch and merging
// their snippets gives process-article 3-4x more factual material than a lone
// ~200-char snippet, which yields substantially richer articles (see #18).
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const CLUSTER_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';
// Cap merged sources so a single mega-cluster can't blow up the Gemini prompt.
const MAX_SOURCES_PER_CLUSTER = 5;

// Whitelist of real-journalism publisher IDs on NewsAPI. Used as a filter on
// /v2/everything so we don't pull in PyPI release feeds, npm package
// announcements, GitHub readmes, etc. that otherwise dominate the "Technology"
// firehose when sorted by publishedAt.
const QUALITY_SOURCES = [
  'bbc-news', 'the-verge', 'techcrunch', 'ars-technica', 'wired',
  'associated-press', 'bloomberg', 'business-insider', 'cnn',
  'nbc-news', 'engadget', 'the-next-web', 'abc-news', 'cbs-news',
  'the-washington-post', 'time',
].join(',');

// Belt-and-suspenders against the noise sources even if a quality publisher
// syndicates them.
const EXCLUDE_DOMAINS = [
  'pypi.org', 'github.com', 'npmjs.com',
  'readthedocs.io', 'readthedocs.org', 'arxiv.org',
].join(',');

// Detects titles like "axmp-ai-agent-core 1.0.0rc12" or "spanforge 2.0.0" that
// sometimes slip through — package-release entries masquerading as articles.
const PACKAGE_RELEASE_TITLE = /^[\w.@/-]+\s+\d+\.\d+(?:\.\d+)?(?:[\w.-]+)?$/i;

function pickValidArticles(raw: any[]): any[] {
  return (raw ?? []).filter((a: any) => {
    if (!a?.title || typeof a.title !== 'string') return false;
    if (a.title.includes('[Removed]')) return false;
    if (a.title.length < 12) return false;
    if (PACKAGE_RELEASE_TITLE.test(a.title.trim())) return false;
    // process-article requires a non-empty snippet; drop articles with
    // no usable body text so we don't 400 downstream.
    const snippet = (a.description || a.content || '').toString().trim();
    if (snippet.length < 40) return false;
    return true;
  });
}

function snippetText(a: any): string {
  return (a?.description || a?.content || '').toString().trim();
}

interface Cluster {
  topic: string;
  indices: number[];
}

// Group related headlines into topic clusters via Groq so process-article can
// synthesize multiple snippets into one richer article. Always degrades
// gracefully to one cluster per article (today's behavior) on any failure.
async function clusterArticles(articles: any[], groqKey: string | undefined): Promise<Cluster[]> {
  const singletons = (): Cluster[] => articles.map((a, i) => ({ topic: a.title, indices: [i] }));
  if (!groqKey || articles.length < 2) return singletons();

  const headlineList = articles.map((a, i) => `${i + 1}. ${a.title}`).join('\n');
  const prompt = `Group these news headlines into topic clusters. Return JSON: {"clusters": [{"topic": "short topic label", "articles": [indices]}]}. Use 1-based indices. Only cluster articles that are clearly about the same story or closely related. Singletons are fine.\n\n${headlineList}`;

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
        .filter((n) => Number.isInteger(n) && n >= 0 && n < articles.length && !used.has(n))
        .slice(0, MAX_SOURCES_PER_CLUSTER);
      if (indices.length === 0) continue;
      indices.forEach((n) => used.add(n));
      const topic = (typeof c?.topic === 'string' && c.topic.trim()) || articles[indices[0]].title;
      clusters.push({ topic: topic.trim(), indices });
    }

    // Any article the model omitted becomes its own singleton so nothing is lost.
    articles.forEach((a, i) => {
      if (!used.has(i)) clusters.push({ topic: a.title, indices: [i] });
    });

    console.log(`[fetch-raw-news] clustered ${articles.length} articles into ${clusters.length} topics`);
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
    const newsApiKey = Deno.env.get('NEWS_API_KEY');
    if (!newsApiKey) throw new Error('NEWS_API_KEY secret missing');

    // Strategy order (first non-empty wins):
    //   1. /top-headlines — curated category-filtered feed from major publishers
    //   2. /top-headlines — different category for variety
    //   3. /everything   — whitelisted quality sources, sorted by popularity
    //                      (NOT publishedAt — that's what surfaced the junk)
    const strategies: { label: string; url: string; category?: string }[] = [
      {
        label: 'top-headlines:technology',
        category: 'Technology',
        url: `${TOP_HEADLINES_URL}?country=us&category=technology&pageSize=20&page=${page}&apiKey=${newsApiKey}`,
      },
      {
        label: 'top-headlines:business',
        category: 'Business',
        url: `${TOP_HEADLINES_URL}?country=us&category=business&pageSize=20&page=${page}&apiKey=${newsApiKey}`,
      },
      {
        label: 'everything:quality-sources',
        category: 'Technology',
        url: `${EVERYTHING_URL}?sources=${QUALITY_SOURCES}&excludeDomains=${EXCLUDE_DOMAINS}&sortBy=popularity&language=en&pageSize=20&page=${page}&apiKey=${newsApiKey}`,
      },
    ];

    let articles: any[] = [];
    let chosenCategory = 'Recent News';
    for (const { label, url, category } of strategies) {
      try {
        console.log(`[fetch-raw-news] Trying ${label}`);
        const response = await fetch(url, {
          headers: { 'User-Agent': 'YugenStudy/1.0' },
        });
        console.log(`[fetch-raw-news] ${label} → ${response.status}`);

        if (!response.ok) {
          const errText = await response.text();
          console.error(`[fetch-raw-news] ${label} API error: ${errText}`);
          continue;
        }

        const data = await response.json();
        console.log(`[fetch-raw-news] ${label} totalResults=${data.totalResults}`);

        const filtered = pickValidArticles(data.articles);
        if (filtered.length > 0) {
          articles = filtered;
          chosenCategory = category ?? 'Recent News';
          console.log(`[fetch-raw-news] ${label} picked ${articles.length} articles`);
          break;
        }
      } catch (fetchErr) {
        console.error(`[fetch-raw-news] ${label} fetch failed:`, fetchErr);
      }
    }

    if (articles.length === 0) {
      console.error('[fetch-raw-news] All strategies returned 0 articles.');
      return new Response(JSON.stringify({ articles: [], warning: 'No articles found' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const groqKey = Deno.env.get('GROQ_API_KEY');
    const clusters = await clusterArticles(articles, groqKey);

    const rawArticles = clusters.map((cluster) => {
      const sources = cluster.indices.map((i) => articles[i]);
      const lead = sources[0];
      // Numbered "Sources" block: process-article reads this as the snippet and
      // synthesizes the merged material into one coherent Japanese article.
      const mergedSnippet = sources
        .map((a, n) => `${n + 1}. ${a.title} — ${snippetText(a) || a.title}`)
        .join('\n');

      return {
        id: `${cluster.topic.substring(0, 15)}-${Math.random().toString(36).substring(2, 9)}`,
        title: cluster.topic,
        originalUrl: lead.url,
        date: new Date(lead.publishedAt).toLocaleDateString(),
        readTime: `${Math.min(2 + sources.length, 8)} min read`,
        category: chosenCategory,
        sourceCount: sources.length,
        blocks: [
          {
            type: 'paragraph',
            content: [{ text: mergedSnippet }],
          },
        ],
      };
    });

    return new Response(JSON.stringify({ articles: rawArticles }), {
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
