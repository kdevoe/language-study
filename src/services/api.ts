import { WordDetails } from '../components/WordModal';
import { lookupWord, disambiguateWithLLM, jmdictToWordDetails, fetchEntries } from './jmdict';
import { GoogleGenerativeAI } from '@google/generative-ai';

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

// GROQ CONFIG
const GROQ_MODEL_QUICK = "openai/gpt-oss-20b";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

async function fetchGroq(prompt: string, model: string, jsonMode: boolean = false): Promise<string> {
  const apiKey = import.meta.env.VITE_GROQ_API_KEY;
  if (!apiKey) throw new Error("Groq API Key missing.");

  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      response_format: jsonMode ? { type: "json_object" } : undefined
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(`Groq API Error: ${err.error?.message || response.statusText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

import { supabase } from './supabase'

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

export async function fetchNewsFeed(topic: string = 'Japan News', pageSize: number = 8, page: number = 1): Promise<NewsArticle[]> {
  const apiKey = import.meta.env.VITE_NEWS_API_KEY;
  const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  
  if (!apiKey && isLocalhost) {
    console.warn("⚠️ NewsAPI key not found in .env. Falling back to mock data.");
    await new Promise(resolve => setTimeout(resolve, 800));
    return mockArticles;
  }

  try {
    const query = encodeURIComponent(topic);
    
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    const url = isLocalhost 
      ? `https://newsapi.org/v2/everything?q=${query}&sortBy=publishedAt&language=en&pageSize=${pageSize}&page=${page}&apiKey=${apiKey}`
      : `/api/news?topic=${query}`;
    
    const response = await fetch(url);
    if (!response.ok) throw new Error(`NewsAPI failed: ${response.statusText}`);
    
    const data = await response.json();
    
    if (!data.articles || data.articles.length === 0) {
      console.warn("No results found from NewsAPI, returning mock data.");
      return mockArticles;
    }

    const articles: NewsArticle[] = data.articles.map((item: any) => ({
      // Robust unique ID combining URL and part of Title
      id: `${item.title.substring(0, 15)}-${item.url}`, 
      title: item.title,
      originalUrl: item.url,
      date: item.publishedAt || new Date().toISOString(), 
      readTime: 'TBD',
      category: 'Recent News',
      blocks: [
        {
          type: 'paragraph',
          content: [{ text: item.description || item.content || item.title }]
        }
      ]
    }));

    return articles;
  } catch (error) {
    console.error("Error fetching news:", error);
    return mockArticles;
  }
}

export async function fetchWordDefinitionQuick(word: string, contextSentence: string, jmdictEntryId?: string): Promise<Partial<WordDetails>> {
  // 1. Try JMDict first (instant, no LLM needed for single matches)
  try {
    let result;

    if (jmdictEntryId) {
      // Direct hit via pre-resolved ID (Phase 2 optimization)
      console.log(`📖 JMDict HIT (ID): ${word} [${jmdictEntryId}]`);
      const entries = await fetchEntries([jmdictEntryId]);
      if (entries.length > 0) result = entries[0];
    }

    if (!result) {
      const candidates = await lookupWord(word);

      if (candidates.length === 1) {
        // Unambiguous match — return JMDict data directly
        console.log(`📖 JMDict HIT (single): ${word}`);
        result = candidates[0];
      } else if (candidates.length > 1) {
        // Ambiguous — use LLM to pick the correct entry
        console.log(`📖 JMDict HIT (${candidates.length} candidates): ${word} → disambiguating...`);
        result = await disambiguateWithLLM(word, contextSentence, candidates);
      }
    }

    if (result) {
      const details = jmdictToWordDetails(word, result);
      return { word, ...details };
    }
  } catch (e) {
    console.warn('JMDict lookup failed, falling back to LLM:', e);
  }

  // 2. Fallback: pure LLM definition (for words not in JMDict)
  const groqKey = import.meta.env.VITE_GROQ_API_KEY;
  if (!groqKey) throw new Error("Groq key missing for quick lookup.");

  const prompt = `Define "${word}" for context: "${contextSentence}".
  CRITICAL: The "furiganaMap" MUST account for EVERY character in "${word}". 
  Break it down 1:1. Example for "行きます": [{"kanji":"行","kana":"い"},{"kanji":"き","kana":"き"},{"kanji":"ま","kana":"ま"},{"kanji":"す","kana":"す"}]
  Output JSON:
  {
    "word": "${word}",
    "reading": "full reading",
    "meaning": "English translation",
    "furiganaMap": [ { "kanji": "...", "kana": "..." }, ... ]
  }`;

  try {
    console.log(`🧠 LLM FALLBACK (Groq) -> ${GROQ_MODEL_QUICK} (no JMDict match for "${word}")`);
    const text = await fetchGroq(prompt, GROQ_MODEL_QUICK, true);
    return JSON.parse(text);
  } catch (e) {
    console.error("Groq Quick Lookup failed:", e);
    throw e;
  }
}

