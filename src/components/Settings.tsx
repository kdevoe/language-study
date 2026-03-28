import React from 'react';
import { useAppStore } from '../services/store';
import { rtkKanjiList } from '../data/rtkKanji';

export function Settings() {
  const { 
    jlptLevel, setJlptLevel, 
    rtkLevel, setRtkLevel, 
    studyMode, setStudyMode
  } = useAppStore();

  const handleRtkChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10);
    if (!isNaN(val)) {
      setRtkLevel(Math.min(Math.max(1, val), rtkKanjiList.length));
    }
  };

  const modes = ['Natural', 'Balanced', 'Study'] as const;
  const activeModeIndex = modes.findIndex(m => m.toLowerCase() === studyMode);

  const jlptLevels = [5, 4, 3, 2, 1];
  const activeJlptIndex = jlptLevels.indexOf(jlptLevel || 4);

  return (
    <div className="fade-in" style={{ paddingBottom: '6rem' }}>
      <h2 className="serif" style={{ fontSize: '2rem', marginBottom: '2.5rem', color: 'var(--text-main)' }}>Settings</h2>

      <div style={{ backgroundColor: 'var(--bg-card)', padding: '1.5rem', borderRadius: '16px', marginBottom: '1.5rem' }}>
        <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.1em', marginBottom: '1.5rem', textTransform: 'uppercase' }}>
          Kanji Study Bias
        </label>
        
        <div style={{ display: 'flex', backgroundColor: 'var(--border-light)', borderRadius: '100px', padding: '4px', marginBottom: '1.2rem', height: '45px', position: 'relative' }}>
          
          <div style={{
            position: 'absolute',
            top: '4px',
            bottom: '4px',
            left: `calc(4px + ${activeModeIndex} * (100% - 8px) / 3)`,
            width: `calc((100% - 8px) / 3)`,
            backgroundColor: 'var(--bg-pure)',
            borderRadius: '100px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
            transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
            zIndex: 0
          }} />

          {modes.map((mode) => {
            const isSelected = studyMode === mode.toLowerCase();
            return (
              <button
                key={mode}
                onClick={() => setStudyMode(mode.toLowerCase() as any)}
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
                  fontSize: '0.85rem',
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                  position: 'relative',
                  zIndex: 1
                }}
              >
                {mode}
              </button>
            );
          })}
        </div>
        
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
          {studyMode === 'natural' && "Prioritize totally authentic and colloquial phrasing over forcing specific Kanji targets."}
          {studyMode === 'balanced' && "Prioritize authentic reading but actively substitute common synonyms that leverage your targeted Kanji pool."}
          {studyMode === 'study' && "Significantly bias the LLM to warp the article's phrasing specifically around enforcing Spaced Repetition targets, even if it feels slightly unnatural."}
        </p>
      </div>

      <div style={{ backgroundColor: 'var(--bg-card)', padding: '1.5rem', borderRadius: '16px', marginBottom: '1.5rem' }}>
        <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.1em', marginBottom: '1.5rem', textTransform: 'uppercase' }}>
          Grammar Level (JLPT)
        </label>
        <div style={{ display: 'flex', backgroundColor: 'var(--border-light)', borderRadius: '100px', padding: '4px', height: '45px', position: 'relative' }}>
          
          <div style={{
            position: 'absolute',
            top: '4px',
            bottom: '4px',
            left: `calc(4px + ${activeJlptIndex} * (100% - 8px) / 5)`,
            width: `calc((100% - 8px) / 5)`,
            backgroundColor: 'var(--bg-pure)',
            borderRadius: '100px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
            transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
            zIndex: 0
          }} />

          {jlptLevels.map(n => (
            <button
              key={n}
              onClick={() => setJlptLevel(n)}
              style={{
                flex: 1,
                borderRadius: '100px',
                backgroundColor: 'transparent',
                color: jlptLevel === n ? 'var(--text-main)' : 'var(--text-muted)',
                fontWeight: jlptLevel === n ? 700 : 600,
                border: 'none',
                outline: 'none',
                cursor: 'pointer',
                transition: 'color 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                fontSize: '0.9rem',
                position: 'relative',
                zIndex: 1
              }}
            >
              N{n}
            </button>
          ))}
        </div>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '1rem', lineHeight: 1.5 }}>
          Defines the complexity of the sentence structures and conjugations generated by the AI native speaker.
        </p>
      </div>

      <div style={{ backgroundColor: 'var(--bg-card)', padding: '1.5rem', borderRadius: '16px', marginBottom: '3rem' }}>
         <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.1em', marginBottom: '1rem', textTransform: 'uppercase' }}>
          RTK Progression Level
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.5rem' }}>
          <input 
            type="number" 
            value={rtkLevel || 1} 
            onChange={handleRtkChange}
            min={1}
            max={rtkKanjiList.length}
            style={{
              padding: '0.75rem',
              borderRadius: '8px',
              border: '1px solid var(--border-light)',
              backgroundColor: 'var(--bg-pure)',
              color: 'var(--text-main)',
              fontSize: '1.25rem',
              width: '100px',
              textAlign: 'center',
              fontWeight: 600
            }}
          />
          <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            / {rtkKanjiList.length} Kanji
          </span>
        </div>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Automatically scales up by 3 every 24 hours. Manually jump your progression index here.
        </p>
      </div>
      
    </div>
  );
}
