import { useState } from 'react';
import { useAppStore } from '../services/store';

export function Onboarding() {
  const setOnboarded = useAppStore(state => state.setOnboarded);
  const [step, setStep] = useState(0);
  const [jlpt, setJlpt] = useState<number>(5);
  const [rtk, setRtk] = useState<number>(0);

  const handleFinish = () => {
    setOnboarded(jlpt, rtk);
  };

  return (
    <div style={{ padding: '2rem 1.25rem', maxWidth: '600px', margin: '15vh auto', textAlign: 'center' }} className="fade-in">
      {step === 0 && (
        <div className="fade-in">
          <h1 className="serif" style={{ fontSize: '3rem', color: 'var(--text-main)', marginBottom: '1rem', letterSpacing: '0.1em' }}>読書家</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '1.25rem', marginBottom: '3rem', letterSpacing: '0.05em', textTransform: 'uppercase' }}>Yūgen News</p>
          <p className="serif" style={{ fontSize: '1.25rem', marginBottom: '4rem', lineHeight: 1.8, color: 'var(--text-main)' }}>
            A typography-first Japanese reading experience.<br/>
            Let's establish your baseline.
          </p>
          <button 
            onClick={() => setStep(1)}
            style={{ padding: '1.25rem 4rem', fontSize: '1.1rem', backgroundColor: 'var(--text-main)', color: 'var(--bg-pure)', border: 'none', borderRadius: '100px', cursor: 'pointer', transition: 'opacity 0.2s', fontWeight: 500 }}
          >
            はじめに (Begin)
          </button>
        </div>
      )}

      {step === 1 && (
        <div className="fade-in">
          <h2 className="serif" style={{ fontSize: '1.75rem', marginBottom: '2.5rem', color: 'var(--text-main)' }}>What is your approximate JLPT level?</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '300px', margin: '0 auto' }}>
            {[
              { level: 5, label: 'N5 (Beginner)' },
              { level: 4, label: 'N4 (Basic)' },
              { level: 3, label: 'N3 (Intermediate)' },
              { level: 2, label: 'N2 (Pre-Advanced)' },
              { level: 1, label: 'N1 (Advanced)' }
            ].map(opt => (
              <button 
                key={opt.level}
                onClick={() => { setJlpt(opt.level); setStep(2); }}
                style={{ padding: '1.25rem', fontSize: '1.1rem', backgroundColor: 'transparent', border: '1px solid var(--border-light)', borderRadius: '16px', cursor: 'pointer', color: 'var(--text-main)', transition: 'all 0.2s' }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="fade-in">
          <h2 className="serif" style={{ fontSize: '1.75rem', marginBottom: '2.5rem', color: 'var(--text-main)' }}>How many Kanji do you recognize?</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '300px', margin: '0 auto' }}>
            {[
              { label: '0 - 100 (Just starting)', val: 0 },
              { label: '100 - 500 (N5/N4 level)', val: 500 },
              { label: '500 - 1000 (N3 level)', val: 1000 },
              { label: '1000 - 2000+ (Fluent reading)', val: 2000 }
            ].map(option => (
              <button 
                key={option.val}
                onClick={() => { setRtk(option.val); handleFinish(); }}
                style={{ padding: '1.25rem', fontSize: '1.1rem', backgroundColor: 'transparent', border: '1px solid var(--border-light)', borderRadius: '16px', cursor: 'pointer', color: 'var(--text-main)', transition: 'all 0.2s' }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