export async function fetchWordGrammarInsight(word: string, contextSentence: string): Promise<string> {
  const geminiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!geminiKey) return "Set Gemini API key for deep insights.";

  const prompt = `Analyze the word "${word}" in this sentence: "${contextSentence}".
  MANDATORY: Provide ONLY 1 SINGLE brief sentence in English explaining its specific usage or grammar in this context.
  Be extremely concise.`;

  try {
    console.log(`🧠 LLM DEEP (Gemini) -> gemini-3-flash-preview`);
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (e) {
    console.error("Gemini Deep Lookup failed:", e);
    return "Grammar analysis unavailable.";
  }
}

export async function fetchWordDefinition(word: string, contextSentence: string): Promise<WordDetails> {
  const geminiKey = import.meta.env.VITE_GEMINI_API_KEY;
  const prompt = `You are a high-fidelity Japanese dictionary. Define the exact word "${word}" based on this context: "${contextSentence}".
  Output EXACTLY JSON:
  {
    "word": "${word}",
    "reading": "the full reading",
    "meaning": "Concise English translation",
    "grammarNote": "Brief usage/grammar note",
    "furiganaMap": [ { "kanji": "...", "kana": "..." }, ... ]
  }`;

  if (!geminiKey) return { word, reading: 'Unknown', meaning: 'API Key missing.' };

  try {
    console.log(`🧠 LLM FALLBACK: Gemini -> gemini-3-flash-preview`);
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ 
      model: "gemini-3-flash-preview", 
      generationConfig: { responseMimeType: "application/json" } 
    });

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    return JSON.parse(text) as WordDetails;
  } catch (error) {
    console.error("Dictionary API Error:", error);
    return { word, reading: 'Error', meaning: 'Failed to look up word.' };
  }
}

