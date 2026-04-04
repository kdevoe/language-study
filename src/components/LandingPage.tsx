import { supabase } from '../services/supabase';
import { motion, useScroll, useTransform } from 'framer-motion';
import { useRef, useState } from 'react';
import { joinWaitlist } from '../services/api';
import { ArrowRight, CheckCircle2, ChevronDown } from 'lucide-react';

export function LandingPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: containerRef });

  // --- WAITLIST STATE ---
  const [email, setEmail] = useState('');
  const [waitlistStatus, setWaitlistStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [waitlistMessage, setWaitlistMessage] = useState('');

  // --- SCROLL ANIMATIONS ---
  // Section 1: Hero (0 to 0.2)
  const heroOpacity = useTransform(scrollYProgress, [0, 0.1, 0.2], [1, 1, 0]);
  const heroScale = useTransform(scrollYProgress, [0, 0.2], [1, 0.9]);
  const heroY = useTransform(scrollYProgress, [0, 0.2], ['0%', '-10%']);

  // Section 2: Infinite Stream (0.15 to 0.4)
  const listOpacity = useTransform(scrollYProgress, [0.15, 0.25, 0.35, 0.45], [0, 1, 1, 0]);
  const listY = useTransform(scrollYProgress, [0.15, 0.25, 0.35, 0.45], ['10%', '0%', '0%', '-10%']);

  // Section 3: Reader View (0.35 to 0.6)
  const readerOpacity = useTransform(scrollYProgress, [0.35, 0.45, 0.55, 0.65], [0, 1, 1, 0]);
  const readerY = useTransform(scrollYProgress, [0.35, 0.45, 0.55, 0.65], ['10%', '0%', '0%', '-10%']);

  // Section 4: Word Lookup (0.55 to 0.8)
  const lookupOpacity = useTransform(scrollYProgress, [0.55, 0.65, 0.75, 0.85], [0, 1, 1, 0]);
  const lookupY = useTransform(scrollYProgress, [0.55, 0.65, 0.75, 0.85], ['10%', '0%', '0%', '-10%']);

  // Section 5: Waitlist (0.75 to 1)
  const waitlistOpacity = useTransform(scrollYProgress, [0.75, 0.85], [0, 1]);
  const waitlistY = useTransform(scrollYProgress, [0.75, 0.85], ['10%', '0%']);

  const handleGoogleLogin = async () => {
    try {
      if (!import.meta.env.VITE_SUPABASE_URL) return;
      await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } });
    } catch (err) { console.error(err); }
  };

  const handleJoinWaitlist = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !email.includes('@')) return;
    setWaitlistStatus('loading');
    const res = await joinWaitlist(email);
    if (res.success) {
      setWaitlistStatus('success');
      setWaitlistMessage("You're on the list! We'll be in touch soon.");
    } else {
      setWaitlistStatus('error');
      setWaitlistMessage(res.message || "Something went wrong.");
    }
  };

  const SectionImage = ({ src, alt, delay = 0 }: { src: string, alt: string, delay?: number }) => (
    <motion.div 
      animate={{ y: [0, -15, 0] }}
      transition={{ repeat: Infinity, duration: 6, ease: "easeInOut", delay }}
      style={{ 
        width: '100%', 
        maxWidth: '280px', 
        borderRadius: '32px', 
        overflow: 'hidden', 
        boxShadow: '0 30px 60px rgba(0,0,0,0.1), 0 0 0 8px rgba(0,0,0,0.02)', 
        margin: '2rem auto 0',
        backgroundColor: 'var(--bg-pure)'
      }}
    >
      <img src={src} alt={alt} style={{ width: '100%', display: 'block', objectFit: 'contain' }} />
    </motion.div>
  );

  return (
    <div ref={containerRef} style={{ height: '500dvh', backgroundColor: 'var(--bg-color)', color: 'var(--text-main)' }}>
      
      {/* FIXED VIEWPORT CONTAINER (Hardware accelerated wrapper) */}
      <div style={{ position: 'sticky', top: 0, height: '100dvh', width: '100vw', overflow: 'hidden' }}>

        {/* --- SECTION 1: HERO --- */}
        <motion.div style={{ position: 'absolute', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', opacity: heroOpacity, scale: heroScale, y: heroY, zIndex: 10 }}>
          <h1 className="serif" style={{ fontSize: 'clamp(5rem, 15vw, 12rem)', fontWeight: 300, marginBottom: '0rem', letterSpacing: '0.05em', lineHeight: 1, textShadow: '0 10px 20px rgba(0,0,0,0.05)', color: 'var(--text-main)' }}>
            幽玄
          </h1>
          <h2 className="sans" style={{ fontSize: 'clamp(1rem, 3vw, 2rem)', fontWeight: 400, letterSpacing: '0.4em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '6vh' }}>
            Yūgen News
          </h2>
          <div style={{ position: 'absolute', bottom: '8vh', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '0.8rem', letterSpacing: '0.2em', textTransform: 'uppercase' }}>Discover</span>
            <ChevronDown className="lucide-bounce" size={24} />
          </div>
        </motion.div>

        {/* --- SECTION 2: STREAM --- */}
        <motion.div style={{ position: 'absolute', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem', opacity: listOpacity, y: listY, zIndex: 20 }}>
          <h2 className="serif" style={{ fontSize: 'clamp(2rem, 6vw, 4rem)', textAlign: 'center', lineHeight: 1.2, maxWidth: '800px', fontWeight: 500, color: 'var(--text-main)' }}>
            The Infinite Stream.
          </h2>
          <p className="sans" style={{ marginTop: '1rem', fontSize: 'clamp(1rem, 2vw, 1.2rem)', color: 'var(--text-muted)', textAlign: 'center', maxWidth: '600px', lineHeight: 1.6 }}>
            Never run out of material. An endless feed of daily news perfectly aligned to your capabilities.
          </p>
          <SectionImage src="/Screenshot-article-list.png" alt="Infinite Article Feed" />
        </motion.div>

        {/* --- SECTION 3: IMMERSE --- */}
        <motion.div style={{ position: 'absolute', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem', opacity: readerOpacity, y: readerY, zIndex: 30 }}>
          <h2 className="serif" style={{ fontSize: 'clamp(2rem, 6vw, 4rem)', textAlign: 'center', lineHeight: 1.2, maxWidth: '800px', fontWeight: 500, color: 'var(--text-main)' }}>
            Immersive Reading.
          </h2>
          <p className="sans" style={{ marginTop: '1rem', fontSize: 'clamp(1rem, 2vw, 1.2rem)', color: 'var(--text-muted)', textAlign: 'center', maxWidth: '600px', lineHeight: 1.6 }}>
            Distraction-free, typography-first layouts explicitly engineered to keep you deeply engaged in Japanese.
          </p>
          <SectionImage src="/screenshot-reader-view.png" alt="Clean Reader View" />
        </motion.div>

        {/* --- SECTION 4: CONTEXT & SRS --- */}
        <motion.div style={{ position: 'absolute', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem', opacity: lookupOpacity, y: lookupY, zIndex: 40 }}>
          <h2 className="serif" style={{ fontSize: 'clamp(2rem, 6vw, 4rem)', textAlign: 'center', lineHeight: 1.2, maxWidth: '800px', fontWeight: 500, color: 'var(--text-main)' }}>
            Contextual Insight.
          </h2>
          <p className="sans" style={{ marginTop: '1rem', fontSize: 'clamp(1rem, 2vw, 1.2rem)', color: 'var(--text-muted)', textAlign: 'center', maxWidth: '600px', lineHeight: 1.6 }}>
            Tap any word for zero-latency, context-aware AI definitions and grammar rules. Rate mastery to control Spaced Repetition injection.
          </p>
          <SectionImage src="/screenshot-word-lookup.png" alt="Contextual Word Lookup" />
        </motion.div>

        {/* --- SECTION 5: WAITLIST & CTA --- */}
        <motion.div style={{ position: 'absolute', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem', opacity: waitlistOpacity, y: waitlistY, zIndex: 50 }}>
          
          <div style={{ maxWidth: '400px', width: '100%', textAlign: 'center' }}>
            <h2 className="serif" style={{ fontSize: '2.5rem', marginBottom: '1rem', color: 'var(--text-main)' }}>Get early access.</h2>
            <p className="sans" style={{ color: 'var(--text-muted)', marginBottom: '3rem' }}>Join the waitlist to be among the first to experience Yūgen News when we launch the private beta.</p>

            {waitlistStatus === 'success' ? (
              <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} style={{ padding: '2rem', background: 'rgba(138,154,91,0.1)', border: '1px solid rgba(138,154,91,0.2)', borderRadius: '16px', color: '#687742' }}>
                <CheckCircle2 size={32} style={{ margin: '0 auto 1rem' }} />
                <div style={{ fontWeight: 600 }}>{waitlistMessage}</div>
              </motion.div>
            ) : (
              <form onSubmit={handleJoinWaitlist} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <input 
                  type="email" 
                  placeholder="Enter your email address" 
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  disabled={waitlistStatus === 'loading'}
                  style={{ width: '100%', padding: '1.25rem 1.5rem', fontSize: '1.1rem', borderRadius: '100px', border: '1px solid var(--border-light)', background: 'var(--bg-pure)', color: 'var(--text-main)', outline: 'none', boxShadow: '0 4px 12px rgba(0,0,0,0.02)' }}
                />
                <button 
                  type="submit" 
                  disabled={waitlistStatus === 'loading' || !email.includes('@')}
                  style={{ width: '100%', padding: '1.25rem', fontSize: '1.1rem', fontWeight: 600, borderRadius: '100px', border: 'none', background: 'var(--text-main)', color: 'var(--bg-pure)', cursor: 'pointer', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.5rem', transition: 'transform 0.2s, opacity 0.2s', opacity: (waitlistStatus === 'loading' || !email.includes('@')) ? 0.5 : 1, boxShadow: '0 4px 20px rgba(0,0,0,0.1)' }}
                  onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.transform = 'scale(1.02)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
                >
                  {waitlistStatus === 'loading' ? <div className="lucide-spin" style={{ width: '20px', height: '20px', border: '2px solid rgba(0,0,0,0.2)', borderTopColor: '#fff', borderRadius: '50%' }} /> : <>Join Waitlist <ArrowRight size={20} /></>}
                </button>
              </form>
            )}

            {waitlistStatus === 'error' && (
              <div style={{ color: '#ff6b6b', marginTop: '1rem', fontSize: '0.9rem' }}>{waitlistMessage}</div>
            )}

            <div style={{ marginTop: '4rem', paddingTop: '2rem', borderTop: '1px solid var(--border-light)' }}>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>Already have beta access?</div>
              <button 
                onClick={handleGoogleLogin}
                style={{ background: 'none', border: 'none', color: '#687742', fontWeight: 600, fontSize: '0.9rem', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: '4px' }}
              >
                Sign in with Google
              </button>
            </div>

          </div>
        </motion.div>

      </div>
    </div>
  );
}
