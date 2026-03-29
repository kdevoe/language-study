import { motion, AnimatePresence, useMotionValue, useTransform, animate } from 'framer-motion';
import { BookOpen, Loader2, Sparkles } from 'lucide-react';
import { useAppStore } from '../services/store';
import { rtkKanjiMap } from '../data/rtkKanji';
import { useEffect, useRef, useLayoutEffect } from 'react';

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
  mode: 'word' | 'sentence';
  wordData: WordDetails | null;
  sentenceText?: string;
  sentenceTranslation?: string;
  anchor: 'top' | 'bottom';
  onSetMastery?: (level: 'hard' | 'medium' | 'easy') => void;
  isLoading?: boolean;
}

export function WordModal({ 
  isOpen, onClose, mode, wordData, 
  sentenceText, sentenceTranslation, 
  anchor, onSetMastery, isLoading 
}: Props) {
  const wordDatabase = useAppStore(state => state.wordDatabase);
  const y = useMotionValue(0);
  const opacityModal = useTransform(y, [-600, -300, 0, 300, 600], [0, 0.5, 1, 0.5, 0]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Sync animation speeds as requested
  const SYNC_DURATION = 0.65;
  const SYNC_EASE = [0.22, 1, 0.36, 1]; // Gentle, high-end glide

  // ELIMINATE FLASH: Use LayoutEffect to force scroll position before paint
  useLayoutEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      // Preset position to far screen edge
      const startPos = anchor === 'bottom' ? 800 : -800;
      y.set(startPos);
      
      // FORCED SYMMETRICAL ENTRANCE
      animate(y, 0, { duration: SYNC_DURATION, ease: SYNC_EASE as any });

      // Immediate scroll setup to prevent flash of status bar
      if (anchor === 'top' && !isLoading && scrollRef.current) {
        scrollRef.current.scrollTop = 9999;
      }
    } else {
      document.body.style.overflow = 'auto';
    }
  }, [isOpen, anchor, y, isLoading, wordData]);

  // Secondary effect to catch async content loading
  useEffect(() => {
    if (isOpen && anchor === 'top' && !isLoading && scrollRef.current) {
       scrollRef.current.scrollTop = 9999;
    }
  }, [isLoading, wordData, isOpen, anchor]);

  const renderContent = () => {
    if (mode === 'sentence') {
      return (
        <div style={{ padding: '0.5rem 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.25rem' }}>
            <Sparkles size={16} color="var(--text-muted)" />
            <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.1em' }}>SENTENCE TRANSLATION</span>
          </div>
          <p className="serif" style={{ fontSize: '1.4rem', lineHeight: 1.6, color: 'var(--text-main)', marginBottom: '1.5rem', backgroundColor: 'var(--bg-card)', padding: '1rem', borderRadius: '12px' }}>
            {sentenceText}
          </p>
          {isLoading ? (
             <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: 'var(--text-muted)' }}>
                <Loader2 className="lucide-spin" size={20} />
                <span>AI 翻訳中...</span>
             </div>
          ) : (
            <p className="sans" style={{ fontSize: '1.2rem', lineHeight: 1.6, color: 'var(--text-main)', paddingLeft: '0.5rem', borderLeft: '3px solid #4a5d23' }}>
              {sentenceTranslation}
            </p>
          )}
        </div>
      );
    }

    if (!wordData) return null;
    const stats = wordDatabase[wordData.word];
    const activeMastery = (!stats || stats.mastery === 'unseen') ? 'medium' : stats.mastery;
    const wordKanjiArray = Array.from(new Set(wordData.word.split(''))).filter(char => !!rtkKanjiMap[char]);

    const sections = {
      header: (
        <div key="header" style={{ marginBottom: '1.5rem', display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: anchor === 'top' ? 'center' : 'flex-start' }}>
          {wordData.furiganaMap ? (
            wordData.furiganaMap.map((fm, idx) => (
              <div key={idx} style={{ 
                display: 'flex', 
                flexDirection: 'column-reverse', 
                alignItems: 'center',
                marginRight: idx < wordData.furiganaMap!.length - 1 ? '0.2rem' : 0
              }}>
                <span className="serif" style={{ fontSize: '3rem', lineHeight: 1, color: 'var(--text-main)', fontWeight: 500 }}>{fm.kanji}</span>
                <span style={{ fontSize: '0.95rem', color: 'var(--text-muted)', letterSpacing: '0.05em', marginBottom: '0.2rem', fontFamily: 'var(--font-sans)', fontWeight: 600 }}>{fm.kana}</span>
              </div>
            ))
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column-reverse', alignItems: 'center' }}>
              <span className="serif" style={{ fontSize: '3rem', lineHeight: 1.1, color: 'var(--text-main)', fontWeight: 500 }}>{wordData.word}</span>
              <span style={{ fontSize: '1rem', color: 'var(--text-muted)', letterSpacing: '0.05em', marginBottom: '0.4rem', fontFamily: 'var(--font-sans)', fontWeight: 400 }}>{wordData.reading}</span>
            </div>
          )}
        </div>
      ),
      translation: (
        <p key="translation" className="serif" style={{ fontSize: '1.25rem', marginBottom: '2rem', color: 'var(--text-main)', lineHeight: 1.7, textAlign: anchor === 'top' ? 'center' : 'left' }}>
          <span className="sans" style={{ fontSize: '1.25rem', verticalAlign: 'middle', marginRight: '0.5rem', color: '#4a5d23' }}>文</span> {wordData.meaning}
        </p>
      ),
      mastery: (
        <div key="mastery" style={{ marginBottom: '2.5rem' }}>
          <div style={{ display: 'flex', backgroundColor: 'var(--border-light)', borderRadius: '100px', padding: '4px', height: '45px', position: 'relative' }}>
            {(() => {
              const levels = ['easy', 'medium', 'hard'] as const;
              const activeIndex = levels.indexOf((activeMastery || 'medium') as any);
              return (
                <>
                  <div style={{
                    position: 'absolute', top: '4px', bottom: '4px',
                    left: `calc(4px + ${activeIndex} * (100% - 8px) / 3)`,
                    width: `calc((100% - 8px) / 3)`,
                    backgroundColor: 'var(--bg-pure)', borderRadius: '100px',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                    transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)', zIndex: 0
                  }} />
                  {levels.map(level => (
                    <button key={level} onClick={() => onSetMastery?.(level)} style={{ flex: 1, borderRadius: '100px', backgroundColor: 'transparent', color: activeMastery === level ? 'var(--text-main)' : 'var(--text-muted)', fontWeight: activeMastery === level ? 700 : 600, border: 'none', cursor: 'pointer', fontSize: '0.95rem', display: 'flex', justifyContent: 'center', alignItems: 'center', position: 'relative', zIndex: 1, textTransform: 'capitalize' }}>
                      {level}
                    </button>
                  ))}
                </>
              );
            })()}
          </div>
        </div>
      ),
      kanji: wordKanjiArray.length > 0 && (
        <div key="kanji" style={{ marginBottom: '2.5rem' }}>
          <div style={{ textAlign: 'center', fontSize: '0.725rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '1.25rem', letterSpacing: '0.15em' }}>KANJI BREAKDOWN (RTK)</div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'center' }}>
            {wordKanjiArray.map(k => (
              <div key={k} style={{ flex: '0 1 Calc(33% - 0.5rem)', minWidth: '70px', backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-light)', borderRadius: '12px', padding: '1rem 0.5rem', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div className="serif" style={{ fontSize: '1.75rem', color: 'var(--text-main)', marginBottom: '0.5rem', lineHeight: 1.2 }}>{k}</div>
                <div className="sans" style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: 'center', wordBreak: 'break-word' }}>{rtkKanjiMap[k] || 'Unknown'}</div>
              </div>
            ))}
          </div>
        </div>
      ),
      grammar: wordData.grammarNote && (
        <div key="grammar" style={{ backgroundColor: 'var(--bg-card)', padding: '1.5rem', borderRadius: '16px', borderLeft: '4px solid #4a5d23', marginBottom: '2rem' }}>
          <div style={{ fontSize: '0.75rem', fontWeight: 600, color: '#4a5d23', display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem', letterSpacing: '0.05em' }}><BookOpen size={14} /> GRAMMAR NOTE</div>
          <p className="serif" style={{ color: 'var(--text-main)', fontSize: '1.05rem', lineHeight: 1.8 }}>{wordData.grammarNote}</p>
        </div>
      ),
      status: stats && stats.timesSeen > 0 && (
        <div key="status" style={{ display: 'flex', gap: '1rem', padding: '1.25rem 1rem', backgroundColor: 'var(--bg-pure)', border: '1px solid var(--border-light)', borderRadius: '12px', marginBottom: '1rem' }}>
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>SEEN</div>
            <div style={{ fontSize: '1.25rem', fontWeight: 600, color: 'var(--text-main)', marginTop: '0.25rem' }}>{stats.timesSeen} <span style={{fontSize: '0.85rem', fontWeight: 400}}>x</span></div>
          </div>
          <div style={{ width: '1px', backgroundColor: 'var(--border-light)' }} />
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>DAYS</div>
            <div style={{ fontSize: '1.25rem', fontWeight: 600, color: 'var(--text-main)', marginTop: '0.25rem' }}>{stats.uniqueDaysSeen?.length || 1} <span style={{fontSize: '0.85rem', fontWeight: 400}}>d</span></div>
          </div>
          <div style={{ width: '1px', backgroundColor: 'var(--border-light)' }} />
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>STATUS</div>
            <div style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-main)', marginTop: '0.5rem', textTransform: 'capitalize' }}>{activeMastery}</div>
          </div>
        </div>
      )
    };

    const orderedList = [sections.header, sections.translation, sections.mastery, sections.kanji, sections.grammar, sections.status];
    
    return (
      <div style={{ 
        display: 'flex', 
        flexDirection: anchor === 'bottom' ? 'column' : 'column-reverse',
        gap: '0.5rem'
      }}>
        {orderedList.map(s => s)}
      </div>
    );
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div 
            initial={{ opacity: 0 }} 
            animate={{ opacity: 1 }} 
            exit={{ opacity: 0 }} 
            onClick={onClose}
            transition={{ duration: 0.6 }}
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
                const targetY = anchor === 'bottom' ? 800 : -800;
                animate(y, targetY, { duration: SYNC_DURATION, ease: SYNC_EASE as any }).then(() => onClose());
              } else {
                animate(y, 0, { type: 'spring', damping: 25, stiffness: 350 });
              }
            }}
            exit={{ y: anchor === 'bottom' ? 800 : -800 }}
            transition={{ duration: SYNC_DURATION, ease: SYNC_EASE as any }}
            style={{
              y, opacity: opacityModal,
              position: 'fixed',
              [anchor === 'bottom' ? 'bottom' : 'top']: 0, left: 0, right: 0,
              backgroundColor: 'var(--bg-pure)',
              borderBottomLeftRadius: anchor === 'top' ? '32px' : 0,
              borderBottomRightRadius: anchor === 'top' ? '32px' : 0,
              borderTopLeftRadius: anchor === 'bottom' ? '32px' : 0,
              borderTopRightRadius: anchor === 'bottom' ? '32px' : 0,
              padding: '1rem 1.75rem', 
              paddingBottom: 'max(2rem, env(safe-area-inset-bottom))',
              zIndex: 50, 
              boxShadow: anchor === 'bottom' ? '0 -10px 40px rgba(0,0,0,0.12)' : '0 10px 40px rgba(0,0,0,0.12)',
              maxHeight: '45vh', 
              overflowY: 'hidden', 
              touchAction: 'none',
              display: 'flex',
              flexDirection: 'column'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'center', padding: '1rem 0', cursor: 'grab', flexShrink: 0 }}>
              <div style={{ width: '40px', height: '4px', backgroundColor: 'var(--border-light)', borderRadius: '2px' }} />
            </div>

            <div 
              ref={scrollRef}
              className="modal-content-scroller"
              style={{ 
                flex: 1, 
                overflowY: 'auto', 
                touchAction: 'pan-y',
                WebkitOverflowScrolling: 'touch',
                // Padded to ensure highlight spills don't clip at top/bottom of scroll
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
                  <div style={{ padding: '2rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: 'var(--text-muted)' }}>
                      <Loader2 className="lucide-spin" size={24} />
                      <span className="serif" style={{ fontSize: '1.1rem' }}>辞書を引いています...</span>
                    </div>
                  </div>
              ) : renderContent()}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
