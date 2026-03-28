import React, { useState, useEffect } from 'react';
import { FuriganaText } from './FuriganaText';
import { YugenBox } from './YugenBox';
import { WordModal, WordDetails } from './WordModal';
import { fetchNewsFeed, rewriteArticleWithGemini, fetchWordDefinition, NewsArticle } from '../services/api';
import { useAppStore } from '../services/store';

export function Reader() {
  const [selectedWord, setSelectedWord] = useState<WordDetails | null>(null);
  const [article, setArticle] = useState<NewsArticle | null>(null);
  const [loading, setLoading] = useState(true);
  const [isWordLoading, setIsWordLoading] = useState(false);
  
  // Memoize the Japanese segmenter so it's instantly ready
  const segmenter = React.useMemo(() => {
    try {
      return new (Intl as any).Segmenter('ja-JP', { granularity: 'word' });
    } catch {
      return null;
    }
  }, []);
  
  const { jlptLevel, rtkLevel, targetDensity, wordDatabase, saveWordDefinition, recordWordSeen, setWordMastery } = useAppStore();

  useEffect(() => {
    async function loadArticle() {
      setLoading(true);
      // Fetching general news based on a topic
      const feed = await fetchNewsFeed('Technology startups');
      if (feed.length > 0) {
        // Rewrite using LLM context
        const snippet = feed[0].blocks[0].content?.[0]?.text || '';
        const rewrittenBlocks = await rewriteArticleWithGemini(feed[0].title, snippet, jlptLevel, rtkLevel, targetDensity);
        setArticle({ ...feed[0], blocks: rewrittenBlocks });
      }
      setLoading(false);
    }
    loadArticle();
  }, [jlptLevel, rtkLevel, targetDensity]);

  const handleWordClick = (details: WordDetails) => {
    recordWordSeen(details.word);
    setSelectedWord(details);
  };

  const handleDictionaryLookup = async (word: string, contextSentence: string) => {
    recordWordSeen(word);
    
    // Check local database first
    const localData = wordDatabase[word];
    if (localData && localData.meaning) {
      setSelectedWord({ word, reading: localData.reading, meaning: localData.meaning, grammarNote: localData.grammarNote });
      return;
    }

    // Open the modal immediately in loading state
    setSelectedWord({ word, reading: '...', meaning: '' });
    setIsWordLoading(true);
    const def = await fetchWordDefinition(word, contextSentence);
    
    saveWordDefinition(word, { reading: def.reading, meaning: def.meaning, grammarNote: def.grammarNote });
    setSelectedWord(def);
    setIsWordLoading(false);
  };

  const handleSetMastery = (level: 'hard' | 'medium' | 'easy') => {
    if (selectedWord) {
      setWordMastery(selectedWord.word, level);
    }
  };

  if (loading || !article) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh', color: 'var(--text-muted)' }}>
        <p className="fade-in">読込中... (Loading...)</p>
      </div>
    );
  }

  return (
    <>
      <div className="reading-content fade-in" style={{ paddingBottom: '6rem' }}>
        <div style={{ marginBottom: '3rem' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '1rem', display: 'flex', gap: '1rem', letterSpacing: '0.05em' }}>
            <span style={{ backgroundColor: 'var(--bg-card)', padding: '0.2rem 0.6rem', borderRadius: '4px' }}>{article.category}</span>
            <span style={{ display: 'flex', alignItems: 'center' }}>{article.readTime}</span>
          </div>
          <h1 className="serif" style={{ fontSize: '2.5rem', lineHeight: 1.3, marginBottom: '2rem', color: 'var(--text-main)' }}>
            {article.title.split('：').map((part, i, arr) => (
              <React.Fragment key={i}>
                {part}{i < arr.length - 1 && '：'}<br/>
              </React.Fragment>
            ))}
          </h1>
          <div style={{ width: '40px', height: '1px', backgroundColor: 'var(--text-muted)', marginBottom: '2rem' }} />
        </div>

        {article.blocks.map((block, i) => {
          if (block.type === 'paragraph') {
            // Reconstruct the full paragraph text for context
            const paragraphText = block.content!.map(s => s.text).join('');
            
            return (
              <p key={i} style={{ lineHeight: 2.2 }}>
                {block.content!.map((segment, j) => {
                  if (segment.furigana || segment.isInteractive) {
                    return (
                      <FuriganaText
                        key={j}
                        word={segment.text}
                        furigana={segment.furigana}
                        onClick={() => {
                          if (segment.details) {
                            handleWordClick(segment.details as WordDetails);
                          } else {
                            handleDictionaryLookup(segment.text, paragraphText);
                          }
                        }}
                      />
                    );
                  }
                  
                  // If it's pure Japanese text, let's tokenize it into clickable spans
                  if (segmenter) {
                    const words = Array.from((segmenter as any).segment(segment.text));
                    return words.map((w: any, index: number) => {
                      if (!w.isWordLike) {
                        return <span key={`${j}-${index}`}>{w.segment}</span>;
                      }
                      return (
                        <span 
                          key={`${j}-${index}`}
                          onClick={() => handleDictionaryLookup(w.segment, paragraphText)}
                          style={{ cursor: 'pointer', borderBottom: '1px solid transparent' }}
                          onMouseEnter={(e) => (e.currentTarget.style.borderBottom = '1px dashed var(--border-light)')}
                          onMouseLeave={(e) => (e.currentTarget.style.borderBottom = '1px solid transparent')}
                        >
                          {w.segment}
                        </span>
                      );
                    });
                  }
                  return <span key={j}>{segment.text}</span>;
                })}
              </p>
            );
          } else if (block.type === 'yugen-box') {
            return (
              <YugenBox 
                key={i} 
                keyword={block.keyword!} 
                reading={block.reading} 
                description={block.description!} 
              />
            );
          }
          return null;
        })}
      </div>

      <WordModal 
        isOpen={!!selectedWord} 
        onClose={() => setSelectedWord(null)} 
        wordData={selectedWord}
        onSetMastery={handleSetMastery}
        isLoading={isWordLoading}
      />
    </>
  );
}
