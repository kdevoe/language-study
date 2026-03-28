import { motion, AnimatePresence, useMotionValue, useTransform, animate } from 'framer-motion';
import { X, BookOpen, Loader2 } from 'lucide-react';
import { useAppStore } from '../services/store';
import { rtkKanjiMap } from '../data/rtkKanji';
import { useEffect } from 'react';

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
  wordData: WordDetails | null;
  onSetMastery?: (level: 'hard' | 'medium' | 'easy') => void;
  isLoading?: boolean;
}

export function WordModal({ isOpen, onClose, wordData, onSetMastery, isLoading }: Props) {
  const wordDatabase = useAppStore(state => state.wordDatabase);
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-400, 0, 400], [-15, 0, 15]);
  const opacityModal = useTransform(x, [-400, -200, 0, 200, 400], [0, 0.5, 1, 0.5, 0]);

  // CRITICAL: Prevent background body scroll when modal is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      x.set(0); 
    } else {
      document.body.style.overflow = 'auto';
    }
    return () => {
      document.body.style.overflow = 'auto';
    };
  }, [isOpen, x]);
  
  if (!wordData) return null;
  const stats = wordDatabase[wordData.word];
  const activeMastery = (!stats || stats.mastery === 'unseen') ? 'medium' : stats.mastery;
  
  const wordKanjiArray = Array.from(new Set(wordData.word.split(''))).filter(char => !!rtkKanjiMap[char]);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            style={{
              position: 'fixed',
              top: 0, left: 0, right: 0, bottom: 0,
              backgroundColor: 'rgba(245, 245, 240, 0.7)',
              backdropFilter: 'blur(5px)',
              zIndex: 40
            }}
          />
          <motion.div
            drag="x"
            dragDirectionLock={true}
            dragConstraints={{ left: -1000, right: 1000, top: 0, bottom: 0 }}
            dragElastic={0.9}
            style={{
              x,
              rotate,
              opacity: opacityModal,
              position: 'fixed',
              bottom: 0, left: 0, right: 0,
              backgroundColor: 'var(--bg-pure)',
              borderTopLeftRadius: '32px',
              borderTopRightRadius: '32px',
              padding: '2rem 1.75rem',
              paddingBottom: 'max(2rem, env(safe-area-inset-bottom))',
              zIndex: 50,
              boxShadow: '0 -10px 40px rgba(0,0,0,0.06)',
              maxHeight: '92vh',
              overflowY: 'auto',
              touchAction: 'pan-y'
            }}
            onDragEnd={(_, info) => {
              const isFlick = Math.abs(info.velocity.x) > 500;
              const isDragged = Math.abs(info.offset.x) > 160;

              if (isFlick || isDragged) {
                // Determine fly-away direction
                const targetX = info.offset.x > 0 ? 600 : -600;
                
                // Snap it away quickly, then trigger logical close
                animate(x, targetX, { 
                  duration: 0.2,
                  ease: "easeOut"
                }).then(() => {
                  onClose();
                });
              } else {
                // Snappy snap-back to center
                animate(x, 0, { 
                  type: 'spring', 
                  damping: 18, 
                  stiffness: 350 
                });
              }
            }}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 250 }}
          >
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '2rem' }}>
              <div style={{ width: '48px', height: '4px', backgroundColor: 'var(--border-light)', borderRadius: '2px' }} />
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: '0.75rem', letterSpacing: '0.15em', color: 'var(--text-muted)', marginBottom: '1rem', fontWeight: 500 }}>
                  WORD DETAILS
                </div>
                
                {isLoading ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
                    <Loader2 className="lucide-spin" size={20} />
                    <span className="serif">辞書を引いています...</span>
                  </div>
                ) : (
                  <div style={{ marginBottom: '1.5rem', display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    {wordData.furiganaMap ? (
                      wordData.furiganaMap.map((fm, idx) => (
                        <div key={idx} style={{ display: 'flex', flexDirection: 'column-reverse', alignItems: 'center' }}>
                          <span className="serif" style={{ fontSize: '3rem', lineHeight: 1.1, color: 'var(--text-main)', fontWeight: 500 }}>
                            {fm.kanji}
                          </span>
                          <span style={{ fontSize: '1rem', color: 'var(--text-muted)', letterSpacing: '0.05em', marginBottom: '0.4rem', fontFamily: 'var(--font-sans)', fontWeight: 400 }}>
                            {fm.kana}
                          </span>
                        </div>
                      ))
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column-reverse', alignItems: 'center' }}>
                        <span className="serif" style={{ fontSize: '3rem', lineHeight: 1.1, color: 'var(--text-main)', fontWeight: 500 }}>
                          {wordData.word}
                        </span>
                        <span style={{ fontSize: '1rem', color: 'var(--text-muted)', letterSpacing: '0.05em', marginBottom: '0.4rem', fontFamily: 'var(--font-sans)', fontWeight: 400 }}>
                          {wordData.reading}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
              <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-main)', cursor: 'pointer', padding: '0.5rem', marginTop: '-0.5rem', marginRight: '-0.5rem' }}>
                <X size={24} strokeWidth={1.5} />
              </button>
            </div>

            {!isLoading && (
              <p className="serif" style={{ fontSize: '1.25rem', marginBottom: '2rem', color: 'var(--text-main)', lineHeight: 1.7 }}>
                <span className="sans" style={{ fontSize: '1.25rem', verticalAlign: 'middle', marginRight: '0.5rem' }}>文</span> 
                {wordData.meaning}
              </p>
            )}

            {!isLoading && wordData.grammarNote && (
              <div style={{ 
                backgroundColor: 'var(--bg-card)', 
                padding: '1.5rem', 
                borderRadius: '16px',
                borderLeft: '4px solid var(--text-main)',
                marginBottom: '2rem'
              }}>
                <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem', letterSpacing: '0.05em' }}>
                  <BookOpen size={14} /> GRAMMAR NOTE
                </div>
                <p className="serif" style={{ color: 'var(--text-main)', fontSize: '1.05rem', lineHeight: 1.8 }}>
                  {wordData.grammarNote}
                </p>
              </div>
            )}
            
            {!isLoading && wordKanjiArray.length > 0 && (
              <div style={{ marginBottom: '2.5rem' }}>
                <div style={{ textAlign: 'center', fontSize: '0.725rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '1.25rem', letterSpacing: '0.15em' }}>
                  KANJI BREAKDOWN (RTK)
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'center' }}>
                  {wordKanjiArray.map(k => (
                    <div key={k} style={{ 
                      flex: '0 1 Calc(33% - 0.5rem)', 
                      minWidth: '70px',
                      backgroundColor: 'var(--bg-card)', 
                      border: '1px solid var(--border-light)', 
                      borderRadius: '12px', 
                      padding: '1rem 0.5rem', 
                      display: 'flex', 
                      flexDirection: 'column', 
                      alignItems: 'center',
                    }}>
                      <div className="serif" style={{ fontSize: '1.75rem', color: 'var(--text-main)', marginBottom: '0.5rem', lineHeight: 1.2 }}>{k}</div>
                      <div className="sans" style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: 'center', wordBreak: 'break-word' }}>
                        {rtkKanjiMap[k] || 'Unknown'}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!isLoading && (
              <div style={{ marginBottom: '2.5rem' }}>
                <div style={{ display: 'flex', backgroundColor: 'var(--border-light)', borderRadius: '100px', padding: '4px', height: '45px', position: 'relative' }}>
                  {(() => {
                    const levels = ['easy', 'medium', 'hard'] as const;
                    const activeIndex = levels.indexOf((activeMastery || 'medium') as any);
                    
                    return (
                      <>
                        <div style={{
                          position: 'absolute',
                          top: '4px',
                          bottom: '4px',
                          left: `calc(4px + ${activeIndex} * (100% - 8px) / 3)`,
                          width: `calc((100% - 8px) / 3)`,
                          backgroundColor: 'var(--bg-pure)',
                          borderRadius: '100px',
                          boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                          transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                          zIndex: 0
                        }} />

                        {levels.map(level => {
                          const isSelected = activeMastery === level;
                          return (
                            <button
                              key={level}
                              onClick={() => { onSetMastery?.(level); }}
                              style={{
                                flex: 1,
                                borderRadius: '100px',
                                backgroundColor: 'transparent',
                                color: isSelected ? 'var(--text-main)' : 'var(--text-muted)',
                                fontWeight: isSelected ? 700 : 600,
                                border: 'none',
                                outline: 'none',
                                cursor: 'pointer',
                                transition: 'color 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                                fontSize: '0.95rem',
                                display: 'flex',
                                justifyContent: 'center',
                                alignItems: 'center',
                                position: 'relative',
                                zIndex: 1,
                                textTransform: 'capitalize'
                              }}
                            >
                              {level}
                            </button>
                          );
                        })}
                      </>
                    );
                  })()}
                </div>
              </div>
            )}

            {!isLoading && stats && stats.timesSeen > 0 && (
              <div style={{ display: 'flex', gap: '1rem', padding: '1.25rem 1rem', backgroundColor: 'var(--bg-pure)', border: '1px solid var(--border-light)', borderRadius: '12px' }}>
                <div style={{ flex: 1, textAlign: 'center' }}>
                  <div style={{ fontSize: '0.65rem', letterSpacing: '0.1em', color: 'var(--text-muted)' }}>SEEN</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 600, color: 'var(--text-main)', fontFamily: 'var(--font-sans)', marginTop: '0.25rem' }}>
                    {stats.timesSeen} <span style={{fontSize: '0.85rem', fontWeight: 400}}>x</span>
                  </div>
                </div>
                <div style={{ width: '1px', backgroundColor: 'var(--border-light)' }} />
                <div style={{ flex: 1, textAlign: 'center' }}>
                  <div style={{ fontSize: '0.65rem', letterSpacing: '0.1em', color: 'var(--text-muted)' }}>DAYS</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 600, color: 'var(--text-main)', fontFamily: 'var(--font-sans)', marginTop: '0.25rem' }}>
                    {stats.uniqueDaysSeen?.length || 1} <span style={{fontSize: '0.85rem', fontWeight: 400}}>d</span>
                  </div>
                </div>
                <div style={{ width: '1px', backgroundColor: 'var(--border-light)' }} />
                <div style={{ flex: 1, textAlign: 'center' }}>
                  <div style={{ fontSize: '0.65rem', letterSpacing: '0.1em', color: 'var(--text-muted)' }}>STATUS</div>
                  <div style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-main)', fontFamily: 'var(--font-sans)', marginTop: '0.5rem', textTransform: 'capitalize' }}>
                    {activeMastery}
                  </div>
                </div>
              </div>
            )}
            
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
