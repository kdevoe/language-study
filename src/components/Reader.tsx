import React, { useState, useEffect } from 'react';
import { FuriganaText } from './FuriganaText';
import { YugenBox } from './YugenBox';
import { WordModal, WordDetails } from './WordModal';
import { fetchNewsFeed, mockLlmRewrite, NewsArticle } from '../services/api';
import { useAppStore } from '../services/store';

export function Reader() {
  const [selectedWord, setSelectedWord] = useState<WordDetails | null>(null);
  const [article, setArticle] = useState<NewsArticle | null>(null);
  const [loading, setLoading] = useState(true);
  
  const { jlptLevel, rtkLevel, setWordMastery } = useAppStore();

  useEffect(() => {
    async function loadArticle() {
      setLoading(true);
      const feed = await fetchNewsFeed();
      if (feed.length > 0) {
        // Rewrite using LLM context
        const rewrittenBlocks = await mockLlmRewrite(feed[0].originalUrl, jlptLevel, rtkLevel);
        setArticle({ ...feed[0], blocks: rewrittenBlocks });
      }
      setLoading(false);
    }
    loadArticle();
  }, [jlptLevel, rtkLevel]);

  const handleWordClick = (details: WordDetails) => {
    setSelectedWord(details);
  };

  const handleSetMastery = (level: 'hard' | 'easy' | 'known') => {
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
            return (
              <p key={i}>
                {block.content!.map((segment, j) => {
                  if (segment.isInteractive) {
                    return (
                      <FuriganaText
                        key={j}
                        word={segment.text}
                        furigana={segment.furigana}
                        mode="always"
                        onClick={() => handleWordClick(segment.details as WordDetails)}
                      />
                    );
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
      />
    </>
  );
}
