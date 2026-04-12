import { WordDetails } from '../components/WordModal';
import { lookupWord, disambiguateWithLLM, jmdictToWordDetails, fetchEntries } from './jmdict';

export interface ArticleBlock {
  type: 'paragraph' | 'yugen-box';
  content?: { 
    text: string; 
    furigana?: string; 
    isInteractive?: boolean; 
    details?: WordDetails;
    jmdict_entry_id?: string;
  }[];
  keyword?: string;
  reading?: string;
  description?: string;
}

export interface NewsArticle {
  id: string;
  title: string;
  originalUrl: string;
  blocks: ArticleBlock[];
  date: string;
  readTime: string;
  category: string;
}

import { supabase } from './supabase'

// ── Edge Function helper ──────────────────────────────────────────────────────
async function invokeEdgeFn<T = any>(name: string, body: object): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) throw error;
  return data as T;
}

export async function joinWaitlist(email: string): Promise<{ success: boolean; message?: string }> {
  try {
    const { error } = await supabase.from('waitlist').insert([{ email }]);
    
    if (error) {
      if (error.code === '23505') {
        // Unique violation
        return { success: false, message: "You're already on the waitlist!" };
      }
      throw error;
    }
    
    return { success: true };
  } catch (err: any) {
    console.error("Waitlist error:", err);
    return { success: false, message: err.message || "An error occurred while joining the waitlist." };
  }
}

export async function saveProcessedArticleToSupabase(article: NewsArticle, userId: string) {
  const { error } = await supabase
    .from('processed_news')
    .upsert({
      id: article.id,
      user_id: userId,
      title: article.title,
      content: article, // The whole article object
      metadata: { date: article.date, category: article.category }
    });
  if (error) console.error("Error syncing to Supabase:", error);
}

export async function fetchCachedArticlesFromSupabase(userId: string): Promise<Record<string, NewsArticle>> {
  const { data, error } = await supabase
    .from('processed_news')
    .select('*')
    .eq('user_id', userId);
    
  if (error) {
    console.error("Error fetching cache from Supabase:", error);
    return {};
  }
  
  const cache: Record<string, NewsArticle> = {};
  data?.forEach(row => {
    cache[row.id] = row.content;
  });
  return cache;
}

export async function fetchNewsFeed(pageSize: number = 8, offset: number = 0): Promise<NewsArticle[]> {
  // Fetch pre-processed articles from Supabase (server already ran process-article)
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return mockArticles;

  const { data, error } = await supabase
    .from('processed_news')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + pageSize - 1);

  if (error || !data || data.length === 0) {
    if (offset > 0) return []; // Stop at the end of the real feed
    console.warn('No pre-processed articles found; returning mock data.');
    return mockArticles;
  }

  return data.map((row: any) => row.content as NewsArticle);
}

export async function fetchWordDefinitionQuick(word: string, contextSentence: string, jmdictEntryId?: string): Promise<Partial<WordDetails>> {
  // 1. Try JMDict first (instant, no network needed)
  try {
    let result;

    if (jmdictEntryId) {
      console.log(`📖 JMDict HIT (ID): ${word} [${jmdictEntryId}]`);
      const entries = await fetchEntries([jmdictEntryId]);
      if (entries.length > 0) result = entries[0];
    }

    if (!result) {
      const candidates = await lookupWord(word);

      if (candidates.length === 1) {
        console.log(`📖 JMDict HIT (single): ${word}`);
        result = candidates[0];
      } else if (candidates.length > 1) {
        console.log(`📖 JMDict HIT (${candidates.length} candidates): ${word} → disambiguating via Edge Fn...`);
        result = await disambiguateWithLLM(word, contextSentence, candidates);
      }
    }

    if (result) {
      const details = jmdictToWordDetails(word, result);
      return { word, ...details };
    }
  } catch (e) {
    console.warn('JMDict lookup failed, falling back to Edge Fn:', e);
  }

  // 2. Fallback: server-side Groq via Edge Function
  console.log(`🌐 Edge Fn FALLBACK (dictionary-lookup) for "${word}"`);
  try {
    const data = await invokeEdgeFn('dictionary-lookup', { word, contextSentence, type: 'definition' });
    return data as Partial<WordDetails>;
  } catch (e) {
    console.error('dictionary-lookup Edge Fn failed:', e);
    throw e;
  }
}

export async function fetchWordGrammarInsight(word: string, contextSentence: string): Promise<string> {
  try {
    console.log(`🌐 Edge Fn (dictionary-lookup grammar) for "${word}"`);
    const { insight } = await invokeEdgeFn<{ insight: string }>('dictionary-lookup', {
      word, contextSentence, type: 'grammar',
    });
    return insight || 'Grammar analysis unavailable.';
  } catch (e) {
    console.error('Grammar insight Edge Fn failed:', e);
    return 'Grammar analysis unavailable.';
  }
}

export async function fetchWordDefinition(word: string, contextSentence: string): Promise<WordDetails> {
  try {
    console.log(`🌐 Edge Fn FALLBACK (dictionary-lookup deep) for "${word}"`);
    const data = await invokeEdgeFn('dictionary-lookup', { word, contextSentence, type: 'definition' });
    return data as WordDetails;
  } catch (e) {
    console.error('dictionary-lookup Edge Fn failed:', e);
    return { word, reading: 'Error', meaning: 'Failed to look up word.' };
  }
}

