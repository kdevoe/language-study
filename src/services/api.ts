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
  "reading": "the kana reading",
  "meaning": "Short concise English meaning"
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

// In the future this will call Google Gemini API
export async function rewriteArticleWithGemini(title: string, snippet: string, jlpt: number | null, rtk: number | null): Promise<ArticleBlock[]> {
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
    const rtkStr = rtk ? `${rtk} Kanji` : '500 Kanji';

    const prompt = `
You are an expert Japanese teacher. I will give you a news headline and snippet.
Write a 3-paragraph news article in Japanese based on this news.
Target Audience: A student at JLPT ${jlptStr} level who knows roughly ${rtkStr}.
Rules:
1. Use appropriate grammar for JLPT ${jlptStr}.
2. Use Kanji appropriate for someone who knows ${rtkStr}. For any difficult or new Kanji, provide Furigana.
3. Keep the tone like a Japanese news broadcast.
4. Pick out 1 or 2 important vocabulary words or grammar points and explain them in English as a "yugen-box" block.
5. Create interactive words in the paragraphs with their readings, meanings, and a short grammarNote.

Output EXACTLY a JSON array matching this interface:
[
  {
    "type": "paragraph" | "yugen-box",
    "content": [ { "text": "...", "furigana": "...", "isInteractive": true|false, "details": { "word": "...", "reading": "...", "meaning": "...", "grammarNote": "..." } } ],
    "keyword": "...",
    "reading": "...",
    "description": "..."
  }
]

News Headline: ${title}
News Snippet: ${snippet}
`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const parsedBlocks = JSON.parse(text) as ArticleBlock[];
    return parsedBlocks;

  } catch (error) {
    console.error("Gemini API Error:", error);
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
