import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, Trash2 } from 'lucide-react';
import { NewsArticle } from '../services/api';

interface Props {
  articles: NewsArticle[];
  onSelect: (article: NewsArticle) => void;
  onDismiss: (id: string) => void;
  isLoading: boolean;
  processingIds: string[];
  cachedIds: string[];
}

export function Feed({ articles, onSelect, onDismiss, isLoading, processingIds, cachedIds }: Props) {
  const container = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: { staggerChildren: 0.08 }
    }
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] as any } },
    exit: { opacity: 0, scale: 0.95, transition: { duration: 0.2 } }
  };

  if (isLoading && articles.length === 0) {
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1.5rem', padding: '2rem 0' }}>
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="shimmer" style={{ width: '100%', height: '140px', borderRadius: '24px' }} />
        ))}
      </div>
    );
  }

  return (
    <motion.div
      variants={container}
      initial="hidden"
      animate="show"
      style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', paddingBottom: '8rem' }}
    >
      <AnimatePresence mode="popLayout">
        {articles.map((article) => {
          const isProcessing = article.id && (processingIds || []).includes(article.id);
          const isCached = article.id && (cachedIds || []).includes(article.id);


          return (
            <motion.div
              key={article.id}
              variants={itemVariants}
              layout
              exit="exit"
              drag="x"
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0.6}
              dragMomentum={false}
              onDragEnd={(_, info) => {
                if (info.offset.x > 80 && article.id) {
                  onDismiss(article.id);
                }
              }}
              style={{ position: 'relative', touchAction: 'pan-y' }}
            >
              {/* Swipe Action Background Indicator */}
              <div style={{ 
                position: 'absolute', 
                left: 0, 
                top: 0, 
                bottom: 0, 
                width: '100%', 
                backgroundColor: isCached ? 'rgba(74, 93, 35, 0.08)' : 'rgba(180, 10, 10, 0.08)', 
                borderRadius: '24px',
                display: 'flex',
                alignItems: 'center',
                paddingLeft: '1.5rem',
                color: isCached ? '#4a5d23' : '#b40a0a',
                zIndex: 0
              }}>
                {isCached ? <CheckCircle2 size={24} style={{ opacity: 0.5 }} /> : <Trash2 size={24} style={{ opacity: 0.5 }} />}
                <span style={{ marginLeft: '1rem', fontSize: '0.8rem', fontWeight: 700, letterSpacing: '0.1em' }}>
                  {isCached ? 'ARCHIVE' : 'DISMISS'}
                </span>
              </div>

              <motion.div
                onClick={() => onSelect(article)}
                style={{
                  backgroundColor: 'var(--bg-card)',
                  padding: '1.5rem',
                  borderRadius: '24px',
                  cursor: 'pointer',
                  position: 'relative',
                  zIndex: 1,
                  border: isCached ? '1px solid rgba(74, 93, 35, 0.15)' : '1px solid var(--border-light)',
                  boxShadow: '0 4px 25px rgba(0,0,0,0.03)',
                  overflow: 'hidden'
                }}
                whileTap={{ scale: 0.98 }}
              >
                {/* Visual Processing Progress Bar (if processing) */}
                {isProcessing && (
                  <motion.div 
                    initial={{ x: '-100%' }}
                    animate={{ x: '0%' }}
                    transition={{ duration: 15, ease: 'linear' }}
                    style={{
                      position: 'absolute',
                      bottom: 0,
                      left: 0,
                      height: '3px',
                      width: '100%',
                      backgroundColor: '#4a5d23',
                      opacity: 0.4
                    }}
                  />
                )}

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.25rem' }}>
                  <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                    <span style={{ 
                      fontSize: '0.65rem', 
                      fontWeight: 800, 
                      color: isCached ? '#4a5d23' : 'var(--text-muted)', 
                      letterSpacing: '0.15em',
                      backgroundColor: isCached ? 'rgba(74, 93, 35, 0.08)' : 'var(--bg-pure)',
                      padding: '0.3rem 0.7rem',
                      borderRadius: '8px'
                    }}>
                      {article.category.toUpperCase()}
                    </span>
                  </div>
                  
                  {isCached && (
                    <div style={{ color: '#4a5d23', display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.7rem', fontWeight: 800 }}>
                      <CheckCircle2 size={16} strokeWidth={2.5} />
                      <span style={{ letterSpacing: '0.05em' }}>READY</span>
                    </div>
                  )}
                </div>

                <h3 className="serif" style={{ 
                  fontSize: '1.35rem', 
                  lineHeight: 1.45, 
                  color: isProcessing ? 'var(--text-muted)' : 'var(--text-main)',
                  marginBottom: '1rem',
                  maxWidth: '90%'
                }}>
                  {article.title}
                </h3>
                
                {isProcessing ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                     <div className="lucide-spin" style={{ width: '12px', height: '12px', border: '1.5px solid rgba(74, 93, 35, 0.2)', borderTopColor: '#4a5d23', borderRadius: '50%' }} />
                     <span style={{ fontSize: '0.75rem', color: '#4a5d23', fontWeight: 600, letterSpacing: '0.02em' }}>
                        AI is preparing this article...
                     </span>
                  </div>
                ) : !isCached && (
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 500, fontStyle: 'italic', opacity: 0.8 }}>
                    Tap to prepare for reading
                  </div>
                )}
              </motion.div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </motion.div>
  );
}
