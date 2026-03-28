import { supabase } from '../services/supabase';

export function LandingPage() {
  const handleGoogleLogin = async () => {
    try {
      if (!import.meta.env.VITE_SUPABASE_URL) {
        alert("Supabase keys not configured yet! Please add VITE_SUPABASE_URL to your .env file.");
        return;
      }
      
      await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: window.location.origin
        }
      });
    } catch (err) {
      console.error("Login failed:", err);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      minWidth: '100vw',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'var(--bg-pure)',
      padding: '2rem',
      position: 'relative',
      overflow: 'hidden',
      textAlign: 'center'
    }}>
      {/* Aesthetic Blur Orbs */}
      <div style={{
        position: 'absolute',
        top: '-10%',
        left: '-10%',
        width: '50vw',
        height: '50vw',
        borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(0,0,0,0.03) 0%, rgba(0,0,0,0) 70%)',
        filter: 'blur(40px)',
        zIndex: 0
      }} />
      <div style={{
        position: 'absolute',
        bottom: '-20%',
        right: '-10%',
        width: '60vw',
        height: '60vw',
        borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(0,0,0,0.02) 0%, rgba(0,0,0,0) 70%)',
        filter: 'blur(50px)',
        zIndex: 0
      }} />

      <div className="fade-in" style={{ zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', maxWidth: '500px' }}>
        <h1 className="serif" style={{ fontSize: '4.5rem', fontWeight: 400, color: 'var(--text-main)', marginBottom: '0.5rem', letterSpacing: '0.02em', lineHeight: 1.1 }}>
          幽玄
        </h1>
        <h2 className="sans" style={{ fontSize: '1.25rem', fontWeight: 500, color: 'var(--text-main)', letterSpacing: '0.3em', textTransform: 'uppercase', marginBottom: '2.5rem' }}>
          Yūgen News
        </h2>
        
        <p className="serif" style={{ fontSize: '1.15rem', color: 'var(--text-muted)', lineHeight: 1.8, marginBottom: '3.5rem' }}>
          A context-aware Japanese immersion engine that dynamically weaves the exact Spaced Repetition vocabulary you're studying right into daily news.
        </p>

        <button 
          onClick={handleGoogleLogin}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '1rem',
            padding: '1rem 2rem',
            backgroundColor: 'var(--text-main)',
            color: 'var(--bg-pure)',
            border: 'none',
            borderRadius: '100px',
            fontSize: '1rem',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'transform 0.2s, box-shadow 0.2s',
            boxShadow: '0 8px 30px rgba(0,0,0,0.12)'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'translateY(-2px)';
            e.currentTarget.style.boxShadow = '0 12px 40px rgba(0,0,0,0.18)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'translateY(0)';
            e.currentTarget.style.boxShadow = '0 8px 30px rgba(0,0,0,0.12)';
          }}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            <path d="M1 1h22v22H1z" fill="none"/>
          </svg>
          Continue with Google
        </button>
      </div>

      <div style={{ position: 'absolute', bottom: '2rem', fontSize: '0.75rem', color: 'var(--text-muted)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
        Beta Test Release
      </div>
    </div>
  );
}
