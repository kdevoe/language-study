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
        <div style={{ padding: '0.1rem 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.5rem' }}>
            <Sparkles size={13} color="var(--text-muted)" />
            <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.1em' }}>AI SENTENCE ANALYSIS</span>
          </div>
          <p className="serif" style={{ fontSize: '1.25rem', lineHeight: 1.45, color: 'var(--text-main)', marginBottom: '0.85rem', backgroundColor: 'var(--bg-card)', padding: '0.75rem 1rem', borderRadius: '12px' }}>
            {sentenceText}
          </p>
          {isLoading ? (
             <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', color: 'var(--text-muted)' }}>
                <Loader2 className="lucide-spin" size={18} />
                <span style={{ fontSize: '0.9rem' }}>解釈中...</span>
             </div>
          ) : (
            <p className="sans" style={{ fontSize: '1.1rem', lineHeight: 1.45, color: 'var(--text-main)', paddingLeft: '0.6rem', borderLeft: '4px solid #4a5d23' }}>
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
        <div key="header" style={{ 
          marginBottom: '0.85rem', 
          display: 'flex', 
          gap: '1.5rem', // EVEN WIDER SPREAD
          flexWrap: 'wrap', 
          alignItems: 'flex-end', 
          justifyContent: anchor === 'top' ? 'center' : 'flex-start' 
        }}>
          {wordData.furiganaMap ? (
            wordData.furiganaMap.map((fm, idx) => (
              <div key={idx} style={{ 
                display: 'flex', 
                flexDirection: 'column', 
                alignItems: 'center'
              }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', letterSpacing: '0.04em', marginBottom: '0.1rem', fontFamily: 'var(--font-sans)', fontWeight: 800 }}>{fm.kana}</span>
                <span className="serif" style={{ fontSize: '2.8rem', lineHeight: 0.85, color: 'var(--text-main)', fontWeight: 500 }}>{fm.kanji}</span>
                {rtkKanjiMap[fm.kanji] && (
                  <span style={{ fontSize: '0.6rem', color: '#4a5d23', textTransform: 'uppercase', marginTop: '0.25rem', fontFamily: 'var(--font-sans)', fontWeight: 800, letterSpacing: '0.04em' }}>
                    {rtkKanjiMap[fm.kanji]}
                  </span>
                )}
              </div>
            ))
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
              {/* If no map, we use wide letter-spacing to align with the spread kanji as a single unit or try to span */}
              <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', letterSpacing: '0.3em', marginBottom: '0.2rem', fontFamily: 'var(--font-sans)', fontWeight: 800, textAlign: 'center', paddingLeft: '0.3em' }}>{wordData.reading}</span>
              <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'flex-end', justifyContent: 'center' }}>
                {Array.from(wordData.word).map((char, i) => {
                  const keyword = rtkKanjiMap[char];
                  return (
                    <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      <span className="serif" style={{ fontSize: '2.8rem', lineHeight: 0.85, color: 'var(--text-main)', fontWeight: 500 }}>{char}</span>
                      {keyword && (
                        <span style={{ fontSize: '0.6rem', color: '#4a5d23', textTransform: 'uppercase', marginTop: '0.25rem', fontFamily: 'var(--font-sans)', fontWeight: 800, letterSpacing: '0.04em' }}>{keyword}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      ),
      translation: (
        <p key="translation" className="serif" style={{ fontSize: '1.25rem', marginBottom: '1.25rem', color: 'var(--text-main)', lineHeight: 1.5, textAlign: anchor === 'top' ? 'center' : 'left' }}>
          <span className="sans" style={{ fontSize: '1.1rem', verticalAlign: 'middle', marginRight: '0.4rem', color: '#4a5d23', fontWeight: 900 }}>文</span> {wordData.meaning}
        </p>
      ),
      mastery: (
        <div key="mastery" style={{ marginBottom: '1.5rem' }}>
          {/* BIGGER BUTTONS: increased height to 42px and padding */}
          <div style={{ display: 'flex', backgroundColor: 'var(--border-light)', borderRadius: '100px', padding: '4px', height: '42px', position: 'relative' }}>
            {(() => {
              const levels = ['easy', 'medium', 'hard'] as const;
              const activeIndex = levels.indexOf((activeMastery || 'medium') as any);
              return (
                <>
                  <motion.div 
                    initial={false}
                    animate={{ left: `calc(4px + ${activeIndex} * (100% - 8px) / 3)` }}
                    transition={{ type: "spring", stiffness: 300, damping: 30 }}
                    style={{
                      position: 'absolute', top: '4px', bottom: '4px',
                      width: `calc((100% - 8px) / 3)`,
                      backgroundColor: 'var(--bg-pure)', borderRadius: '100px',
                      boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
                      zIndex: 0
                    }} 
                  />
                  {levels.map(level => (
                    <button key={level} onClick={() => onSetMastery?.(level)} style={{ flex: 1, borderRadius: '100px', backgroundColor: 'transparent', color: activeMastery === level ? 'var(--text-main)' : 'var(--text-muted)', fontWeight: activeMastery === level ? 800 : 700, border: 'none', cursor: 'pointer', fontSize: '0.9rem', display: 'flex', justifyContent: 'center', alignItems: 'center', position: 'relative', zIndex: 1, textTransform: 'uppercase' }}>
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
        <div key="grammar" style={{ backgroundColor: 'var(--bg-card)', padding: '1rem', borderRadius: '14px', borderLeft: '5px solid #4a5d23', marginBottom: '1rem' }}>
          <div style={{ fontSize: '0.7rem', fontWeight: 900, color: '#4a5d23', display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', letterSpacing: '0.05em' }}><BookOpen size={13} /> GRAMMAR INSIGHT</div>
          <p className="serif" style={{ color: 'var(--text-main)', fontSize: '1.05rem', lineHeight: 1.5 }}>{wordData.grammarNote}</p>
        </div>
      ),
      status: stats && stats.timesSeen > 0 && (
        <div key="status" style={{ display: 'flex', gap: '0.5rem', padding: '0.5rem', backgroundColor: 'var(--bg-pure)', border: '1px solid var(--border-light)', borderRadius: '10px', marginBottom: '0.25rem' }}>
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: '0.55rem', color: 'var(--text-muted)', fontWeight: 700 }}>SEEN</div>
            <div style={{ fontSize: '1rem', fontWeight: 900, color: 'var(--text-main)' }}>{stats.timesSeen} <span style={{fontSize: '0.75rem', fontWeight: 400}}>x</span></div>
          </div>
          <div style={{ width: '1px', backgroundColor: 'var(--border-light)' }} />
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: '0.55rem', color: 'var(--text-muted)', fontWeight: 700 }}>DAYS</div>
            <div style={{ fontSize: '1rem', fontWeight: 900, color: 'var(--text-main)' }}>{stats.uniqueDaysSeen?.length || 1} <span style={{fontSize: '0.75rem', fontWeight: 400}}>d</span></div>
          </div>
          <div style={{ width: '1px', backgroundColor: 'var(--border-light)' }} />
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: '0.55rem', color: 'var(--text-muted)', fontWeight: 700 }}>RANK</div>
            <div style={{ fontSize: '0.85rem', fontWeight: 900, color: 'var(--text-main)', textTransform: 'capitalize' }}>{activeMastery}</div>
          </div>
        </div>
      )
    };

    const orderedList = [sections.header, sections.translation, sections.mastery, sections.grammar, sections.status];
    
    return (
      <div style={{ 
        display: 'flex', 
        flexDirection: anchor === 'bottom' ? 'column' : 'column-reverse'
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
              borderBottomLeftRadius: anchor === 'top' ? '24px' : 0,
              borderBottomRightRadius: anchor === 'top' ? '24px' : 0,
              borderTopLeftRadius: anchor === 'bottom' ? '24px' : 0,
              borderTopRightRadius: anchor === 'bottom' ? '24px' : 0,
              padding: '0.2rem 1.5rem', 
              /* SHAVED BOTTOM WHITE SPACE: removed large fixed paddings and safe-area margin for the top anchor */
              paddingBottom: anchor === 'bottom' ? 'max(0.75rem, env(safe-area-inset-bottom))' : '0.5rem',
              zIndex: 50, 
              boxShadow: anchor === 'bottom' ? '0 -10px 40px rgba(0,0,0,0.12)' : '0 10px 40px rgba(0,0,0,0.12)',
              /* ADAPTIVE HEIGHT: heights now fits content while capping at 54vh */
              height: 'auto',
              maxHeight: '54vh', 
              overflowY: 'hidden', 
              touchAction: 'none',
              display: 'flex',
              flexDirection: 'column'
            }}
          >
            {anchor === 'bottom' && (
               <div style={{ display: 'flex', justifyContent: 'center', padding: '0.4rem 0 0.8rem 0', cursor: 'grab', flexShrink: 0 }}>
                 <div style={{ width: '32px', height: '4px', backgroundColor: 'var(--border-light)', borderRadius: '2px' }} />
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
                  <div style={{ padding: '1rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-muted)' }}>
                      <Loader2 className="lucide-spin" size={18} />
                      <span className="serif" style={{ fontSize: '0.9rem' }}>辞書を引いています...</span>
                    </div>
                  </div>
              ) : renderContent()}
            </div>

            {anchor === 'top' && (
               <div style={{ display: 'flex', justifyContent: 'center', padding: '0.8rem 0 0.4rem 0', cursor: 'grab', flexShrink: 0 }}>
                 <div style={{ width: '32px', height: '4px', backgroundColor: 'var(--border-light)', borderRadius: '2px' }} />
               </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
