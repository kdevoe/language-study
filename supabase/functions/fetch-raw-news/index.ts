import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const TOP_HEADLINES_URL = 'https://newsapi.org/v2/top-headlines';
const EVERYTHING_URL = 'https://newsapi.org/v2/everything';

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

    const rawArticles = articles.map((a: any) => ({
      id: `${a.title.substring(0, 15)}-${Math.random().toString(36).substring(2, 9)}`,
      title: a.title,
      originalUrl: a.url,
      date: new Date(a.publishedAt).toLocaleDateString(),
      readTime: '3 min read',
      category: chosenCategory,
      blocks: [
        {
          type: 'paragraph',
          content: [{ text: a.description || a.content || a.title }],
        },
      ],
    }));

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
