import React, { useState, useEffect } from 'react';
import { FuriganaText } from './FuriganaText';
import { YugenBox } from './YugenBox';
import { WordModal, WordDetails } from './WordModal';
import { fetchNewsFeed, rewriteArticleWithGemini, fetchWordDefinition, fetchSentenceTranslation } from '../services/api';
import { useAppStore } from '../services/store';
import { touchLock } from '../services/touchLock';

export function Reader() {
  const [selectedWord, setSelectedWord] = useState<WordDetails | null>(null);
  const [selectedSentence, setSelectedSentence] = useState<{ text: string, translation: string, id: string } | null>(null);
  const [drawerAnchor, setDrawerAnchor] = useState<'top' | 'bottom'>('bottom');
  
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState<string>("Initializing feed...");
  const [loadingArticleTitle, setLoadingArticleTitle] = useState<string>("");
  const [isModalLoading, setIsModalLoading] = useState(false);
  
  const [clickedWords, setClickedWords] = useState<Set<string>>(new Set());
  const [hasFinishedReading, setHasFinishedReading] = useState(false);
  const bottomRef = React.useRef<HTMLDivElement>(null);
  
  const segmenter = React.useMemo(() => {
    try {
      return new (Intl as any).Segmenter('ja-JP', { granularity: 'word' });
    } catch { return null; }
  }, []);
  
  const { 
    jlptLevel, rtkLevel, studyMode, vocabMode,
    wordDatabase, saveWordDefinition, recordWordSeen, setWordMastery,
    currentArticle, setCurrentArticle, srsAutoBumpThreshold,
    readerFontSize, readerFontWeight
  } = useAppStore();

  const loadArticle = async () => {
    setLoading(true);
    setLoadingStep("Fetching latest news...");
    setHasFinishedReading(false);
    setClickedWords(new Set());
    setCurrentArticle(null);
    setSelectedWord(null);
    setSelectedSentence(null);
    
    const vocabTargets = Object.entries(wordDatabase)
      .filter(([_, data]) => data.mastery === 'hard' || data.mastery === 'medium')
      .sort((a, b) => {
         if (a[1].mastery === 'hard' && b[1].mastery === 'medium') return -1;
         if (a[1].mastery === 'medium' && b[1].mastery === 'hard') return 1;
         return (b[1].consecutiveUnseen || 0) - (a[1].consecutiveUnseen || 0);
      })
      .slice(0, 40)
      .map(([word]) => word);
      
    const feed = await fetchNewsFeed('Technology startups');
    if (feed.length > 0) {
      setLoadingArticleTitle(feed[0].title);
      const snippet = feed[0].blocks[0].content?.[0]?.text || '';
      const rewrittenBlocks = await rewriteArticleWithGemini(
        feed[0].title, snippet, jlptLevel, rtkLevel, studyMode, vocabMode, vocabTargets,
        (step) => setLoadingStep(step)
      );
      setCurrentArticle({ ...feed[0], blocks: rewrittenBlocks });
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!currentArticle && !loading) loadArticle();
  }, []);

  useEffect(() => {
    if (!bottomRef.current || loading || !currentArticle || hasFinishedReading) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !hasFinishedReading) handleFinishArticle();
    }, { threshold: 0.1 });
    observer.observe(bottomRef.current);
    return () => observer.disconnect();
  }, [loading, currentArticle, hasFinishedReading]);

  const handleFinishArticle = () => {
    setHasFinishedReading(true);
    const articleWords = new Set<string>();
    currentArticle?.blocks.forEach(b => {
      if (b.content) b.content.forEach(w => { if (w.furigana) articleWords.add(w.text); });
    });

    articleWords.forEach(word => {
      if (!clickedWords.has(word)) {
        const stats = wordDatabase[word];
        recordWordSeen(word, true);
        const newConsecutive = (stats?.consecutiveUnseen || 0) + 1;
        if (stats && stats.mastery !== 'easy' && newConsecutive % (srsAutoBumpThreshold || 5) === 0) {
          setWordMastery(word, stats.mastery === 'hard' ? 'medium' : 'easy');
        } else if (!stats) {
          saveWordDefinition(word, { reading: '...', meaning: 'Implicitly parsed context' });
          setWordMastery(word, 'medium');
        }
      }
    });
  };

  const determineAnchor = (e: any) => {
    const y = 'clientY' in e ? e.clientY : (e.touches?.[0]?.clientY || 0);
    // USER: "prefereably drop down from the top unless there is not enough space"
    // We favor Top anchor (Word at bottom half)
    // Threshold biased towards Top: if word is below 38vh, use Top.
    setDrawerAnchor(y > window.innerHeight * 0.38 ? 'top' : 'bottom');
  };

  const handleWordClick = (details: WordDetails, e: any) => {
    if (touchLock.isLocked()) return;
    if (selectedWord?.word === details.word) {
      setSelectedWord(null);
      return;
    }
    determineAnchor(e);
    recordWordSeen(details.word);
    setClickedWords(prev => new Set(prev).add(details.word));
    setSelectedWord(details);
    setSelectedSentence(null);
    saveWordDefinition(details.word, details);
  };

  const handleDictionaryLookup = async (word: string, contextSentence: string, e: any) => {
    if (touchLock.isLocked()) return;
    if (selectedWord?.word === word) {
      setSelectedWord(null);
      return;
    }
    determineAnchor(e);
    recordWordSeen(word);
    setClickedWords(prev => new Set(prev).add(word));
    setSelectedSentence(null);
    
    const localData = wordDatabase[word];
    if (localData && localData.meaning && localData.meaning !== 'Implicitly parsed context') {
      setSelectedWord({ word, reading: localData.reading, meaning: localData.meaning, grammarNote: localData.grammarNote });
      return;
    }

    setSelectedWord({ word, reading: '...', meaning: '' });
    setIsModalLoading(true);
    const def = await fetchWordDefinition(word, contextSentence);
    saveWordDefinition(word, def);
    setSelectedWord(def);
    setIsModalLoading(false);
  };

  const handleSentenceTranslate = async (sentence: string, sentenceId: string, e: any) => {
    if (touchLock.isLocked()) return;
    if (selectedSentence?.id === sentenceId) {
      setSelectedSentence(null);
      return;
    }
    determineAnchor(e);
    setSelectedWord(null);
    setSelectedSentence({ text: sentence, translation: '', id: sentenceId });
    setIsModalLoading(true);
    const translation = await fetchSentenceTranslation(sentence, currentArticle?.blocks.map(b => b.content?.map(c => c.text).join('')).join('\n') || '');
    setSelectedSentence({ text: sentence, translation, id: sentenceId });
    setIsModalLoading(false);
  };

  const handleSetMastery = (level: 'hard' | 'medium' | 'easy') => {
    if (selectedWord) setWordMastery(selectedWord.word, level);
  };

  const renderParagraph = (block: any, blockIdx: number) => {
    // 1. Group tokens into sentences
    const sentences: any[][] = [];
    let currentSent: any[] = [];
    block.content.forEach((seg: any) => {
      currentSent.push(seg);
      if (seg.text.match(/[。！？\n]/)) {
        sentences.push(currentSent);
        currentSent = [];
      }
    });
    if (currentSent.length > 0) sentences.push(currentSent);

    return sentences.map((sentTokens, sIdx) => {
      const sentText = sentTokens.map(t => t.text).join('');
      const sentenceId = `${blockIdx}-${sIdx}`;
      const isSentenceSelected = selectedSentence?.id === sentenceId;

      return (
        <span 
          key={sentenceId} 
          className={isSentenceSelected ? 'sentence-highlight' : ''}
          onDoubleClick={(e) => handleSentenceTranslate(sentText, sentenceId, e)}
        >
          {sentTokens.map((segment, j) => {
            if (segment.furigana || segment.isInteractive) {
              return (
                <FuriganaText
                  key={`${sentenceId}-${j}`}
                  word={segment.text}
                  furigana={segment.furigana}
                  isSelected={selectedWord?.word === segment.text}
                  onClick={(e) => {
                    if (segment.details) handleWordClick(segment.details as WordDetails, e);
                    else handleDictionaryLookup(segment.text, sentText, e);
                  }}
                />
              );
            }
            if (segmenter) {
              const words = Array.from((segmenter as any).segment(segment.text));
              return words.map((w: any, index: number) => {
                if (!w.isWordLike) return <span key={`${sentenceId}-${j}-${index}`}>{w.segment}</span>;
                return (
                  <span 
                    key={`${sentenceId}-${j}-${index}`}
                    className={selectedWord?.word === w.segment ? 'word-highlight' : ''}
                    onClick={(e) => handleDictionaryLookup(w.segment, sentText, e)}
                    style={{ cursor: 'pointer' }}
                  >
                    {w.segment}
                  </span>
                );
              });
            }
            return <span key={`${sentenceId}-${j}`}>{segment.text}</span>;
          })}
        </span>
      );
    });
  };

  if (loading || !currentArticle) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', minHeight: '60vh', textAlign: 'center', padding: '0 2rem' }}>
        <div className="lucide-spin" style={{ color: 'var(--text-main)', marginBottom: '1.5rem', width: '32px', height: '32px', border: '3px solid var(--border-light)', borderTopColor: 'var(--text-main)', borderRadius: '50%' }} />
        <h2 className="serif fade-in" style={{ fontSize: '1.25rem', color: 'var(--text-main)', marginBottom: '1rem' }}>{loadingArticleTitle || '読書家'}</h2>
        <div className="fade-in" style={{ padding: '1rem 1.5rem', backgroundColor: 'var(--bg-card)', borderRadius: '16px', width: '100%', maxWidth: '400px' }}>
          <p style={{ color: 'var(--text-main)', fontSize: '0.9rem', fontWeight: 600, fontFamily: 'monospace' }}>{loadingStep}</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="reading-content fade-in" style={{ paddingBottom: '6rem', fontSize: `${readerFontSize || 18}px`, fontWeight: readerFontWeight || 400 }}>
        <div style={{ marginBottom: '3rem' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '1rem', display: 'flex', gap: '1rem' }}>
            <span style={{ backgroundColor: 'var(--bg-card)', padding: '0.2rem 0.6rem', borderRadius: '4px' }}>{currentArticle.category}</span>
            <span>{currentArticle.readTime}</span>
          </div>
          <h1 className="serif" style={{ fontSize: '2.5rem', lineHeight: 1.3, marginBottom: '2rem', color: 'var(--text-main)' }}>
            {currentArticle.title}
          </h1>
          <div style={{ width: '40px', height: '1px', backgroundColor: 'var(--text-muted)', marginBottom: '2rem' }} />
        </div>

        {currentArticle.blocks.map((block, i) => {
          if (block.type === 'paragraph') return <p key={i} style={{ lineHeight: 2.2 }}>{renderParagraph(block, i)}</p>;
          if (block.type === 'yugen-box') return <YugenBox key={i} keyword={block.keyword!} reading={block.reading} description={block.description!} />;
          return null;
        })}

        {hasFinishedReading && (
          <div style={{ textAlign: 'center', marginTop: '4rem' }}>
             <button onClick={loadArticle} style={{ backgroundColor: 'transparent', color: 'var(--text-muted)', padding: '0.75rem 2rem', borderRadius: '100px', fontWeight: 600, border: '1px solid var(--border-light)', cursor: 'pointer' }}>
               <span className="serif" style={{ fontSize: '1.25rem', verticalAlign: 'middle', marginRight: '0.2rem' }}>次へ</span> &rarr;
             </button>
          </div>
        )}
        <div ref={bottomRef} style={{ height: '10px' }} />
      </div>

      <WordModal 
        isOpen={!!selectedWord || !!selectedSentence} 
        onDismissStart={() => {
          setSelectedWord(null);
          setSelectedSentence(null);
        }}
        onClose={() => { 
          setSelectedWord(null); 
          setSelectedSentence(null); 
          touchLock.lock();
        }} 
        mode={selectedSentence ? 'sentence' : 'word'}
        wordData={selectedWord}
        sentenceText={selectedSentence?.text}
        sentenceTranslation={selectedSentence?.translation}
        anchor={drawerAnchor}
        onSetMastery={handleSetMastery}
        isLoading={isModalLoading}
      />
    </>
  );
}