export async function fetchSentenceTranslation(sentence: string, contextArticle: string): Promise<string> {
  try {
    console.log(`🌐 Edge Fn (dictionary-lookup translation)`);
    const { translation } = await invokeEdgeFn<{ translation: string }>('dictionary-lookup', {
      word: sentence, contextSentence: contextArticle.substring(0, 300), type: 'translation',
    });
    return translation || 'Translation unavailable.';
  } catch (e) {
    console.error('Translation Edge Fn failed:', e);
    return 'Translation unavailable.';
  }
}

export async function rewriteArticleWithGemini(
  title: string,
  snippet: string,
  onProgress?: (status: string) => void
): Promise<ArticleBlock[]> {
  // This is now handled server-side. Invoke the Edge Function.
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return mockArticles[0].blocks;

  onProgress?.('Sending to server for processing...');
  try {
    const result = await invokeEdgeFn<{ blocks: ArticleBlock[] }>('process-article', {
      userId: user.id,
      title,
      snippet,
    });
    onProgress?.('Done.');
    return result.blocks;
  } catch (e) {
    console.error('process-article Edge Fn failed:', e);
    return mockArticles[0].blocks;
  }
}

/** Invoke process-article on demand for a specific article the user tapped. */
export async function requestArticleProcessing(
  userId: string,
  articleId: string,
  title: string,
  snippet: string,
  onProgress?: (status: string) => void
): Promise<ArticleBlock[]> {
  onProgress?.('Processing article on server...');
  const result = await invokeEdgeFn<{ blocks: ArticleBlock[] }>('process-article', {
    userId,
    articleId,
    title,
    snippet,
  });
  onProgress?.('Done.');
  return result.blocks;
}


const mockArticles: NewsArticle[] = [
  {
    id: '1',
    title: '「間」の美学：空白が語る日本文化',
    originalUrl: 'https://example.com/ma-aesthetics',
    date: new Date().toISOString(),
    readTime: '12分で読める',
    category: '文化考察',
    blocks: [
      {
        type: 'paragraph',
        content: [
          { text: '日本文化の根底には、形あるものと同じくらい、形なきものが重要視されるという考え方があります。それが「' },
          { text: '間', furigana: 'ま', isInteractive: true, details: { word: '間', reading: 'MA', meaning: 'Space, interval, pause. The negative space or silence that gives shape to the whole.', grammarNote: 'A critical concept in Japanese aesthetics.' } },
          { text: '」です。建築、庭園、音楽、器具、日常の' },
          { text: '言葉', furigana: 'ことば', isInteractive: true, details: { word: '言葉', reading: 'KO-TO-BA', meaning: 'Word, language, or speech. In Japanese aesthetics, the word often carries the weight of "Koto-dama" (the spirit of language).', grammarNote: 'Refers to both individual words and the concept of language in general. Often used to describe the "power of words" (kotodama).' } },
          { text: 'の中に、この静かな空白が息づいています。' },
        ]
      },
      {
        type: 'yugen-box',
        keyword: '幽玄',
        reading: 'Yūgen',
        description: '言葉に尽くせない深遠な趣. かすかな兆しの中に美を感じ取る感性.'
      },
      {
        type: 'paragraph',
        content: [
          { text: '現代のデジタル化された生活の中でも、この「間」の意識は重要性を増しています。情報の洪水から離れ、意識的に空白の時間を作ることで、私たちの心には再び新鮮な風が吹き抜けるようになります。' }
        ]
      }
    ]
  }
];



export async function fetchUserWordProgress(userId: string): Promise<Record<string, any>> {
  const { data, error } = await supabase
    .from('user_word_progress')
    .select('*')
    .eq('user_id', userId);
    
  if (error) {
    console.error("Error fetching word progress:", error);
    return {};
  }
  
  const progress: Record<string, any> = {};
  data?.forEach(row => {
    progress[row.word_id] = {
      mastery: row.mastery_level,
      timesSeen: row.times_seen,
      streak: row.streak,
      lastSeenTs: new Date(row.last_seen_at).getTime()
    };
  });
  return progress;
}

export async function upsertWordProgressToSupabase(
  userId: string, 
  wordId: string, 
  progress: { mastery: string; timesSeen: number; streak: number; lastSeenTs: number }
) {
  const { error } = await supabase
    .from('user_word_progress')
    .upsert({
      user_id: userId,
      word_id: wordId,
      mastery_level: progress.mastery,
      times_seen: progress.timesSeen,
      streak: progress.streak,
      last_seen_at: new Date(progress.lastSeenTs).toISOString()
    });
    
  if (error) console.error(`Error syncing progress for ${wordId}:`, error);
}

export async function logStudyEventToSupabase(
  userId: string, 
  wordId: string, 
  action: 'seen' | 'lookup' | 'mastery_change',
  metadata?: any
) {
  const { error } = await supabase
    .from('study_history')
    .insert({
      user_id: userId,
      word_id: wordId,
      action,
      metadata
    });
    
  if (error) console.error(`Error logging study event for ${wordId}:`, error);
}

export async function fetchUserPreferences(userId: string) {
  const { data, error } = await supabase
    .from('user_preferences')
    .select('*')
    .eq('user_id', userId)
    .single();
    
  if (error && error.code !== 'PGRST116') { // PGRST116 = no rows
    console.error('Error fetching preferences:', error);
    return null;
  }
  return data;
}

export async function upsertUserPreferences(
  userId: string,
  prefs: {
    jlpt_level?: number | null;
    rtk_level?: number | null;
    study_mode?: string;
    vocab_mode?: string;
    furigana_mode?: string;
  }
) {
  const { error } = await supabase
    .from('user_preferences')
    .upsert({ user_id: userId, ...prefs });
  if (error) console.error('Error upserting preferences:', error);
}

