import { WordDetails } from '../components/WordModal';
import { lookupWord, disambiguateWithLLM, jmdictToWordDetails, fetchEntries } from './jmdict';

export interface ArticleBlock {
  type: 'paragraph' | 'yugen-box';
  /** Raw paragraph text (server-stored shape). Tokenized into `content` client-side. */
  text?: string;
  content?: {
    text: string;
    furigana?: string;
    isInteractive?: boolean;
    /** Dictionary/base form, used for lookup and SRS keying (conjugations collapse here). */
    lemma?: string;
    details?: WordDetails;
    jmdict_entry_id?: string;
  }[];
  /** Tokenizer version that produced `content`; gates client re-enrichment. */
  tokenizerVersion?: number;
  keyword?: string;
  reading?: string;
  description?: string;
}

export interface ArticleSource {
  title: string;
  url: string;
  teaser: string;
}

export interface NewsArticle {
  id: string;
  title: string;
  originalUrl: string;
  blocks: ArticleBlock[];
  date: string;
  readTime: string;
  category: string;
  /** Clustered source articles — passed to process-article for full-text extraction. */
  sources?: ArticleSource[];
  sourceCount?: number;
  /** How much real source material reached Gemini (set by process-article).
   *  Drives the "Full text" badge; absent on legacy articles. */
  sourceKind?: 'full' | 'partial' | 'snippet';
  /** Char count of the source block sent to Gemini. */
  sourceChars?: number;
}

import { supabase } from './supabase'

// ── Edge Function helper ──────────────────────────────────────────────────────
/** True when the error looks like an expired/invalid auth token (HTTP 401 / JWT). */
function isAuthError(error: any): boolean {
  const status = error?.status ?? error?.context?.status;
  if (status === 401) return true;
  const msg = String(error?.message || '').toLowerCase();
  return msg.includes('jwt') || msg.includes('token') || msg.includes('unauthorized');
}

