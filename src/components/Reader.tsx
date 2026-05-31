import React, { useState, useEffect } from 'react';
import { FuriganaText, HitWeight } from './FuriganaText';
import type { MasteryLevel } from '../services/store';
import { YugenBox } from './YugenBox';
import { WordModal, WordDetails } from './WordModal';
import { 
  rewriteArticleWithGemini, 
  fetchWordDefinitionQuick, 
  fetchWordGrammarInsight, 
  fetchSentenceTranslation
} from '../services/api';
import { useAppStore } from '../services/store';
import { touchLock } from '../services/touchLock';
import { } from 'lucide-react'; // Empty block to show we're using icons elsewhere if needed, or just clear it.
// Actually, let's just remove the line if no icons are used.


interface ReaderProps {
  initialArticle?: any;
  onComplete?: () => void;
}

// Deterministic tap-target sizing. Kanji content words (furigana present) are
// the ones users actually look up, so they get the widest hit area; short kana
// tokens are almost always particles/grammatical glue, so they yield to their
// neighbors. Already-mastered words don't need a big target either.
function hitWeightFor(text: string, furigana?: string, mastery?: MasteryLevel): HitWeight {
  const hasKanji = !!furigana && furigana.trim() !== '';
  if (hasKanji) return mastery === 'easy' ? 'mid' : 'hi';
  return [...text].length <= 2 ? 'lo' : 'mid';
}

