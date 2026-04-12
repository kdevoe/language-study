import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const NEWS_API_URL = 'https://newsapi.org/v2/everything';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { page = 1 } = await req.json().catch(() => ({ page: 1 }));
    const newsApiKey = Deno.env.get('NEWS_API_KEY');
    if (!newsApiKey) throw new Error('NEWS_API_KEY secret missing');

    const topics = [
      'Technology OR AI OR Robotics',
      'Japan News OR Tokyo',
      'Apple OR Google OR Microsoft' // Absolute fallbacks
    ];

    let articles: any[] = [];
    for (const q of topics) {
      try {
        const url = `${NEWS_API_URL}?q=${encodeURIComponent(q)}&sortBy=publishedAt&language=en&pageSize=20&page=${page}&apiKey=${newsApiKey}`;
        console.log(`[fetch-raw-news] Fetching: ${url.replace(newsApiKey, 'REDACTED')}`);
        
        const response = await fetch(url, {
          headers: { 'User-Agent': 'YugenStudy/1.0' } // NewsAPI sometimes likes User-Agents
        });
        
        console.log(`[fetch-raw-news] Response status: ${response.status}`);
        
        if (!response.ok) {
          const errText = await response.text();
          console.error(`[fetch-raw-news] API Error: ${errText}`);
          continue;
        }
        
        const data = await response.json();
        console.log(`[fetch-raw-news] Total results for "${q}": ${data.totalResults}`);
        
        if (data.articles && data.articles.length > 0) {
          const filtered = data.articles.filter(
            (a: any) => a.title && !a.title.includes('[Removed]') && a.title.length > 8
          );
          if (filtered.length > 0) {
            articles = filtered;
            console.log(`[fetch-raw-news] Successfully picked ${articles.length} articles from "${q}"`);
            break;
          }
        }
      } catch (fetchErr) {
        console.error(`[fetch-raw-news] Fetch failed for "${q}":`, fetchErr);
      }
    }

    if (articles.length === 0) {
      console.error('[fetch-raw-news] All queries returned 0 results.');
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
      category: 'Technology',
      blocks: [
        {
          type: 'paragraph',
          content: [{ text: a.description || a.content || a.title }]
        }
      ]
    }));

    return new Response(JSON.stringify({ articles: rawArticles }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[fetch-raw-news] Error:', err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