async function invokeEdgeFn<T = any>(name: string, body: object, timeoutMs?: number): Promise<T> {
  const run = () => {
    const invocation = supabase.functions.invoke(name, { body });
    return timeoutMs
      ? Promise.race([
          invocation,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${name} edge fn timed out after ${timeoutMs}ms`)), timeoutMs),
          ),
        ])
      : invocation;
  };

  let { data, error } = (await run()) as { data: any; error: any };

  // Self-heal: a long-idle session may carry an expired token. Refresh once and
  // retry so the call recovers instead of failing until a full page reload.
  if (error && isAuthError(error)) {
    await supabase.auth.refreshSession();
    ({ data, error } = (await run()) as { data: any; error: any });
  }

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

/** Mark a processed article consumed server-side — `read` on open, `dismissed`
 *  on swipe — and return whether an actual buffer row transitioned. Only `ready`/
 *  `pending` rows move: a raw feed card has no row, and an already-consumed row
 *  won't re-match, so both update 0 rows and return false. The caller uses that to
 *  fire ensureBuffer EXACTLY once per real consumption (guardrail #6: dismissing a
 *  raw card must never trigger production). */
export async function markArticleConsumed(
  articleId: string,
  userId: string,
  kind: 'read' | 'dismissed',
): Promise<boolean> {
  const now = new Date().toISOString();
  const patch = kind === 'read'
    ? { status: 'read', read_at: now }
    : { status: 'dismissed', dismissed_at: now };
  const { data, error } = await supabase
    .from('processed_news')
    .update(patch)
    .eq('user_id', userId)
    .eq('id', articleId)
    .in('status', ['ready', 'pending'])
    .select('id');
  if (error) {
    console.error(`[api] markArticleConsumed(${kind}) failed:`, error);
    return false;
  }
  if ((data?.length ?? 0) > 0) return true; // a live buffer row moved → caller refills

  // No live buffer row matched: this was a RAW feed card swiped/read before it was
  // ever processed, so the only record of it was in localStorage. Write a tombstone
  // so ensure_buffer_claim's ON CONFLICT never (re)produces this story into the
  // buffer — where it would land `ready` but, being in the client's local seen set,
  // get hidden and wedge the buffer (the issue #31 deadlock). A no-content row is
  // valid (title/content are nullable). This is NOT a buffer move, so it returns
  // false and never triggers production (guardrail #6: only real buffer rows refill).
  const tombstone = kind === 'read'
    ? { id: articleId, user_id: userId, status: 'read', read_at: now }
    : { id: articleId, user_id: userId, status: 'dismissed', dismissed_at: now };
  const { error: tombErr } = await supabase
    .from('processed_news')
    .upsert(tombstone, { onConflict: 'user_id,id', ignoreDuplicates: true });
  if (tombErr) console.warn(`[api] markArticleConsumed(${kind}) tombstone failed:`, tombErr.message);
  return false;
}

/** Ask the server to top up this user's ready-article buffer. Idempotent and
 *  fire-and-forget: no-ops when the buffer is full or the kill switch is off, and
 *  never throws into the UI (the cron and other triggers catch up regardless). */
export async function ensureBuffer(userId: string): Promise<void> {
  try {
    await invokeEdgeFn('ensure-buffer', { userId }, 20000);
  } catch (e) {
    console.warn('[api] ensureBuffer failed (non-fatal):', e instanceof Error ? e.message : e);
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

/** Fetch a single processed article by id — used to recover articles that
 *  finished processing server-side while the app was closed. */
export async function fetchProcessedArticleById(articleId: string, userId: string): Promise<NewsArticle | null> {
  const { data, error } = await supabase
    .from('processed_news')
    .select('content')
    .eq('id', articleId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.error('Error fetching processed article:', error);
    return null;
  }
  return (data?.content as NewsArticle) ?? null;
}

// Hydrate the local cache with the user's RECENT processed articles only.
// Pulling the full history's `content` JSONB on every load (this runs on each
// auth/session change) cold-reads megabytes off disk, spikes Disk IOPS into the
// instance ceiling, and starves concurrent word lookups into statement timeouts.
// Bounding to the most recent N keeps the "show articles that finished server-side
// while the app was closed" behavior — any older article still opens on demand via
// fetchProcessedArticleById() in handleSelectArticle.
const RECENT_CACHE_LIMIT = 30;

export async function fetchCachedArticlesFromSupabase(userId: string): Promise<Record<string, NewsArticle>> {
  // Only `ready` (fresh, unread) articles hydrate the cache. Pulling read/
  // dismissed history would resurface 2-month-old articles as "fresh" cards —
  // exactly the stale-leftover behavior issue #31 eliminates. The ready set is
  // tiny (≤ buffer depth), so this is also far cheaper than the old 30-row pull.
  const { data, error } = await supabase
    .from('processed_news')
    .select('id, content')
    .eq('user_id', userId)
    .eq('status', 'ready')
    .order('created_at', { ascending: false })
    .limit(RECENT_CACHE_LIMIT);

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

/** The user's fresh, unread server-produced buffer — surfaced at the TOP of the
 *  feed on open so a ready article is always there with no spinner, even when it
 *  isn't in today's raw NewsAPI fetch (the original "invisible cached article"
 *  bug). Bounded and tiny (≤ buffer depth), newest first. */
export async function fetchReadyBufferArticles(userId: string, limit = 10): Promise<NewsArticle[]> {
  const { data, error } = await supabase
    .from('processed_news')
    .select('content')
    .eq('user_id', userId)
    .eq('status', 'ready')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('[api] fetchReadyBufferArticles failed:', error);
    return [];
  }
  return (data ?? []).map((r) => r.content as NewsArticle).filter(Boolean);
}

export async function fetchNewsFeed(page: number = 1): Promise<NewsArticle[]> {
  const devMode = import.meta.env.VITE_DEV_MODE === 'true';
  if (!devMode) {
    // getSession reads the cached session (no /auth/v1/user round-trip), so a
    // slow or hanging auth network call can't stall the whole feed load.
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) return [];
  }

  try {
    const { articles } = await invokeEdgeFn<{ articles: NewsArticle[] }>('fetch-raw-news', { page });
    if (!articles || articles.length === 0) {
      console.warn(`[api] News API returned zero results for page ${page}. Check Edge Function logs.`);
      return [];
    }
    console.log(`[api] Received ${articles.length} raw articles for page ${page}`);
    return articles;
  } catch (error) {
    console.error(`[api] Edge Function invocation failed for page ${page}:`, error);
    return [];
  }
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
    const data = await invokeEdgeFn('dictionary-lookup', { word, contextSentence, type: 'definition' }, 8000);
    return data as Partial<WordDetails>;
  } catch (e) {
    console.error('dictionary-lookup Edge Fn failed:', e);
    throw e;
  }
}

/**
 * Batched heteronym reading disambiguation. Sends ambiguous-reading words with
 * their sentence context + candidate readings to the dictionary-lookup edge fn
 * (Groq, server-side key); returns one hiragana reading per item, in order.
 * Returns [] on any failure so the caller keeps the tokenizer's reading.
 */
export async function fetchHeteronymReadings(
  items: { surface: string; sentence: string; candidates: string[] }[],
): Promise<string[]> {
  if (items.length === 0) return [];
  try {
    const { readings } = await invokeEdgeFn<{ readings: string[] }>(
      'dictionary-lookup', { type: 'readings', items }, 12000,
    );
    return Array.isArray(readings) ? readings : [];
  } catch (e) {
    console.warn('Heteronym disambiguation failed (keeping tokenizer readings):', e);
    return [];
  }
}

export async function fetchWordGrammarInsight(word: string, contextSentence: string): Promise<string> {
  try {
    console.log(`🌐 Edge Fn (dictionary-lookup grammar) for "${word}"`);
    const { insight } = await invokeEdgeFn<{ insight: string }>('dictionary-lookup', {
      word, contextSentence, type: 'grammar',
    }, 12000);
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
  sources?: ArticleSource[],
  onProgress?: (status: string) => void
): Promise<ArticleBlock[]> {
  onProgress?.('Processing article on server...');
  const result = await invokeEdgeFn<{ blocks: ArticleBlock[] }>('process-article', {
    userId,
    articleId,
    title,
    snippet,
    sources,
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
  const progress: Record<string, any> = {};
  // PostgREST caps a select at ~1000 rows. A heavy user has more word-progress
  // rows than that, so an unpaginated fetch silently returned only the first
  // 1000 — which capped SRS sync, the JLPT/difficulty backfill, AND the
  // post-wipe rehydration at 1000 words. Page through the full set.
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('user_word_progress')
      .select('*')
      .eq('user_id', userId)
      .range(from, from + PAGE - 1);

    if (error) {
      console.error("Error fetching word progress:", error);
      break;
    }

    (data || []).forEach(row => {
      progress[row.word_id] = {
        mastery: row.mastery_level,
        difficulty: row.difficulty ?? null,
        timesSeen: row.times_seen,
        streak: row.streak,
        lastSeenTs: new Date(row.last_seen_at).getTime(),
        // FSRS scheduling (#67) — null until the word has been scheduled.
        stability: row.stability ?? null,
        fsrsDifficulty: row.fsrs_difficulty ?? null,
        dueAt: row.due_at ? new Date(row.due_at).getTime() : null,
        lastReviewedTs: row.last_reviewed_at ? new Date(row.last_reviewed_at).getTime() : null,
        intervalDays: row.interval_days ?? null,
        reps: row.reps ?? 0,
        lapses: row.lapses ?? 0,
        srsStatus: row.srs_status ?? null,
        // Intake queue (#68) — 'queued' waits; 'active' is on the FSRS schedule.
        intakeStatus: row.intake_status ?? null,
        promotedTs: row.promoted_at ? new Date(row.promoted_at).getTime() : null,
      };
    });

    if (!data || data.length < PAGE) break; // last page
  }
  return progress;
}

/**
 * FSRS scheduling fields (#67), all optional. Included in an upsert only when
 * present, so a caller that just touches difficulty never nulls out a word's
 * existing schedule (PostgREST upsert only updates the columns it's given).
 */
export interface SrsSyncFields {
  stability?: number | null;
  fsrsDifficulty?: number | null;
  dueAt?: number | null;          // ms epoch
  lastReviewedTs?: number | null; // ms epoch
  intervalDays?: number | null;
  reps?: number | null;
  lapses?: number | null;
  srsStatus?: string | null;
}

// Map the SRS sync fields that are actually present onto snake_case columns
// (ms → ISO for the two timestamps). Absent fields are omitted, not nulled.
function srsColumns(p: SrsSyncFields): Record<string, unknown> {
  const cols: Record<string, unknown> = {};
  if (p.stability !== undefined) cols.stability = p.stability;
  if (p.fsrsDifficulty !== undefined) cols.fsrs_difficulty = p.fsrsDifficulty;
  if (p.dueAt !== undefined) cols.due_at = p.dueAt == null ? null : new Date(p.dueAt).toISOString();
  if (p.lastReviewedTs !== undefined) cols.last_reviewed_at = p.lastReviewedTs == null ? null : new Date(p.lastReviewedTs).toISOString();
  if (p.intervalDays !== undefined) cols.interval_days = p.intervalDays;
  if (p.reps !== undefined) cols.reps = p.reps;
  if (p.lapses !== undefined) cols.lapses = p.lapses;
  if (p.srsStatus !== undefined) cols.srs_status = p.srsStatus;
  return cols;
}

export async function upsertWordProgressToSupabase(
  userId: string,
  wordId: string,
  progress: { mastery: string; difficulty?: number | null; timesSeen: number; streak: number; lastSeenTs: number }
    & SrsSyncFields
    // Intake queue (#68). Present-only, like the SRS fields: a caller that just touches
    // difficulty (a normal grade) omits these, so an upsert never nulls a word's
    // intake_status/promoted_at. Set them only when promoting (queued → active).
    & { intakeStatus?: string | null; promotedTs?: number | null }
) {
  const { error } = await supabase
    .from('user_word_progress')
    .upsert({
      user_id: userId,
      word_id: wordId,
      mastery_level: progress.mastery,
      difficulty: progress.difficulty ?? null,
      times_seen: progress.timesSeen,
      streak: progress.streak,
      last_seen_at: new Date(progress.lastSeenTs).toISOString(),
      ...srsColumns(progress),
      ...(progress.intakeStatus !== undefined ? { intake_status: progress.intakeStatus } : {}),
      ...(progress.promotedTs !== undefined
        ? { promoted_at: progress.promotedTs == null ? null : new Date(progress.promotedTs).toISOString() }
        : {}),
    });

  if (error) console.error(`Error syncing progress for ${wordId}:`, error);
}

/**
 * Append a precise FSRS review record (rating + before/after state) to
 * srs_review_log. Distinct from logStudyEventToSupabase (the coarse UX log):
 * this is the scheduler-input audit trail for #67, used later for FSRS tuning.
 */
export async function logSrsReviewToSupabase(
  userId: string,
  wordId: string,
  entry: {
    rating: number;
    source: 'reader_skip' | 'reader_click' | 'flashcard';
    stabilityBefore?: number | null;
    stabilityAfter?: number | null;
    difficultyBefore?: number | null;
    difficultyAfter?: number | null;
    scheduledDays?: number | null;
    elapsedDays?: number | null;
  }
) {
  const { error } = await supabase.from('srs_review_log').insert({
    user_id: userId,
    word_id: wordId,
    rating: entry.rating,
    source: entry.source,
    stability_before: entry.stabilityBefore ?? null,
    stability_after: entry.stabilityAfter ?? null,
    difficulty_before: entry.difficultyBefore ?? null,
    difficulty_after: entry.difficultyAfter ?? null,
    scheduled_days: entry.scheduledDays ?? null,
    elapsed_days: entry.elapsedDays ?? null,
  });

  if (error) console.error(`Error logging SRS review for ${wordId}:`, error);
}

/**
 * Upsert many word-progress rows in a single request. Used by the one-time
 * backfill so repairing hundreds of words is one round-trip, not a write burst.
 */
export async function upsertWordProgressBatch(
  userId: string,
  rows: { wordId: string; mastery: string; difficulty: number | null; timesSeen: number; streak: number; lastSeenTs: number }[]
) {
  if (rows.length === 0) return;
  // last_seen_at is NOT NULL: a bad lastSeenTs (0/NaN/undefined) would make
  // `new Date(ts).toISOString()` throw and abort the ENTIRE batch, so a single
  // legacy row could silently sink every other write. Coerce to a valid instant.
  const payload = rows
    .filter(r => r.wordId)
    .map(r => {
      const ts = Number.isFinite(r.lastSeenTs) && r.lastSeenTs > 0 ? r.lastSeenTs : Date.now();
      return {
        user_id: userId,
        word_id: r.wordId,
        mastery_level: r.mastery,
        difficulty: r.difficulty ?? null,
        times_seen: r.timesSeen ?? 0,
        streak: r.streak ?? 0,
        last_seen_at: new Date(ts).toISOString(),
      };
    });
  if (payload.length === 0) return;

  const { error } = await supabase.from('user_word_progress').upsert(payload);

  if (error) console.error('Error batch-syncing word progress:', error);
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
    reading_intensity?: string;
    target_paragraphs_full?: number;
    target_paragraphs_partial?: number;
    target_paragraphs_snippet?: number;
    new_words_per_day?: number;
  }
) {
  const { error } = await supabase
    .from('user_preferences')
    .upsert({ user_id: userId, ...prefs });
  if (error) console.error('Error upserting preferences:', error);
}

