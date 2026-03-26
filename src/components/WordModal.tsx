
import { motion, AnimatePresence } from 'framer-motion';
import { X, Star, CheckCircle, Eye, BookOpen, Loader2 } from 'lucide-react';
import { useAppStore } from '../services/store';

export interface WordDetails {
  word: string;
  reading: string;
  meaning: string;
  grammarNote?: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  wordData: WordDetails | null;
  onSetMastery?: (level: 'hard' | 'easy' | 'known') => void;
  isLoading?: boolean;
}

export function WordModal({ isOpen, onClose, wordData, onSetMastery, isLoading }: Props) {
  const wordDatabase = useAppStore(state => state.wordDatabase);
  
  if (!wordData) return null;
  const stats = wordDatabase[wordData.word];

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
                <div style={{ fontSize: '0.75rem', letterSpacing: '0.15em', color: 'var(--text-muted)', marginBottom: '0.5rem', fontWeight: 500 }}>
                  WORD DETAILS
                </div>
                <h2 className="serif" style={{ fontSize: '3rem', lineHeight: 1.1, marginBottom: '0.5rem', color: 'var(--text-main)', fontWeight: 500 }}>
                  {wordData.word}
                </h2>
                
                {isLoading ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: 'var(--text-muted)', marginTop: '1rem', marginBottom: '2rem' }}>
                    <Loader2 className="lucide-spin" size={20} />
                    <span className="serif">辞書を引いています...</span>
                  </div>
                ) : (
                  <>
                    <div style={{ color: 'var(--text-muted)', letterSpacing: '0.15em', fontSize: '0.85rem', marginBottom: '1.5rem', textTransform: 'uppercase' }}>
                      {wordData.reading}
                    </div>
                  </>
                )}
              </div>
              <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-main)', cursor: 'pointer', padding: '0.5rem' }}>
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
                marginBottom: '2.5rem'
              }}>
                <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem', letterSpacing: '0.05em' }}>
                  <BookOpen size={14} /> GRAMMAR NOTE
                </div>
                <p className="serif" style={{ color: 'var(--text-main)', fontSize: '1.05rem', lineHeight: 1.8 }}>
                  {wordData.grammarNote}
                </p>
              </div>
            )}
            
            {!isLoading && stats && stats.timesSeen > 0 && (
              <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem', marginBottom: '1.5rem', padding: '1rem', backgroundColor: 'var(--bg-card)', borderRadius: '12px' }}>
                <div style={{ flex: 1, textAlign: 'center' }}>
                  <div style={{ fontSize: '0.75rem', letterSpacing: '0.1em', color: 'var(--text-muted)' }}>SEEN</div>
                  <div style={{ fontSize: '1.5rem', fontWeight: 600, color: 'var(--text-main)', fontFamily: 'var(--font-sans)', marginTop: '0.25rem' }}>
                    {stats.timesSeen} <span style={{fontSize: '0.85rem', fontWeight: 400}}>x</span>
                  </div>
                </div>
                <div style={{ width: '1px', backgroundColor: 'var(--border-light)' }} />
                <div style={{ flex: 1, textAlign: 'center' }}>
                  <div style={{ fontSize: '0.75rem', letterSpacing: '0.1em', color: 'var(--text-muted)' }}>DAYS STUDIED</div>
                  <div style={{ fontSize: '1.5rem', fontWeight: 600, color: 'var(--text-main)', fontFamily: 'var(--font-sans)', marginTop: '0.25rem' }}>
                    {stats.uniqueDaysSeen?.length || 1} <span style={{fontSize: '0.85rem', fontWeight: 400}}>d</span>
                  </div>
                </div>
              </div>
            )}

            {!isLoading && (
              <div style={{ marginTop: '2rem' }}>
                <div style={{ textAlign: 'center', fontSize: '0.75rem', letterSpacing: '0.15em', color: 'var(--text-muted)', marginBottom: '1.25rem', fontWeight: 500 }}>
                  SET MASTERY
                </div>
              <div style={{ display: 'flex', gap: '0.75rem', flexDirection: 'column' }}>
                <button onClick={() => { onSetMastery?.('hard'); onClose(); }} style={{ padding: '1.125rem', borderRadius: '100px', border: '1px solid var(--border-light)', backgroundColor: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.75rem', fontSize: '1rem', fontWeight: 500, cursor: 'pointer', color: 'var(--text-main)', transition: 'background-color 0.2s' }}>
                  <Star size={18} /> Hard
                </button>
                <div style={{ display: 'flex', gap: '0.75rem' }}>
                  <button onClick={() => { onSetMastery?.('easy'); onClose(); }} style={{ flex: 1, padding: '1.125rem', borderRadius: '100px', border: 'none', backgroundColor: 'var(--accent-success)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.75rem', fontSize: '1rem', fontWeight: 500, cursor: 'pointer', color: 'var(--text-main)', transition: 'opacity 0.2s' }}>
                    <CheckCircle size={18} /> Easy
                  </button>
                  <button onClick={() => { onSetMastery?.('known'); onClose(); }} style={{ flex: 1, padding: '1.125rem', borderRadius: '100px', border: '1px solid var(--border-light)', backgroundColor: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.75rem', fontSize: '1rem', fontWeight: 500, cursor: 'pointer', color: 'var(--text-main)', transition: 'background-color 0.2s' }}>
                    <Eye size={18} /> Known
                  </button>
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
