import { motion, AnimatePresence } from 'framer-motion';
import { BookOpen, Loader2, Sparkles } from 'lucide-react';
import { useAppStore } from '../services/store';
import { rtkKanjiMap } from '../data/rtkKanji';
import { useEffect, useRef } from 'react';

export interface WordDetails {
  word: string;
  reading: string;
  meaning: string;
  grammarNote?: string;
  furiganaMap?: { kanji: string; kana: string }[];
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onDismissStart?: () => void; 
  mode: 'word' | 'sentence';
  wordData: WordDetails | null;
  sentenceText?: string;
  sentenceTranslation?: string;
  anchor: 'top' | 'bottom';
  onSetMastery?: (level: 'hard' | 'medium' | 'easy') => void;
  isLoading?: boolean;
}

export function WordModal({ 
  isOpen, onClose, onDismissStart, mode, wordData, 
  sentenceText, sentenceTranslation, 
  anchor, onSetMastery, isLoading 
}: Props) {
  const wordDatabase = useAppStore(state => state.wordDatabase);
  const scrollRef = useRef<HTMLDivElement>(null);

  const SYNC_DURATION = 1.05;
  const SYNC_EASE = [0.16, 1, 0.3, 1]; 

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      if (anchor === 'top' && !isLoading && scrollRef.current) {
        setTimeout(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = 9999;
        }, 50);
      }
    } else {
      document.body.style.overflow = 'auto';
    }
    return () => { document.body.style.overflow = 'auto'; };
  }, [isOpen, anchor, isLoading]);

  useEffect(() => {
    if (isOpen && anchor === 'top' && !isLoading && scrollRef.current) {
       scrollRef.current.scrollTop = 9999;
    }
  }, [isLoading, wordData, isOpen, anchor]);

  const renderContent = () => {
    if (mode === 'sentence') {
      return (
        <div style={{ padding: '0.15rem 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.4rem' }}>
            <Sparkles size={13} color="var(--text-muted)" />
            <span style={{ fontSize: '0.65rem', fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.08em' }}>SENTENCE TRANSLATION</span>
          </div>
          <p className="serif" style={{ fontSize: '1.25rem', lineHeight: 1.4, color: 'var(--text-main)', marginBottom: '0.75rem', backgroundColor: 'var(--bg-card)', padding: '0.6rem 0.85rem', borderRadius: '10px' }}>
            {sentenceText}
          </p>
          {isLoading ? (
             <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-muted)' }}>
                <Loader2 className="lucide-spin" size={16} />
                <span style={{ fontSize: '0.85rem' }}>AI 翻訳中...</span>
             </div>
          ) : (
            <p className="sans" style={{ fontSize: '1.1rem', lineHeight: 1.4, color: 'var(--text-main)', paddingLeft: '0.5rem', borderLeft: '3px solid #4a5d23' }}>
              {sentenceTranslation}
            </p>
          )}
        </div>
      );
    }

    if (!wordData) return null;
    const stats = wordDatabase[wordData.word];
    const activeMastery = (!stats || stats.mastery === 'unseen') ? 'medium' : stats.mastery;

    const sections = {
      header: (
        <div key="header" style={{ marginBottom: '0.5rem', display: 'flex', gap: '0.2rem', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: anchor === 'top' ? 'center' : 'flex-start' }}>
          {wordData.furiganaMap ? (
            wordData.furiganaMap.map((fm, idx) => (
              <div key={idx} style={{ 
                display: 'flex', 
                flexDirection: 'column', 
                alignItems: 'center',
                marginRight: idx < wordData.furiganaMap!.length - 1 ? '0.1rem' : 0
              }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', letterSpacing: '0.04em', marginBottom: '0.05rem', fontFamily: 'var(--font-sans)', fontWeight: 700 }}>{fm.kana}</span>
                <span className="serif" style={{ fontSize: '2.5rem', lineHeight: 0.9, color: 'var(--text-main)', fontWeight: 500 }}>{fm.kanji}</span>
                {rtkKanjiMap[fm.kanji] && (
                  <span style={{ fontSize: '0.55rem', color: '#4a5d23', textTransform: 'uppercase', marginTop: '0.15rem', fontFamily: 'var(--font-sans)', fontWeight: 800, letterSpacing: '0.04em' }}>
                    {rtkKanjiMap[fm.kanji]}
                  </span>
                )}
              </div>
            ))
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', letterSpacing: '0.04em', marginBottom: '0.1rem', fontFamily: 'var(--font-sans)', fontWeight: 600 }}>{wordData.reading}</span>
              <div style={{ display: 'flex', gap: '0.2rem', alignItems: 'flex-end' }}>
                {Array.from(wordData.word).map((char, i) => {
                  const keyword = rtkKanjiMap[char];
                  if (!keyword) return <span key={i} className="serif" style={{ fontSize: '2.5rem', lineHeight: 0.9, color: 'var(--text-main)', fontWeight: 500 }}>{char}</span>;
                  return (
                    <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      <span className="serif" style={{ fontSize: '2.5rem', lineHeight: 0.9, color: 'var(--text-main)', fontWeight: 500 }}>{char}</span>
                      <span style={{ fontSize: '0.55rem', color: '#4a5d23', textTransform: 'uppercase', marginTop: '0.15rem', fontFamily: 'var(--font-sans)', fontWeight: 800, letterSpacing: '0.04em' }}>{keyword}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      ),
      translation: (
        <p key="translation" className="serif" style={{ fontSize: '1.2rem', marginBottom: '0.75rem', color: 'var(--text-main)', lineHeight: 1.4, textAlign: anchor === 'top' ? 'center' : 'left' }}>
          <span className="sans" style={{ fontSize: '1rem', verticalAlign: 'middle', marginRight: '0.3rem', color: '#4a5d23', fontWeight: 800 }}>文</span> {wordData.meaning}
        </p>
      ),
      mastery: (
        <div key="mastery" style={{ marginBottom: '1rem' }}>
          <div style={{ display: 'flex', backgroundColor: 'var(--border-light)', borderRadius: '100px', padding: '2px', height: '34px', position: 'relative' }}>
            {(() => {
              const levels = ['easy', 'medium', 'hard'] as const;
              const activeIndex = levels.indexOf((activeMastery || 'medium') as any);
              return (
                <>
                  <div style={{
                    position: 'absolute', top: '2px', bottom: '2px',
                    left: `calc(2px + ${activeIndex} * (100% - 4px) / 3)`,
                    width: `calc((100% - 4px) / 3)`,
                    backgroundColor: 'var(--bg-pure)', borderRadius: '100px',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                    transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)', zIndex: 0
                  }} />
                  {levels.map(level => (
                    <button key={level} onClick={() => onSetMastery?.(level)} style={{ flex: 1, borderRadius: '100px', backgroundColor: 'transparent', color: activeMastery === level ? 'var(--text-main)' : 'var(--text-muted)', fontWeight: activeMastery === level ? 800 : 700, border: 'none', cursor: 'pointer', fontSize: '0.8rem', display: 'flex', justifyContent: 'center', alignItems: 'center', position: 'relative', zIndex: 1, textTransform: 'capitalize' }}>
                      {level}
                    </button>
                  ))}
                </>
              );
            })()}
          </div>
        </div>
      ),
      grammar: wordData.grammarNote && (
        <div key="grammar" style={{ backgroundColor: 'var(--bg-card)', padding: '0.75rem 0.85rem', borderRadius: '10px', borderLeft: '4px solid #4a5d23', marginBottom: '0.75rem' }}>
          <div style={{ fontSize: '0.65rem', fontWeight: 800, color: '#4a5d23', display: 'flex', alignItems: 'center', gap: '0.3rem', marginBottom: '0.3rem', letterSpacing: '0.04em' }}><BookOpen size={11} /> GRAMMAR</div>
          <p className="serif" style={{ color: 'var(--text-main)', fontSize: '1rem', lineHeight: 1.45 }}>{wordData.grammarNote}</p>
        </div>
      ),
      status: stats && stats.timesSeen > 0 && (
        <div key="status" style={{ display: 'flex', gap: '0.5rem', padding: '0.4rem', backgroundColor: 'var(--bg-pure)', border: '1px solid var(--border-light)', borderRadius: '6px', marginBottom: '0.1rem' }}>
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: '0.5rem', color: 'var(--text-muted)' }}>SEEN</div>
            <div style={{ fontSize: '0.9rem', fontWeight: 800, color: 'var(--text-main)' }}>{stats.timesSeen} <span style={{fontSize: '0.65rem', fontWeight: 400}}>x</span></div>
          </div>
          <div style={{ width: '1px', backgroundColor: 'var(--border-light)' }} />
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: '0.5rem', color: 'var(--text-muted)' }}>DAYS</div>
            <div style={{ fontSize: '0.9rem', fontWeight: 800, color: 'var(--text-main)' }}>{stats.uniqueDaysSeen?.length || 1} <span style={{fontSize: '0.65rem', fontWeight: 400}}>d</span></div>
          </div>
          <div style={{ width: '1px', backgroundColor: 'var(--border-light)' }} />
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: '0.5rem', color: 'var(--text-muted)' }}>STATUS</div>
            <div style={{ fontSize: '0.75rem', fontWeight: 800, color: 'var(--text-main)', textTransform: 'capitalize' }}>{activeMastery}</div>
          </div>
        </div>
      )
    };

    const orderedList = [sections.header, sections.translation, sections.mastery, sections.grammar, sections.status];
    
    return (
      <div style={{ 
        display: 'flex', 
        flexDirection: anchor === 'bottom' ? 'column' : 'column-reverse',
        gap: '0.15rem'
      }}>
        {orderedList.map(s => s)}
      </div>
    );
  };

  const executeClose = () => {
    if (onDismissStart) onDismissStart();
    onClose();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div 
            initial={{ opacity: 0 }} 
            animate={{ opacity: 1 }} 
            exit={{ opacity: 0 }} 
            onClick={executeClose}
            transition={{ duration: SYNC_DURATION }}
            style={{ 
              position: 'fixed', 
              top: 0, left: 0, right: 0, bottom: 0, 
              backgroundColor: 'transparent',
              zIndex: 40 
            }}
          />
          <motion.div
            drag="y" 
            dragDirectionLock={true} 
            dragConstraints={{ 
              top: anchor === 'top' ? -1000 : 0, 
              bottom: anchor === 'bottom' ? 1000 : 0,
              left: 0, right: 0
            }} 
            dragElastic={0.08}
            onDragEnd={(_, info) => {
              const vy = info.velocity.y;
              const dy = info.offset.y;
              const shouldClose = anchor === 'bottom' 
                ? (vy > 250 || dy > 40) 
                : (vy < -250 || dy < -40);

              if (shouldClose) {
                executeClose();
              }
            }}
            initial={{ y: anchor === 'bottom' ? '100%' : '-100%' }}
            animate={{ y: 0 }}
            exit={{ y: anchor === 'bottom' ? '120%' : '-120%' }} 
            transition={{ duration: SYNC_DURATION, ease: SYNC_EASE as any }}
            style={{
              position: 'fixed',
              [anchor === 'bottom' ? 'bottom' : 'top']: 0, left: 0, right: 0,
              backgroundColor: 'var(--bg-pure)',
              borderBottomLeftRadius: anchor === 'top' ? '20px' : 0,
              borderBottomRightRadius: anchor === 'top' ? '20px' : 0,
              borderTopLeftRadius: anchor === 'bottom' ? '20px' : 0,
              borderTopRightRadius: anchor === 'bottom' ? '20px' : 0,
              padding: '0.3rem 1.25rem', 
              paddingBottom: 'max(0.4rem, env(safe-area-inset-bottom))',
              zIndex: 50, 
              boxShadow: anchor === 'bottom' ? '0 -10px 40px rgba(0,0,0,0.12)' : '0 10px 40px rgba(0,0,0,0.12)',
              maxHeight: '43vh', 
              overflowY: 'hidden', 
              touchAction: 'none',
              display: 'flex',
              flexDirection: 'column'
            }}
          >
            {anchor === 'bottom' && (
               <div style={{ display: 'flex', justifyContent: 'center', padding: '0.15rem 0 0.3rem 0', cursor: 'grab', flexShrink: 0 }}>
                 <div style={{ width: '28px', height: '3px', backgroundColor: 'var(--border-light)', borderRadius: '2px' }} />
               </div>
            )}

            <div 
              ref={scrollRef}
              className="modal-content-scroller"
              style={{ 
                flex: 1, 
                overflowY: 'auto', 
                touchAction: 'pan-y',
                WebkitOverflowScrolling: 'touch',
                padding: '0 4px'
              }}
              onPointerDown={(e) => {
                 const isAtStart = scrollRef.current?.scrollTop === 0;
                 const isAtEnd = Math.abs((scrollRef.current?.scrollHeight || 0) - (scrollRef.current?.scrollTop || 0) - (scrollRef.current?.clientHeight || 0)) < 1;
                 if (anchor === 'bottom' && isAtStart) return;
                 if (anchor === 'top' && isAtEnd) return;
                 e.stopPropagation();
              }}
            >
              {isLoading && mode === 'word' ? (
                  <div style={{ padding: '0.75rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-muted)' }}>
                      <Loader2 className="lucide-spin" size={16} />
                      <span className="serif" style={{ fontSize: '0.85rem' }}>辞書を引いています...</span>
                    </div>
                  </div>
              ) : renderContent()}
            </div>

            {anchor === 'top' && (
               <div style={{ display: 'flex', justifyContent: 'center', padding: '0.3rem 0 0.15rem 0', cursor: 'grab', flexShrink: 0 }}>
                 <div style={{ width: '28px', height: '3px', backgroundColor: 'var(--border-light)', borderRadius: '2px' }} />
               </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
