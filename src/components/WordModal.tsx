
import { motion, AnimatePresence } from 'framer-motion';
import { X, BookOpen, Loader2 } from 'lucide-react';
import { useAppStore } from '../services/store';
import { rtkKanjiMap } from '../data/rtkKanji';

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
  
  if (!wordData) return null;
  const stats = wordDatabase[wordData.word];
  
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
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 28, stiffness: 220 }}
            style={{
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
              overflowY: 'auto'
            }}
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
                  <div style={{ marginBottom: '1.5rem', display: 'flex', gap: '0.2rem' }}>
                    {wordData.furiganaMap ? (
                      wordData.furiganaMap.map((fm, idx) => (
                        <ruby key={idx} style={{ rubyAlign: 'center', cursor: 'default', borderBottom: 'none' }}>
                          <span className="serif" style={{ fontSize: '3.5rem', lineHeight: 1.1, color: 'var(--text-main)', fontWeight: 500 }}>
                            {fm.kanji}
                          </span>
                          <rt style={{ opacity: 1, transform: 'none', fontSize: '1.1rem', color: 'var(--text-muted)', letterSpacing: '0.05em', paddingBottom: '0.25rem', fontFamily: 'var(--font-sans)', fontWeight: 400 }}>
                            {fm.kana}
                          </rt>
                        </ruby>
                      ))
                    ) : (
                      <ruby style={{ rubyAlign: 'center', cursor: 'default', borderBottom: 'none' }}>
                        <span className="serif" style={{ fontSize: '3.5rem', lineHeight: 1.1, color: 'var(--text-main)', fontWeight: 500 }}>
                          {wordData.word}
                        </span>
                        <rt style={{ opacity: 1, transform: 'none', fontSize: '1.1rem', color: 'var(--text-muted)', letterSpacing: '0.05em', paddingBottom: '0.25rem', fontFamily: 'var(--font-sans)', fontWeight: 400 }}>
                          {wordData.reading}
                        </rt>
                      </ruby>
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
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button onClick={() => { onSetMastery?.('hard'); onClose(); }} style={{ flex: 1, padding: '1rem 0.25rem', borderRadius: '100px', border: stats?.mastery === 'hard' ? '2px solid var(--text-main)' : '1px solid var(--border-light)', backgroundColor: stats?.mastery === 'hard' ? 'var(--text-main)' : 'transparent', color: stats?.mastery === 'hard' ? 'var(--bg-pure)' : 'var(--text-main)', fontSize: '0.95rem', fontWeight: 500, cursor: 'pointer', transition: 'all 0.2s' }}>
                    Hard
                  </button>
                  <button onClick={() => { onSetMastery?.('medium'); onClose(); }} style={{ flex: 1, padding: '1rem 0.25rem', borderRadius: '100px', border: stats?.mastery === 'medium' ? '2px solid var(--text-main)' : '1px solid var(--border-light)', backgroundColor: stats?.mastery === 'medium' ? 'var(--text-main)' : 'transparent', color: stats?.mastery === 'medium' ? 'var(--bg-pure)' : 'var(--text-main)', fontSize: '0.95rem', fontWeight: 500, cursor: 'pointer', transition: 'all 0.2s' }}>
                    Medium
                  </button>
                  <button onClick={() => { onSetMastery?.('easy'); onClose(); }} style={{ flex: 1, padding: '1rem 0.25rem', borderRadius: '100px', border: stats?.mastery === 'easy' ? '2px solid var(--text-main)' : '1px solid var(--border-light)', backgroundColor: stats?.mastery === 'easy' ? 'var(--accent-success)' : 'transparent', color: stats?.mastery === 'easy' ? 'var(--bg-pure)' : 'var(--text-main)', fontSize: '0.95rem', fontWeight: 500, cursor: 'pointer', transition: 'all 0.2s' }}>
                    Easy
                  </button>
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
                    {stats.mastery}
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
