import { WordDetails } from '../components/WordModal';
import { GoogleGenerativeAI } from '@google/generative-ai';

export interface ArticleBlock {
  type: 'paragraph' | 'yugen-box';
  content?: { text: string; furigana?: string; isInteractive?: boolean; details?: WordDetails }[];
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

export async function fetchNewsFeed(topic: string = 'Technology News'): Promise<NewsArticle[]> {
  const apiKey = import.meta.env.VITE_NEWS_API_KEY;

  if (!apiKey) {
    console.warn("⚠️ NewsAPI key not found in .env. Falling back to mock data.");
    await new Promise(resolve => setTimeout(resolve, 800));
    return mockArticles;
  }

  try {
    const query = encodeURIComponent(topic);
    // NewsAPI 'everything' endpoint searches all articles for the given topic
    const url = `https://newsapi.org/v2/everything?q=${query}&sortBy=publishedAt&language=en&pageSize=5&apiKey=${apiKey}`;
    
    const response = await fetch(url);
    if (!response.ok) throw new Error(`NewsAPI failed: ${response.statusText}`);
    
    const data = await response.json();
    
    if (!data.articles || data.articles.length === 0) {
      console.warn("No results found from NewsAPI, returning mock data.");
      return mockArticles;
    }

    const articles: NewsArticle[] = data.articles.map((item: any) => ({
      id: item.url,
      title: item.title,
      originalUrl: item.url,
      date: item.publishedAt || new Date().toISOString(), 
      readTime: 'TBD',
      category: 'Recent News',
      // We map the description/content here temporarily until Gemini rewrites it
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

export async function fetchWordDefinition(word: string, contextSentence: string): Promise<WordDetails> {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey) {
    return { word, reading: 'Unknown', meaning: 'API Key missing.' };
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.5-flash", 
      generationConfig: { responseMimeType: "application/json" } 
    });

    const prompt = `You are a Japanese dictionary. Define the precise word "${word}" based on this context: "${contextSentence}".
Output EXACTLY JSON matching this interface:
{
  "word": "${word}",
  "reading": "the entire kana reading",
  "meaning": "Short concise English meaning",
  "grammarNote": "Any quick contextual grammar notes",
  "furiganaMap": [
    { "kanji": "first character", "kana": "reading of first character" },
    { "kanji": "second character", "kana": "reading of second character" }
  ] // You MUST include this array mapping exactly how the reading breaks down per character in the word. For pure Kana words, just put the whole word as one character map.
}`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const parsed = JSON.parse(text) as WordDetails;
    
    return parsed;
  } catch (error) {
    console.error("Dictionary API Error:", error);
    return { word, reading: 'Error', meaning: 'Failed to look up word.' };
  }
}

import { rtkKanjiList } from '../data/rtkKanji';

// In the future this will call Google Gemini API
export async function rewriteArticleWithGemini(
  title: string, 
  snippet: string, 
  jlpt: number | null, 
  rtk: number | null, 
  studyMode: 'natural' | 'balanced' | 'study' = 'balanced',
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
      model: "gemini-2.5-flash", 
      generationConfig: { responseMimeType: "application/json" } 
    });

    const jlptStr = jlpt ? `N${jlpt}` : 'N4';
    
    const safeRtk = rtk || 122;
    const knownKanji = rtkKanjiList.slice(0, Math.max(0, safeRtk - 15));
    const recentKanji = rtkKanjiList.slice(Math.max(0, safeRtk - 15), safeRtk);
    
    let biasInstruction = `NATURAL READING: Prioritize fluid, authentic, natural Japanese over restricting yourself to studied Kanji. The text should read exactly like a standard native news article without arbitrarily forcing known Kanji.`;
    if (studyMode === 'study') {
      biasInstruction = `EXTREME STUDIED BIAS: You MUST drastically alter the summary's phrasing and wording specifically to maximize the usage of the "Student known Kanji" list. CRITICAL TARGETS are your highest priority. It is actively encouraged to sacrifice perfectly natural/authentic journalistic prose if it means you can replace an unknown compound word with a synonym that utilizes the student's known Kanji. Do whatever it takes to aggressively incorporate the student's Kanji into the text.`;
    } else if (studyMode === 'balanced') {
      biasInstruction = `BALANCED BIAS: Write naturally, but whenever there are multiple valid word choices to express an idea, deliberately choose the synonym that utilizes Kanji from the "Student known Kanji" list (especially CRITICAL TARGETS) rather than an unknown Kanji. Allow minor deviations from strict journalistic style to accommodate these known characters.`;
    }
    
    // --- PASS 1: Content Generation (Plain Text) ---
    const prompt1 = `
You are a Japanese teacher. Write a 3-paragraph news article in Japanese based on this news.
Language Level: JLPT ${jlptStr}. 
Student known Kanji: [${knownKanji.join('')}].
CRITICAL TARGETS: Prioritize using these Kanji: [${recentKanji.join('')}].

Rules:
1. Tone must be like a Japanese news broadcast.
2. Pick 1 or 2 important vocabulary words and explain them in English as a "yugen-box".
3. Provide the full Japanese text strings. DO NOT tokenize the text yet.
4. KANJI PREFERENCE: ${biasInstruction}
   While you should keep "CRITICAL TARGETS" in mind as excellent candidate words, do not force them into sentences un-naturally.

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
    let rawText1 = result1.response.text().replace(/^```(json)?[\s\n]*/i, '').replace(/[\s\n]*```$/i, '').trim();
    const rawBlocks = JSON.parse(rawText1);

    // --- PASS 2: Tokenization & Furigana ---
    const prompt2 = `
You are a morphological analyzer. I am providing a JSON array containing Japanese text paragraphs.
You MUST output the exact same JSON structure, BUT for every "text" field, replace it with a "content" array of individual Japanese tokens (verbs, nouns, particles).
CRITICAL: For EVERY word token that contains Kanji, you MUST provide a "furigana" field showing its reading. 

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
    const result2 = await model.generateContentStream(prompt2);
    let rawText2 = '';
    for await (const chunk of result2.stream) {
      rawText2 += chunk.text();
      onProgress?.(`Analyzing morphology & attaching Furigana (${rawText2.length} bytes)...`);
    }
    rawText2 = rawText2.replace(/^```(json)?[\s\n]*/i, '').replace(/[\s\n]*```$/i, '').trim();
    
    // Aggressive debugging for the user
    console.log("================ PASS 2 COMPLETE ================");
    console.log("Raw LLM output length:", rawText2.length);
    console.log("Raw LLM output snippet:", rawText2.substring(0, 300) + "...");
    
    const parsedBlocks = JSON.parse(rawText2) as ArticleBlock[];
    
    // Count furigana to verify feature works
    let furiganaCount = 0;
    parsedBlocks.forEach(b => {
      if (b.content) b.content.forEach(w => { if (w.furigana) furiganaCount++; });
    });
    console.log(`Successfully parsed ${parsedBlocks.length} blocks containing ${furiganaCount} total furigana words.`);
    console.log("==================================================");

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
          { text: '」です。建築、庭園、音楽、そして日常の' },
          { text: '言葉', furigana: 'ことば', isInteractive: true, details: { word: '言葉', reading: 'KO-TO-BA', meaning: 'Word, language, or speech. In Japanese aesthetics, the word often carries the weight of "Koto-dama" (the spirit of language).', grammarNote: 'Refers to both individual words and the concept of language in general. Often used to describe the "power of words" (kotodama).' } },
          { text: 'の中に、この静かな空白が息づいています。' },
        ]
      },
      {
        type: 'yugen-box',
        keyword: '幽玄',
        reading: 'Yūgen',
        description: '言葉に尽くせない深遠な趣。かすかな兆しの中に美を感じ取る感性。'
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