export async function fetchSentenceTranslation(sentence: string, contextArticle: string): Promise<string> {
  const groqKey = import.meta.env.VITE_GROQ_API_KEY;
  const geminiKey = import.meta.env.VITE_GEMINI_API_KEY;

  const prompt = `Translate this Japanese sentence into natural, elegant English: "${sentence}"
  Context of the article: "${contextArticle.substring(0, 500)}..."
  Just provide the English translation, no other text.`;

  // PRIMARY: Groq for instantaneous translation
  if (groqKey) {
    try {
      console.log(`🧠 LLM CALL: Groq -> ${GROQ_MODEL_QUICK} (fetchSentenceTranslation)`);
      return await fetchGroq(prompt, GROQ_MODEL_QUICK);
    } catch (e) {
      console.warn("Groq failed, falling back to Gemini:", e);
    }
  }

  // SECONDARY/FALLBACK: Gemini 3 Flash
  if (!geminiKey) return "API Key missing.";

  try {
    console.log(`🧠 LLM CALL: Gemini -> gemini-3-flash-preview (fetchSentenceTranslation)`);
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (error) {
    console.error("Translation Error:", error);
    return "Failed to translate sentence.";
  }
}

import { rtkKanjiList } from '../data/rtkKanji';

export async function rewriteArticleWithGemini(
  title: string, 
  snippet: string, 
  jlpt: number | null, 
  rtk: number | null, 
  studyMode: 'natural' | 'balanced' | 'study' = 'balanced',
  vocabMode: 'natural' | 'balanced' | 'study' = 'balanced',
  vocabTargets: string[] = [],
  onProgress?: (status: string) => void
): Promise<ArticleBlock[]> {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("⚠️ Gemini API key not found in .env. Returning mock blocks.");
    await new Promise(resolve => setTimeout(resolve, 1500));
    return mockArticles[0].blocks;
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ 
      model: "gemini-3-flash-preview", 
      generationConfig: { responseMimeType: "application/json" } 
    });

    const jlptStr = jlpt ? `N${jlpt}` : 'N4';
    
    const safeRtk = rtk || 122;
    const knownKanji = rtkKanjiList.slice(0, Math.max(0, safeRtk - 15));
    const recentKanji = rtkKanjiList.slice(Math.max(0, safeRtk - 15), safeRtk);
    
    let biasInstruction = `NATURAL KANJI READING: Prioritize fluid, authentic, natural Japanese over restricting yourself to studied Kanji. The text should read exactly like a standard native news article without arbitrarily forcing known Kanji.`;
    if (studyMode === 'study') {
      biasInstruction = `EXTREME STUDIED KANJI BIAS: You MUST drastically alter the summary's phrasing and wording specifically to maximize the usage of the "Student known Kanji" list. CRITICAL TARGETS are your highest priority. It is actively encouraged to sacrifice perfectly natural/authentic journalistic prose if it means you can replace an unknown compound word with a synonym that utilizes the student's known Kanji. Do whatever it takes to aggressively incorporate the student's Kanji into the text.`;
    } else if (studyMode === 'balanced') {
      biasInstruction = `BALANCED KANJI BIAS: Write naturally, but whenever there are multiple valid word choices to express an idea, deliberately choose the synonym that utilizes Kanji from the "Student known Kanji" list (especially CRITICAL TARGETS) rather than an unknown Kanji. Allow minor deviations from strict journalistic style to accommodate these known characters.`;
    }

    let vocabInstruction = `NATURAL VOCABULARY READING: Ignore the "Student Target Vocabulary". Just use the most fitting authentic Japanese syntax for a standard news article.`;
    if (vocabMode === 'study') {
      vocabInstruction = `EXTREME STUDIED VOCABULARY BIAS: You MUST weave as many precise words from the "Student Target Vocabulary" list into your article as logically possible. Restructure sentences, add tangential observations, or substitute common wording entirely if it allows you to hit these target vocabulary words. This takes priority over fluid journalism.`;
    } else if (vocabMode === 'balanced') {
      vocabInstruction = `BALANCED VOCABULARY BIAS: Write naturally, but keep the "Student Target Vocabulary" list in mind. If a target vocabulary word is an adjacent synonym to what you were originally going to write, prefer the target vocabulary word to give the student review exposure.`;
    }
    
    const prompt1 = `
You are a Japanese teacher. Imagine you are writing a 3-paragraph news article in Japanese for a learner.
Language Level: JLPT ${jlptStr}. 
Student known Kanji: [${knownKanji.join('')}].
CRITICAL TARGETS: Prioritize using these Kanji: [${recentKanji.join('')}].
Student Target Vocabulary: [${vocabTargets.join(', ')}].

Rules:
1. Tone must be like a Japanese news broadcast.
2. Pick 1 or 2 important vocabulary words and explain them in English as a "yugen-box".
3. Provide the full Japanese text strings. DO NOT tokenize the text yet.
4. KANJI PREFERENCE: ${biasInstruction}
5. VOCABULARY PREFERENCE: ${vocabInstruction}
   While you should keep "CRITICAL TARGETS" and "Target Vocabulary" in mind as excellent candidate words, do not force them into sentences un-naturally unless explicitly told to in the preference rules.
6. NO MARKUP: DO NOT use brackets [ ], parentheses ( ), or ANY other special characters/formatting around any Japanese words even if they were in your list. 

Output EXACTLY a JSON array matching this interface:
[
  {
    "type": "paragraph" | "yugen-box",
    "text": "The full Japanese sentence string...",
    "keyword": "...",
    "reading": "...",
    "description": "..."
  }
]
News Headline: ${title}
News Snippet: ${snippet}
`;

    const result1 = await model.generateContent(prompt1);
    console.log(`🧠 LLM CALL: Gemini -> gemini-3-flash-preview (rewriteArticle Pass 1)`);
    let rawText1 = result1.response.text().replace(/^```(json)?[\s\n]*/i, '').replace(/[\s\n]*```$/i, '').trim();
    const rawBlocks = JSON.parse(rawText1);

    const prompt2 = `
You are a morphological analyzer. I am providing a JSON array containing Japanese text paragraphs.
You MUST output the exact same JSON structure, BUT for every "text" field, replace it with a "content" array of individual Japanese tokens (verbs, nouns, particles).
CRITICAL: For EVERY word token that contains Kanji, you MUST provide a "furigana" field showing its reading. 
CRITICAL: DO NOT keep any brackets [ ] or special markup in the text. Strip all formatting.

Input JSON:
${JSON.stringify(rawBlocks, null, 2)}

Output EXACTLY a JSON array matching this interface:
[
  {
    "type": "paragraph" | "yugen-box",
    "content": [ { "text": "...", "furigana": "..." } ],
    "keyword": "...",
    "reading": "...",
    "description": "..."
  }
]
`;

    onProgress?.("Analyzing morphology & attaching Furigana (0 bytes)...");
    console.log(`🧠 LLM CALL: Gemini -> gemini-3-flash-preview (rewriteArticle Pass 2 Stream)`);
    const result2 = await model.generateContentStream(prompt2);
    let rawText2 = '';
    for await (const chunk of result2.stream) {
      rawText2 += chunk.text();
      onProgress?.(`Analyzing morphology & attaching Furigana (${rawText2.length} bytes)...`);
    }
    rawText2 = rawText2.replace(/^```(json)?[\s\n]*/i, '').replace(/[\s\n]*```$/i, '').trim();
    
    const parsedBlocks = JSON.parse(rawText2) as ArticleBlock[];
    return parsedBlocks;

  } catch (error) {
    console.error("Gemini API Error details:", error);
    return mockArticles[0].blocks;
  }
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

