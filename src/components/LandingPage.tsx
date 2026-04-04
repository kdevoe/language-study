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
  // Section 1: Hero (0 to 0.25)
  const heroOpacity = useTransform(scrollYProgress, [0, 0.15, 0.25], [1, 1, 0]);
  const heroScale = useTransform(scrollYProgress, [0, 0.25], [1, 0.8]);
  const heroY = useTransform(scrollYProgress, [0, 0.25], ['0%', '-20%']);

  // Section 2: Immerse (0.2 to 0.5)
  const immerseOpacity = useTransform(scrollYProgress, [0.15, 0.25, 0.4, 0.5], [0, 1, 1, 0]);
  const immerseY = useTransform(scrollYProgress, [0.15, 0.25, 0.4, 0.5], ['20%', '0%', '0%', '-20%']);

  // Section 3: SRS / Context (0.45 to 0.75)
  const srsOpacity = useTransform(scrollYProgress, [0.4, 0.5, 0.65, 0.75], [0, 1, 1, 0]);
  const srsY = useTransform(scrollYProgress, [0.4, 0.5, 0.65, 0.75], ['20%', '0%', '0%', '-20%']);

  // Section 4: Waitlist / Footer (0.7 to 1)
  const waitlistOpacity = useTransform(scrollYProgress, [0.7, 0.85], [0, 1]);
  const waitlistY = useTransform(scrollYProgress, [0.7, 0.85], ['20%', '0%']);

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

  return (
    <div ref={containerRef} style={{ height: '400vh', backgroundColor: '#0a0a0a', color: '#ffffff' }}>
      
      {/* FIXED VIEWPORT CONTAINER (Hardware accelerated wrapper) */}
      <div style={{ position: 'sticky', top: 0, height: '100vh', width: '100vw', overflow: 'hidden' }}>

        {/* Ambient Premium Blur Effects */}
        <div style={{ position: 'absolute', top: '-10%', left: '-10%', width: '50vw', height: '50vw', borderRadius: '50%', background: 'radial-gradient(circle, rgba(138,154,91,0.15) 0%, rgba(0,0,0,0) 70%)', filter: 'blur(80px)', zIndex: 0 }} />
        <div style={{ position: 'absolute', bottom: '-20%', right: '-10%', width: '60vw', height: '60vw', borderRadius: '50%', background: 'radial-gradient(circle, rgba(66,133,244,0.1) 0%, rgba(0,0,0,0) 70%)', filter: 'blur(100px)', zIndex: 0 }} />

        {/* --- SECTION 1: HERO --- */}
        <motion.div style={{ position: 'absolute', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', opacity: heroOpacity, scale: heroScale, y: heroY, zIndex: 10 }}>
          <h1 className="serif" style={{ fontSize: 'clamp(5rem, 15vw, 12rem)', fontWeight: 300, marginBottom: '0rem', letterSpacing: '0.05em', lineHeight: 1, textShadow: '0 20px 40px rgba(0,0,0,0.5)' }}>
            幽玄
          </h1>
          <h2 className="sans" style={{ fontSize: 'clamp(1rem, 3vw, 2rem)', fontWeight: 400, letterSpacing: '0.4em', textTransform: 'uppercase', opacity: 0.8, marginBottom: '6vh' }}>
            Yūgen News
          </h2>
          <div style={{ position: 'absolute', bottom: '8vh', opacity: 0.5, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '0.8rem', letterSpacing: '0.2em', textTransform: 'uppercase' }}>Discover</span>
            <ChevronDown className="lucide-bounce" size={24} />
          </div>
        </motion.div>

        {/* --- SECTION 2: IMMERSE --- */}
        <motion.div style={{ position: 'absolute', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem', opacity: immerseOpacity, y: immerseY, zIndex: 20 }}>
          <h2 className="serif" style={{ fontSize: 'clamp(2.5rem, 8vw, 5rem)', textAlign: 'center', lineHeight: 1.2, maxWidth: '800px', fontWeight: 400, textShadow: '0 10px 30px rgba(0,0,0,0.8)' }}>
            Read the news. <br/>
            <span style={{ color: '#8a9a5b' }}>Master the language.</span>
          </h2>
          <p className="sans" style={{ marginTop: '2rem', fontSize: 'clamp(1.1rem, 2vw, 1.4rem)', color: '#a0a0a0', textAlign: 'center', maxWidth: '600px', lineHeight: 1.6 }}>
            An infinite, beautifully curated timeline of daily articles dynamically matched to your exact reading level. 
          </p>
        </motion.div>

        {/* --- SECTION 3: CONTEXT & SRS --- */}
        <motion.div style={{ position: 'absolute', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem', opacity: srsOpacity, y: srsY, zIndex: 30 }}>
          <h2 className="serif" style={{ fontSize: 'clamp(2rem, 6vw, 4rem)', textAlign: 'center', lineHeight: 1.2, maxWidth: '800px', fontWeight: 300 }}>
            Context is everything.
          </h2>
          <div style={{ marginTop: '3rem', padding: '2rem', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '24px', backdropFilter: 'blur(20px)', maxWidth: '500px', textAlign: 'left', boxShadow: '0 20px 40px rgba(0,0,0,0.4)' }}>
            <p className="serif" style={{ fontSize: '1.5rem', lineHeight: 1.8, color: '#666' }}>
              Our AI extracts your <span style={{ color: '#fff', backgroundColor: 'rgba(138,154,91,0.2)', padding: '2px 8px', borderRadius: '6px' }}>弱点 </span> (weaknesses) and weaves them naturally into tomorrow's headlines.
            </p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: '2rem', paddingTop: '1.5rem', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
              <div>
                <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#888', marginBottom: '0.2rem' }}>Spaced Repetition</div>
                <div style={{ fontSize: '1rem', fontWeight: 500 }}>Seamless Integration</div>
              </div>
              <CheckCircle2 color="#8a9a5b" size={24} />
            </div>
          </div>
        </motion.div>

        {/* --- SECTION 4: WAITLIST & CTA --- */}
        <motion.div style={{ position: 'absolute', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem', opacity: waitlistOpacity, y: waitlistY, zIndex: 40 }}>
          
          <div style={{ maxWidth: '400px', width: '100%', textAlign: 'center' }}>
            <h2 className="serif" style={{ fontSize: '2.5rem', marginBottom: '1rem' }}>Get early access.</h2>
            <p className="sans" style={{ color: '#888', marginBottom: '3rem' }}>Join the waitlist to be among the first to experience Yūgen News when we launch the private beta.</p>

            {waitlistStatus === 'success' ? (
              <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} style={{ padding: '2rem', background: 'rgba(138,154,91,0.1)', border: '1px solid rgba(138,154,91,0.3)', borderRadius: '16px', color: '#8a9a5b' }}>
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
                  style={{ width: '100%', padding: '1.25rem 1.5rem', fontSize: '1.1rem', borderRadius: '100px', border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.05)', color: '#fff', outline: 'none' }}
                />
                <button 
                  type="submit" 
                  disabled={waitlistStatus === 'loading' || !email.includes('@')}
                  style={{ width: '100%', padding: '1.25rem', fontSize: '1.1rem', fontWeight: 600, borderRadius: '100px', border: 'none', background: '#fff', color: '#000', cursor: 'pointer', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.5rem', transition: 'transform 0.2s, opacity 0.2s', opacity: (waitlistStatus === 'loading' || !email.includes('@')) ? 0.5 : 1 }}
                  onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.transform = 'scale(1.02)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
                >
                  {waitlistStatus === 'loading' ? <div className="lucide-spin" style={{ width: '20px', height: '20px', border: '2px solid rgba(0,0,0,0.2)', borderTopColor: '#000', borderRadius: '50%' }} /> : <>Join Waitlist <ArrowRight size={20} /></>}
                </button>
              </form>
            )}

            {waitlistStatus === 'error' && (
              <div style={{ color: '#ff6b6b', marginTop: '1rem', fontSize: '0.9rem' }}>{waitlistMessage}</div>
            )}

            <div style={{ marginTop: '4rem', paddingTop: '2rem', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
              <div style={{ fontSize: '0.8rem', color: '#666', marginBottom: '1rem' }}>Already have beta access?</div>
              <button 
                onClick={handleGoogleLogin}
                style={{ background: 'none', border: 'none', color: '#8a9a5b', fontWeight: 500, fontSize: '0.9rem', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: '4px' }}
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
