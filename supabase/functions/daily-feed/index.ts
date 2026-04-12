import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const NEWS_API_URL = 'https://newsapi.org/v2/everything';
const FEED_TOPICS = ['Japan News', 'Technology News', 'Science News', 'World News'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const newsApiKey = Deno.env.get('NEWS_API_KEY')!;

    const supabase = createClient(supabaseUrl, supabaseKey);

    // 1. Fetch all active users (approved users who have preferences set)
    const { data: users, error: usersError } = await supabase
      .from('user_preferences')
      .select('user_id');

    if (usersError) throw usersError;
    if (!users || users.length === 0) {
      console.log('[daily-feed] No users to process.');
      return new Response(JSON.stringify({ message: 'No users found.' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[daily-feed] Processing ${users.length} users.`);

    // 2. Fetch news headlines (one batch shared across all users)
    const allHeadlines: { id: string; title: string; snippet: string; url: string }[] = [];
    for (const topic of FEED_TOPICS.slice(0, 2)) { // Limit API calls
      try {
        const response = await fetch(
          `${NEWS_API_URL}?q=${encodeURIComponent(topic)}&sortBy=publishedAt&language=en&pageSize=5&apiKey=${newsApiKey}`
        );
        if (!response.ok) continue;
        const data = await response.json();
        const articles = (data.articles || []).filter(
          (a: any) => a.title && !a.title.includes('[Removed]') && a.title.length > 10
        );
        allHeadlines.push(
          ...articles.slice(0, 3).map((a: any) => ({
            id: `${a.title.substring(0, 15)}-${a.url}`,
            title: a.title,
            snippet: a.description || a.content || a.title,
            url: a.url,
          }))
        );
      } catch (e) {
        console.warn(`[daily-feed] NewsAPI fetch failed for "${topic}":`, e);
      }
    }

    if (allHeadlines.length === 0) {
      console.warn('[daily-feed] No headlines retrieved.');
      return new Response(JSON.stringify({ message: 'No headlines found.' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 3. For each user, trigger process-article for 2 headlines they haven't seen yet
    const processArticleFnUrl = `${supabaseUrl}/functions/v1/process-article`;
    const results: { userId: string; processed: number; errors: number }[] = [];

    for (const { user_id } of users) {
      // Check which articles are already processed for this user
      const { data: existingArticles } = await supabase
        .from('processed_news')
        .select('id')
        .eq('user_id', user_id);
      const existingIds = new Set((existingArticles || []).map((r: any) => r.id));

      const toProcess = allHeadlines.filter(h => !existingIds.has(h.id)).slice(0, 2);
      let processed = 0;
      let errors = 0;

      for (const headline of toProcess) {
        try {
          const resp = await fetch(processArticleFnUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${supabaseKey}`,
            },
            body: JSON.stringify({
              userId: user_id,
              articleId: headline.id,
              title: headline.title,
              snippet: headline.snippet,
            }),
          });
          if (resp.ok) {
            processed++;
          } else {
            console.error(`[daily-feed] process-article failed for user ${user_id}:`, await resp.text());
            errors++;
          }
        } catch (e) {
          console.error(`[daily-feed] Exception for user ${user_id}:`, e);
          errors++;
        }
      }
      results.push({ userId: user_id, processed, errors });
    }

    console.log('[daily-feed] ✅ Done.', results);
    return new Response(JSON.stringify({ success: true, results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('[daily-feed] Error:', err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