/**
 * Post-Rewrite Token Linking (Phase 2)
 * 
 * Iterates through article tokens and links them to JMDict entry IDs.
 * This runs in the background after the article is rendered.
 */
export async function linkArticleToJMDict(
  blocks: ArticleBlock[], 
  onProgress?: (linkedCount: number, totalCount: number) => void
): Promise<ArticleBlock[]> {
  console.log("🔗 Starting JMDict Token Linking...");
  
  // 1. Collect all unique tokens that need linking (interactive or kanji-heavy)
  const tokensToLink = new Set<string>();
  blocks.forEach(block => {
    block.content?.forEach(token => {
      // Link if it has Kanji or is marked interactive
      if (token.furigana) {
        tokensToLink.add(token.text);
      }
    });
  });

  const uniqueWords = Array.from(tokensToLink);
  const total = uniqueWords.length;
  let linked = 0;

  // 2. Resolve each word (lookup + disambiguate if needed)
  // We'll do this in small batches to avoid Supabase/LLM overloading
  const resolvedMap = new Map<string, string>(); // word -> entry_id

  for (const word of uniqueWords) {
    try {
      const candidates = await lookupWord(word);
      if (candidates.length === 1) {
        resolvedMap.set(word, candidates[0].entryId);
      } else if (candidates.length > 1) {
        // For linking pass, we'll try a quick disambiguation 
        // using the first sentence it appears in
        let contextSentence = "";
        for (const block of blocks) {
          if (block.content?.some(t => t.text === word)) {
            contextSentence = block.content.map(t => t.text).join("");
            break;
          }
        }
        const best = await disambiguateWithLLM(word, contextSentence, candidates);
        resolvedMap.set(word, best.entryId);
      }
    } catch (e) {
      console.warn(`Failed to link word "${word}":`, e);
    }
    linked++;
    if (linked % 5 === 0) onProgress?.(linked, total);
  }

  // 3. Update the blocks with entry IDs
  const linkedBlocks = blocks.map(block => ({
    ...block,
    content: block.content?.map(token => ({
      ...token,
      jmdict_entry_id: resolvedMap.get(token.text) || token.jmdict_entry_id
    }))
  }));

  console.log(`✅ Linked ${linked}/${total} tokens to JMDict.`);
  onProgress?.(linked, total);
  return linkedBlocks;
}
