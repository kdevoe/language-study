import React, { useState, useEffect } from 'react';
import { FuriganaText } from './FuriganaText';
import { YugenBox } from './YugenBox';
import { WordModal, WordDetails } from './WordModal';
import { fetchNewsFeed, rewriteArticleWithGemini, fetchWordDefinition } from '../services/api';
import { useAppStore } from '../services/store';

export function Reader() {
  const [selectedWord, setSelectedWord] = useState<WordDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState<string>("Initializing feed...");
  const [loadingArticleTitle, setLoadingArticleTitle] = useState<string>("");
  const [isWordLoading, setIsWordLoading] = useState(false);
  
  const [clickedWords, setClickedWords] = useState<Set<string>>(new Set());
  const [hasFinishedReading, setHasFinishedReading] = useState(false);
  const bottomRef = React.useRef<HTMLDivElement>(null);
  
  // Memoize the Japanese segmenter so it's instantly ready
  const segmenter = React.useMemo(() => {
    try {
      return new (Intl as any).Segmenter('ja-JP', { granularity: 'word' });
    } catch {
      return null;
    }
  }, []);
  
  const { 
    jlptLevel, rtkLevel, studyMode, 
    wordDatabase, saveWordDefinition, recordWordSeen, setWordMastery,
    currentArticle, setCurrentArticle
  } = useAppStore();

  const loadArticle = async () => {
    setLoading(true);
    setLoadingStep("Fetching latest news...");
    setHasFinishedReading(false);
    setClickedWords(new Set());
    
    // Clear the current article layout to show loading screen
    setCurrentArticle(null);
    
    const feed = await fetchNewsFeed('Technology startups');
    if (feed.length > 0) {
      setLoadingArticleTitle(feed[0].title);
      const snippet = feed[0].blocks[0].content?.[0]?.text || '';
      const rewrittenBlocks = await rewriteArticleWithGemini(
        feed[0].title, 
        snippet, 
        jlptLevel, 
        rtkLevel, 
        studyMode,
        (step) => setLoadingStep(step)
      );
      setCurrentArticle({ ...feed[0], blocks: rewrittenBlocks });
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!currentArticle && !loading) {
      loadArticle();
    }
  }, []); // Only fetch manually or on extreme start when nothing is loaded

  useEffect(() => {
    if (!bottomRef.current || loading || !currentArticle || hasFinishedReading) return;
    
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !hasFinishedReading) {
        handleFinishArticle();
      }
    }, { threshold: 0.1 });
    
    observer.observe(bottomRef.current);
    return () => observer.disconnect();
  }, [loading, currentArticle, hasFinishedReading]);

  const handleFinishArticle = () => {
    setHasFinishedReading(true);
    
    // Auto-bump unseen words natively to SRS memory
    const articleWords = new Set<string>();
    currentArticle?.blocks.forEach(b => {
      if (b.content) b.content.forEach(w => {
         if (w.furigana) articleWords.add(w.text);
      });
    });

    articleWords.forEach(word => {
      if (!clickedWords.has(word)) {
        const stats = wordDatabase[word];
        if (stats && stats.mastery !== 'easy') {
          const nextLevel = stats.mastery === 'hard' ? 'medium' : 'easy';
          setWordMastery(word, nextLevel);
        } else if (!stats) {
          saveWordDefinition(word, { reading: '...', meaning: 'Implicitly parsed context' });
          recordWordSeen(word);
          setWordMastery(word, 'easy');
        }
      }
    });
  };

  const handleWordClick = (details: WordDetails) => {
    recordWordSeen(details.word);
    setClickedWords(prev => new Set(prev).add(details.word));
    setSelectedWord(details);
    
    // Make sure we overwrite any "Implicitly parsed context" that may have been previously assigned
    saveWordDefinition(details.word, { 
      reading: details.reading, 
      meaning: details.meaning, 
      grammarNote: details.grammarNote 
    });
  };

  const handleDictionaryLookup = async (word: string, contextSentence: string) => {
    recordWordSeen(word);
    setClickedWords(prev => new Set(prev).add(word));
    
    // Check local database first
    const localData = wordDatabase[word];
    const isImplicit = localData && localData.meaning === 'Implicitly parsed context';
    if (localData && localData.meaning && !isImplicit) {
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

  if (loading || !currentArticle) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', minHeight: '60vh', textAlign: 'center', padding: '0 2rem' }}>
        <div className="lucide-spin" style={{ color: 'var(--text-main)', marginBottom: '1.5rem', width: '32px', height: '32px', border: '3px solid var(--border-light)', borderTopColor: 'var(--text-main)', borderRadius: '50%' }} />
        {loadingArticleTitle ? (
            <h2 className="serif fade-in" style={{ fontSize: '1.25rem', color: 'var(--text-main)', marginBottom: '1rem', lineHeight: 1.4 }}>
              {loadingArticleTitle}
            </h2>
        ) : (
            <h2 className="serif fade-in" style={{ fontSize: '1.25rem', color: 'var(--text-main)', marginBottom: '1rem', lineHeight: 1.4 }}>
              読書家
            </h2>
        )}
        <div className="fade-in" style={{ 
          marginTop: '1rem',
          padding: '1rem 1.5rem', 
          backgroundColor: 'var(--bg-card)', 
          borderRadius: '16px',
          width: '100%',
          maxWidth: '400px'
        }}>
          <p style={{ 
            color: 'var(--text-main)', 
            fontSize: '0.9rem', 
            letterSpacing: '0.05em', 
            fontWeight: 600,
            transition: 'all 0.2s',
            fontFamily: 'monospace'
          }}>
            {loadingStep}
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="reading-content fade-in" style={{ paddingBottom: '6rem' }}>
        <div style={{ marginBottom: '3rem' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '1rem', display: 'flex', gap: '1rem', letterSpacing: '0.05em' }}>
            <span style={{ backgroundColor: 'var(--bg-card)', padding: '0.2rem 0.6rem', borderRadius: '4px' }}>{currentArticle.category}</span>
            <span style={{ display: 'flex', alignItems: 'center' }}>{currentArticle.readTime}</span>
          </div>
          <h1 className="serif" style={{ fontSize: '2.5rem', lineHeight: 1.3, marginBottom: '2rem', color: 'var(--text-main)' }}>
            {currentArticle.title.split('：').map((part, i, arr) => (
              <React.Fragment key={i}>
                {part}{i < arr.length - 1 && '：'}<br/>
              </React.Fragment>
            ))}
          </h1>
          <div style={{ width: '40px', height: '1px', backgroundColor: 'var(--text-muted)', marginBottom: '2rem' }} />
        </div>

        {currentArticle.blocks.map((block, i) => {
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

        {hasFinishedReading && (
          <div className="fade-in" style={{ textAlign: 'center', marginTop: '4rem', marginBottom: '2rem' }}>
             <button 
                onClick={loadArticle} 
                style={{ 
                  backgroundColor: 'transparent', 
                  color: 'var(--text-muted)', 
                  padding: '0.75rem 2rem', 
                  borderRadius: '100px', 
                  fontWeight: 600, 
                  border: '1px solid var(--border-light)', 
                  cursor: 'pointer',
                  fontSize: '0.9rem',
                }}
              >
               Next Article &rarr;
             </button>
          </div>
        )}
        <div ref={bottomRef} style={{ height: '10px' }} />
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
