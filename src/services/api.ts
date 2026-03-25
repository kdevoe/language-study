import { WordDetails } from '../components/WordModal';

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

// In the future this will call Google Custom Search JSON API
export async function fetchNewsFeed(): Promise<NewsArticle[]> {
  console.log("Mocking Google Custom Search API fetch...");
  await new Promise(resolve => setTimeout(resolve, 800));
  return mockArticles;
}

// In the future this will call Google Gemini API
export async function mockLlmRewrite(_articleUrl: string, jlpt: number | null, rtk: number | null): Promise<ArticleBlock[]> {
  console.log(`Mocking Gemini LLM Rewrite for JLPT N${jlpt} and RTK ${rtk}...`);
  await new Promise(resolve => setTimeout(resolve, 1500));
  return mockArticles[0].blocks;
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
