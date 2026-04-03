import { motion } from 'framer-motion';
import { CheckCircle2, ChevronRight, Clock } from 'lucide-react';
import { NewsArticle } from '../services/api';

interface Props {
  articles: NewsArticle[];
  onSelect: (article: NewsArticle) => void;
  isLoading: boolean;
}

export function Feed({ articles, onSelect, isLoading }: Props) {
  // We can use useAppStore later for bookmarks/completion
  // const { wordDatabase } = useAppStore();

  const container = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: { staggerChildren: 0.08 }
    }
  };

  const item = {
    hidden: { opacity: 0, y: 20 },
    show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] as any } }
  };

  if (isLoading) {
    return (
      <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="skeleton-shimmer" style={{ height: '140px', borderRadius: '20px', backgroundColor: 'var(--border-light)' }} />
        ))}
      </div>
    );
  }

  return (
    <motion.div 
      variants={container}
      initial="hidden"
      animate="show"
      style={{ padding: '0.5rem 1.25rem 4rem 1.25rem' }}
    >
      <div style={{ marginBottom: '2.5rem' }}>
        <h2 className="serif" style={{ fontSize: '1.8rem', color: 'var(--text-main)', marginBottom: '0.5rem' }}>今日のニュース</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', fontWeight: 500 }}>Your daily Japanese immersion library</p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        {articles.map((article) => (
          <motion.div
            key={article.id}
            variants={item}
            whileTap={{ scale: 0.98 }}
            onClick={() => onSelect(article)}
            style={{
              backgroundColor: 'var(--bg-pure)',
              borderRadius: '24px',
              padding: '1.5rem',
              boxShadow: '0 4px 20px rgba(0,0,0,0.06)',
              cursor: 'pointer',
              border: '1px solid var(--border-light)',
              position: 'relative',
              overflow: 'hidden'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
              <span style={{ 
                fontSize: '0.65rem', 
                fontWeight: 800, 
                letterSpacing: '0.1em', 
                color: '#4a5d23', 
                backgroundColor: 'rgba(74, 93, 35, 0.08)', 
                padding: '0.3rem 0.6rem', 
                borderRadius: '6px',
                textTransform: 'uppercase'
              }}>
                {article.category}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-muted)', fontSize: '0.7rem' }}>
                <Clock size={12} />
                <span>{article.readTime}</span>
              </div>
            </div>

            <h3 className="serif" style={{ 
              fontSize: '1.2rem', 
              lineHeight: 1.4, 
              color: 'var(--text-main)', 
              marginBottom: '1rem',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden'
            }}>
              {article.title}
            </h3>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', gap: '0.8rem' }}>
                {/* Stats or status would go here */}
                {false && ( // Placeholder for 'Completed' logic if needed
                   <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', color: '#4a5d23', fontSize: '0.75rem', fontWeight: 700 }}>
                     <CheckCircle2 size={14} />
                     <span>READ</span>
                   </div>
                )}
              </div>
              <div style={{ color: 'var(--border-light)' }}>
                <ChevronRight size={20} />
              </div>
            </div>
          </motion.div>
        ))}
      </div>
    </motion.div>
  );
}
