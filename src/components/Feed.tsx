import { motion, AnimatePresence, useMotionValue, useTransform, animate } from 'framer-motion';
import { CheckCircle2, Trash2, Bookmark } from 'lucide-react';
import { NewsArticle } from '../services/api';
import { useState } from 'react';

interface Props {
  articles: NewsArticle[];
  onSelect: (article: NewsArticle) => void;
  onDismiss: (id: string) => void;
  isLoading: boolean;
  isReplenishing?: boolean;
  processingIds: string[];
  cachedIds: string[];
}

function NewsCard({ 
  article, onSelect, onDismiss, isProcessing, isCached, isOpen, setOpenId 
}: { 
  article: NewsArticle; 
  onSelect: (a: NewsArticle) => void; 
  onDismiss: (id: string) => void;
  isProcessing: boolean;
  isCached: boolean;
  isOpen: boolean;
  setOpenId: (id: string | null) => void;
}) {
  const x = useMotionValue(0);
  // Transform x position: gradual linear fade from 0 to 1 over the full track
  const backdropOpacity = useTransform(x, [-160, 0], [1, 0]);

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] as any } },
    exit: { opacity: 0, scale: 0.95, transition: { duration: 0.2 } }
  };

  return (
    <div style={{ position: 'relative', touchAction: 'pan-y' }}>
      {/* BACK ACTIONS */}
      <motion.div 
        style={{ 
          position: 'absolute', 
          right: 0, 
          top: 0, 
          bottom: 0, 
          width: '160px', 
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          padding: '0 0.8rem',
          gap: '0.6rem',
          zIndex: 0,
          opacity: backdropOpacity,
        }}
      >
        <button 
          onClick={(e) => {
            e.stopPropagation();
            if (article.id) onDismiss(article.id); 
          }}
          style={{ 
            backgroundColor: 'rgba(74, 93, 35, 0.1)', 
            color: '#4a5d23', 
            flex: 1,
            height: '70%', 
            borderRadius: '18px', 
            border: 'none', 
            display: 'flex', 
            flexDirection: 'column',
            alignItems: 'center', 
            justifyContent: 'center',
            gap: '0.3rem',
            cursor: 'pointer'
          }}
        >
          <Bookmark size={18} />
          <span style={{ fontSize: '0.5rem', fontWeight: 900 }}>SAVE</span>
        </button>

        <button 
          onClick={(e) => {
            e.stopPropagation();
            if (article.id) onDismiss(article.id);
          }}
          style={{ 
            backgroundColor: 'rgba(180, 10, 10, 0.1)', 
            color: '#b40a0a', 
            flex: 1,
            height: '70%', 
            borderRadius: '18px', 
            border: 'none', 
            display: 'flex', 
            flexDirection: 'column',
            alignItems: 'center', 
            justifyContent: 'center',
            gap: '0.3rem',
            cursor: 'pointer'
          }}
        >
          <Trash2 size={18} />
          <span style={{ fontSize: '0.5rem', fontWeight: 900 }}>DELETE</span>
        </button>
      </motion.div>

      {/* CARD FOREGROUND */}
      <motion.div
        variants={itemVariants}
        layout="position"
        exit="exit"
        drag="x"
        dragConstraints={{ left: -160, right: 0 }}
        dragElastic={0.05}
        dragMomentum={false}
        style={{
          x,
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
        animate={{ 
          x: isOpen ? -160 : 0
        }}
        transition={{ 
          type: 'spring', 
          stiffness: 600, 
          damping: 45
        }}
        onDragEnd={(_, info) => {
          // Snap based on position and velocity
          const shouldOpen = info.offset.x < -40 || info.velocity.x < -500;
          if (shouldOpen && article.id) {
            setOpenId(article.id);
            // If already open, force animation since React won't re-render
            if (isOpen) animate(x, -160, { type: 'spring', stiffness: 600, damping: 45 });
          } else {
            setOpenId(null);
            // If already closed, force animation since React won't re-render
            if (!isOpen) animate(x, 0, { type: 'spring', stiffness: 600, damping: 45 });
          }
        }}
        onClick={() => {
          if (isOpen) {
            setOpenId(null);
          } else {
            onSelect(article);
          }
        }}
        whileTap={{ scale: 0.98 }}
      >
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
    </div>
  );
}

export function Feed({ articles, onSelect, onDismiss, isLoading, isReplenishing, processingIds, cachedIds }: Props) {
  const [openArticleId, setOpenArticleId] = useState<string | null>(null);

  const container = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: { staggerChildren: 0.08 }
    }
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
      style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', paddingBottom: 0 }}
    >
      <AnimatePresence mode="popLayout">
        {articles.map((article) => (
          <NewsCard 
            key={article.id}
            article={article}
            onSelect={onSelect}
            onDismiss={onDismiss}
            isProcessing={article.id ? (processingIds || []).includes(article.id) : false}
            isCached={article.id ? (cachedIds || []).includes(article.id) : false}
            isOpen={openArticleId === article.id}
            setOpenId={setOpenArticleId}
          />
        ))}

        {isReplenishing && (
          <motion.div
            key="ghost-card-replenisher"
            initial={{ opacity: 0, y: 30, scale: 0.98 }}
            animate={{ opacity: 0.8, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.4 } }}
            transition={{ type: 'spring', stiffness: 350, damping: 25 }}
            className="shimmer"
            style={{
              padding: '1.5rem',
              borderRadius: '24px',
              backgroundColor: 'var(--bg-card)',
              border: '1px solid var(--border-light)',
              display: 'flex',
              flexDirection: 'column',
              gap: '1rem',
              minHeight: '160px',
              marginTop: '1rem',
              overflow: 'hidden',
              position: 'relative'
            }}
          >
            {/* Minimalist Shimmer Skeleton */}
            <div style={{ width: '30%', height: '12px', background: 'rgba(0,0,0,0.04)', borderRadius: '4px' }} />
            <div style={{ width: '85%', height: '24px', background: 'rgba(0,0,0,0.04)', borderRadius: '6px', marginTop: '0.4rem' }} />
            <div style={{ width: '60%', height: '24px', background: 'rgba(0,0,0,0.04)', borderRadius: '6px' }} />
            <div style={{ width: '40%', height: '10px', background: 'rgba(0,0,0,0.03)', borderRadius: '4px', marginTop: '0.8rem' }} />
            
            {/* Shimmer Light Pulse */}
            <motion.div 
               initial={{ x: '-100%' }}
               animate={{ x: '200%' }}
               transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
               style={{ 
                 position: 'absolute', top: 0, left: 0, bottom: 0, width: '50%',
                 background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent)',
                 zIndex: 2
               }}
            />
          </motion.div>
        )}

        {/* BOTTOM ANCHOR (Minimal spacing) */}
        <div style={{ height: '1.5rem', width: '100%' }} />
      </AnimatePresence>
    </motion.div>
  );
}