export function Reader({ initialArticle, onComplete }: ReaderProps) {
  const [selectedWord, setSelectedWord] = useState<WordDetails | null>(null);
  const [selectedSentence, setSelectedSentence] = useState<{ text: string, translation: string, id: string } | null>(null);
  const [drawerAnchor, setDrawerAnchor] = useState<'top' | 'bottom'>('bottom');
  const [activeHighlightId, setActiveHighlightId] = useState<string | null>(null);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState<string>("Initializing feed...");
  const [loadingArticleTitle, setLoadingArticleTitle] = useState<string>("");
  const [isModalLoading, setIsModalLoading] = useState(false);
  
  const [clickedWords, setClickedWords] = useState<Set<string>>(new Set());

  // End-of-article mastery sweep. Runs at most once per article, triggered either
  // by the 次へ button or by scrolling the end of the text into view (many readers
  // never tap the button). finishRef mirrors the latest handler so the observer
  // always calls a fresh closure (current clickedWords / wordDatabase) without
  // having to re-subscribe.
  const hasSweptRef = React.useRef(false);
  const endSentinelRef = React.useRef<HTMLDivElement | null>(null);
  const finishRef = React.useRef<() => void>(() => {});

  const segmenter = React.useMemo(() => {
    try {
      return new (Intl as any).Segmenter('ja-JP', { granularity: 'word' });
    } catch { return null; }
  }, []);
  
  const {
    wordDatabase, saveWordDefinition, recordWordSeen, setWordMastery, applyDifficultyEvent,
    currentArticle, setCurrentArticle, articlesCache, saveProcessedArticle,
    readerFontSize, readerFontWeight
  } = useAppStore();

  const loadArticle = async () => {
    // 1. Check Cache first for instant return
    if (initialArticle?.id && articlesCache[initialArticle.id]) {
      setCurrentArticle(articlesCache[initialArticle.id]);
      setLoading(false);
      return;
    }

    // 2. Atomic state clearing
    setCurrentArticle(null);
    setLoading(true);
    setLoadingStep("Initializing reader...");
    setLoadingArticleTitle(initialArticle?.title || "読書家");
    setClickedWords(new Set());
    setSelectedWord(null);
    setSelectedSentence(null);
    setActiveHighlightId(null);
    

      
      
    // Use the specific article passed from the Hub
    const selectedRaw = initialArticle;

    if (selectedRaw) {
      setLoadingArticleTitle(selectedRaw.title);
      // Snippet for rewriting (limit to first block for speed)
      const snippet = selectedRaw.blocks?.[0]?.content?.[0]?.text || '';
      const rewrittenBlocks = await rewriteArticleWithGemini(
        selectedRaw.title, snippet, (step) => setLoadingStep(step)
      );
      const processed = { ...selectedRaw, blocks: rewrittenBlocks };
      setCurrentArticle(processed);
      // 3. Save to cache for next time
      if (selectedRaw.id) saveProcessedArticle(selectedRaw.id, processed);
    } else {
      // Emergency Fallback
      setLoading(false);
    }
    setLoading(false);
  };

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    if (!currentArticle && !loading) loadArticle();
  }, [initialArticle]);

  // A new article means the sweep is allowed to run again.
  useEffect(() => {
    hasSweptRef.current = false;
  }, [currentArticle]);

  // Fire the sweep when the end-of-text marker scrolls into view, so reading the
  // whole article counts even when the reader never taps 次へ.
  useEffect(() => {
    const el = endSentinelRef.current;
    if (!el || !currentArticle) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) finishRef.current();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [currentArticle, loading]);

  const handleFinishArticle = () => {
    if (hasSweptRef.current) return; // once per article — button or scroll, whichever comes first
    hasSweptRef.current = true;
    // Keep the richest token per word (one with details/jmdict id) so we can seed
    // difficulty from JLPT and store a real entry for never-clicked new words.
    const articleWords = new Map<string, any>();
    currentArticle?.blocks.forEach(b => {
      if (b.content) b.content.forEach(w => {
        if (!w.furigana) return;
        const existing = articleWords.get(w.text);
        if (!existing || (!existing.details && (w.details || w.jmdict_entry_id))) {
          articleWords.set(w.text, w);
        }
      });
    });

    articleWords.forEach((token, word) => {
      if (clickedWords.has(word)) return;
      const details = token.details as WordDetails | undefined;
      const jlptLevel = details?.jlptLevel;
      // Make sure a never-seen word exists before grading it.
      if (!wordDatabase[word]) {
        saveWordDefinition(word, details
          ? { reading: details.reading, meaning: details.meaning, jlptLevel: details.jlptLevel, furiganaMap: details.furiganaMap, pos: details.pos, jmdictEntryId: details.jmdictEntryId || token.jmdict_entry_id }
          : { reading: '...', meaning: 'Implicitly parsed context', jmdictEntryId: token.jmdict_entry_id });
      }
      recordWordSeen(word, true);
      // Reading past a word without a lookup nudges it toward "known".
      applyDifficultyEvent(word, 'skip', jlptLevel);
    });
  };
  // Keep the observer pointed at the latest closure every render.
  finishRef.current = handleFinishArticle;

  const determineAnchor = (e: any) => {
    const y = 'clientY' in e ? e.clientY : (e.touches?.[0]?.clientY || 0);
    // USER: "prefereably drop down from the top unless there is not enough space"
    // We favor Top anchor (Word at bottom half)
    // Threshold biased towards Top: if word is below 38vh, use Top.
    setDrawerAnchor(y > window.innerHeight * 0.38 ? 'top' : 'bottom');
  };

  const handleWordClick = (details: WordDetails, sentText: string, e: any, tokenId: string) => {
    if (touchLock.isLocked()) return;
    if (activeHighlightId === tokenId) {
      setActiveHighlightId(null);
      setSelectedWord(null);
      return;
    }
    determineAnchor(e);
    recordWordSeen(details.word);
    setClickedWords(prev => new Set(prev).add(details.word));

    const cached = wordDatabase[details.word];
    const merged = { ...details, grammarNote: cached?.grammarNote || details.grammarNote };
    setSelectedWord(merged);
    setSelectedSentence(null);
    setActiveHighlightId(tokenId);
    setTargetRect(e.currentTarget.getBoundingClientRect());
    saveWordDefinition(details.word, details);
    // Looking a word up means it wasn't known: nudge its difficulty up.
    applyDifficultyEvent(details.word, 'click', details.jlptLevel);

    if (!merged.grammarNote) {
      fetchWordGrammarInsight(details.word, sentText).then(insight => {
        setSelectedWord(prev => {
          if (!prev || prev.word !== details.word) return prev;
          return { ...prev, grammarNote: insight };
        });
        saveWordDefinition(details.word, { grammarNote: insight });
      });
    }
  };

  const handleDictionaryLookup = async (word: string, contextSentence: string, e: any, tokenId: string, jmdictEntryId?: string) => {
    if (touchLock.isLocked()) return;
    if (activeHighlightId === tokenId) {
      setActiveHighlightId(null);
      setSelectedWord(null);
      return;
    }
    determineAnchor(e);
    recordWordSeen(word);
    setClickedWords(prev => new Set(prev).add(word));
    setSelectedSentence(null);
    
    const localData = wordDatabase[word];
    // Self-healing: If we have local data but it's missing important metadata (JLPT or JMDict ID), 
    // we allow the lookup to proceed to enrich the entry.
    if (localData && localData.meaning && localData.meaning !== 'Implicitly parsed context' && localData.jlptLevel && localData.jmdictEntryId) {
      applyDifficultyEvent(word, 'click', localData.jlptLevel);
      setSelectedWord({
        word,
        reading: localData.reading,
        meaning: localData.meaning,
        grammarNote: localData.grammarNote,
        furiganaMap: localData.furiganaMap,
        jlptLevel: localData.jlptLevel,
        pos: localData.pos,
        jmdictEntryId: localData.jmdictEntryId
      });
      setActiveHighlightId(tokenId);
      setTargetRect(e.currentTarget.getBoundingClientRect());

      if (!localData.grammarNote) {
        fetchWordGrammarInsight(word, contextSentence).then(insight => {
          setSelectedWord(prev => {
            if (!prev || prev.word !== word) return prev;
            return { ...prev, grammarNote: insight };
          });
          saveWordDefinition(word, { grammarNote: insight });
        });
      }
      return;
    }

    setSelectedWord({ 
      word, 
      reading: '...', 
      meaning: '',
      furiganaMap: Array.from(word).map(c => ({ kanji: c, kana: '' })) 
    });
    setSelectedSentence(null);
    setTargetRect(e.currentTarget.getBoundingClientRect());
    setActiveHighlightId(tokenId);
    setIsModalLoading(true);

    try {
      // 1. QUICK PATH (JMDict Instant or Groq Fallback)
      const quickDef = await fetchWordDefinitionQuick(word, contextSentence, jmdictEntryId);
      const combinedInitial: WordDetails = {
        word,
        reading: quickDef.reading || '...',
        meaning: quickDef.meaning || 'Looking up...',
        furiganaMap: quickDef.furiganaMap,
        jlptLevel: quickDef.jlptLevel,
        pos: quickDef.pos,
        jmdictEntryId: quickDef.jmdictEntryId
      };
      setSelectedWord(combinedInitial);
      
      // 2. SMART PATH (Gemini 3 Flash) - Parallel Context Analysis
      fetchWordGrammarInsight(word, contextSentence).then((insight) => {
        setSelectedWord(prev => {
          if (!prev || prev.word !== word) return prev;
          return { ...prev, grammarNote: insight };
        });
        // Cache the full enriched result
        saveWordDefinition(word, { ...combinedInitial, grammarNote: insight });
      });

      // Cache initial quick data
      saveWordDefinition(word, combinedInitial);
      // Now that the JLPT level is known, nudge difficulty up for this lookup.
      applyDifficultyEvent(word, 'click', quickDef.jlptLevel);
      setIsModalLoading(false);
    } catch (err) {
      console.error("Word lookup failed:", err);
      setSelectedWord(prev => (prev && prev.word === word)
        ? { ...prev, reading: '—', meaning: 'Lookup failed. Tap outside to dismiss.', grammarNote: '—' }
        : prev);
      setIsModalLoading(false);
    }
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
    setTargetRect(e.currentTarget.getBoundingClientRect());
    setActiveHighlightId(sentenceId);
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

      return (
        <span 
          key={sentenceId} 
          className={activeHighlightId === sentenceId ? 'sentence-highlight' : ''}
          onDoubleClick={(e) => handleSentenceTranslate(sentText, sentenceId, e)}
        >
          {sentTokens.map((segment, j) => {
            if (segment.furigana || segment.isInteractive) {
              return (
                <FuriganaText
                  key={`${sentenceId}-${j}`}
                  word={segment.text}
                  furigana={segment.furigana}
                  hitWeight={hitWeightFor(segment.text, segment.furigana, wordDatabase[segment.text]?.mastery)}
                  isSelected={activeHighlightId === `${sentenceId}-${j}`}
                  onClick={(e) => {
                    const tid = `${sentenceId}-${j}`;
                    if (segment.details) handleWordClick(segment.details as WordDetails, sentText, e, tid);
                    else handleDictionaryLookup(segment.text, sentText, e, tid, segment.jmdict_entry_id);
                  }}
                />
              );
            }
            if (segmenter) {
              const words = Array.from((segmenter as any).segment(segment.text));
              return words.map((w: any, index: number) => {
                if (!w.isWordLike) return <span key={`${sentenceId}-${j}-${index}`}>{w.segment}</span>;
                const isWide = [...w.segment].length > 2;
                return (
                  <span
                    key={`${sentenceId}-${j}-${index}`}
                    className={activeHighlightId === `${sentenceId}-${j}-${index}` ? 'word-highlight' : ''}
                    onClick={(e) => handleDictionaryLookup(w.segment, sentText, e, `${sentenceId}-${j}-${index}`)}
                    style={{
                      cursor: 'pointer',
                      position: 'relative',
                      ...(isWide
                        ? { paddingLeft: '0.15em', paddingRight: '0.15em', marginLeft: '-0.15em', marginRight: '-0.15em', zIndex: 2 }
                        : { zIndex: 1 }),
                    }}
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

  // Anchor the "read" trigger to the end of the actual reading text — i.e. the last
  // paragraph — so trailing YugenBox keyword/grammar modals don't gate the sweep.
  const lastParagraphIndex = currentArticle
    ? currentArticle.blocks.reduce((acc, b, i) => (b.type === 'paragraph' ? i : acc), -1)
    : -1;

  return (
    <>
      <div className="reading-content fade-in" style={{ paddingBottom: 0, fontSize: `${readerFontSize || 18}px`, fontWeight: readerFontWeight || 500 }}>
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
          let node: React.ReactNode = null;
          if (block.type === 'paragraph') node = <p key={i} style={{ lineHeight: 2.2 }}>{renderParagraph(block, i)}</p>;
          else if (block.type === 'yugen-box') node = <YugenBox key={i} keyword={block.keyword!} reading={block.reading} description={block.description!} />;

          // Drop the end-of-text marker right after the last reading paragraph, so the
          // sweep fires once you've read the article body — trailing keyword/grammar
          // boxes sit below it and don't have to be scrolled past.
          if (i === lastParagraphIndex) {
            return (
              <React.Fragment key={i}>
                {node}
                <div ref={endSentinelRef} aria-hidden="true" style={{ height: 1 }} />
              </React.Fragment>
            );
          }
          return node;
        })}

        {/* Fallback for the rare article with no paragraph blocks at all. */}
        {lastParagraphIndex === -1 && <div ref={endSentinelRef} aria-hidden="true" style={{ height: 1 }} />}

        {/* Restored Tsugihe Capsule Button */}
        <div style={{ textAlign: 'center', marginTop: '4rem', marginBottom: 'calc(2rem + env(safe-area-inset-bottom))' }}>
           <button 
             onClick={() => {
               handleFinishArticle();
               onComplete?.();
             }} 
             style={{ 
               backgroundColor: 'transparent', 
               color: 'var(--text-muted)', 
               padding: '0.75rem 2.5rem', 
               borderRadius: '100px', 
               fontWeight: 600, 
               border: '1px solid var(--border-light)', 
               cursor: 'pointer'
             }}
           >
             <span className="serif" style={{ fontSize: '1.25rem', verticalAlign: 'middle', marginRight: '0.2rem' }}>次へ</span> &rarr;
           </button>
        </div>
      </div>

      <WordModal 
        isOpen={!!selectedWord || !!selectedSentence} 
        onDismissStart={() => {
          setSelectedWord(null);
          setSelectedSentence(null);
          setActiveHighlightId(null);
        }}
        onClose={() => { 
          setSelectedWord(null); 
          setSelectedSentence(null); 
          setActiveHighlightId(null);
          touchLock.lock();
        }} 
        mode={selectedSentence ? 'sentence' : 'word'}
        wordData={selectedWord}
        sentenceText={selectedSentence?.text}
        sentenceTranslation={selectedSentence?.translation}
        anchor={drawerAnchor}
        onSetMastery={handleSetMastery}
        isLoading={isModalLoading}
        targetRect={targetRect}
      />
    </>
  );
}
