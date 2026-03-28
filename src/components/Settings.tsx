import React from 'react';
import { useAppStore } from '../services/store';
import { rtkKanjiList } from '../data/rtkKanji';

export function Settings() {
  const { 
    jlptLevel, setJlptLevel, 
    rtkLevel, setRtkLevel, 
    kanjiProportions, setKanjiProportions
  } = useAppStore();

  const handlePropChange = (type: 'known' | 'review' | 'unknown', val: number) => {
    const newProps = { ...kanjiProportions, [type]: val };
    const total = newProps.known + newProps.review + newProps.unknown;
    
    if (total === 0) return; // Prevent dividing by zero
    
    const kPct = Math.round((newProps.known / total) * 100);
    const rPct = Math.round((newProps.review / total) * 100);
    const uPct = 100 - kPct - rPct; // Force exact 100 sum
    
    setKanjiProportions({ known: kPct, review: rPct, unknown: uPct });
  };

  const handleRtkChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10);
    if (!isNaN(val)) {
      setRtkLevel(Math.min(Math.max(1, val), rtkKanjiList.length));
    }
  };

  return (
    <div className="fade-in" style={{ paddingBottom: '6rem' }}>
      <h2 className="serif" style={{ fontSize: '2rem', marginBottom: '2.5rem', color: 'var(--text-main)' }}>Settings</h2>

      <div style={{ backgroundColor: 'var(--bg-card)', padding: '1.5rem', borderRadius: '16px', marginBottom: '1.5rem' }}>
        <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.1em', marginBottom: '1.5rem', textTransform: 'uppercase' }}>
          Kanji Review Density
        </label>
        
        {/* Visual Bar */}
        <div style={{ display: 'flex', height: '12px', borderRadius: '6px', overflow: 'hidden', marginBottom: '1.5rem' }}>
          <div style={{ width: `${kanjiProportions.known}%`, backgroundColor: 'var(--text-muted)', opacity: 0.5, transition: 'width 0.2s' }}></div>
          <div style={{ width: `${kanjiProportions.review}%`, backgroundColor: 'var(--text-main)', transition: 'width 0.2s' }}></div>
          <div style={{ width: `${kanjiProportions.unknown}%`, backgroundColor: '#ef4444', transition: 'width 0.2s' }}></div>
        </div>

        {/* Sliders */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '1rem' }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '0.25rem' }}>
              <span style={{ color: 'var(--text-muted)' }}>Known Kanji</span>
              <span style={{ fontWeight: 600 }}>{kanjiProportions.known}%</span>
            </div>
            <input type="range" min="0" max="100" value={kanjiProportions.known} onChange={(e) => handlePropChange('known', parseInt(e.target.value))} style={{ width: '100%' }} />
          </div>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '0.25rem' }}>
              <span style={{ color: 'var(--text-main)' }}>Reviewing Targets</span>
              <span style={{ fontWeight: 600, color: 'var(--text-main)' }}>{kanjiProportions.review}%</span>
            </div>
            <input type="range" min="0" max="100" value={kanjiProportions.review} onChange={(e) => handlePropChange('review', parseInt(e.target.value))} style={{ width: '100%', accentColor: 'var(--text-main)' }} />
          </div>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '0.25rem' }}>
              <span style={{ color: '#ef4444' }}>Unknown Kanji</span>
              <span style={{ fontWeight: 600, color: '#ef4444' }}>{kanjiProportions.unknown}%</span>
            </div>
            <input type="range" min="0" max="100" value={kanjiProportions.unknown} onChange={(e) => handlePropChange('unknown', parseInt(e.target.value))} style={{ width: '100%', accentColor: '#ef4444' }} />
          </div>
        </div>
        
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Adjusts the ratio of Kanji character origins the AI is permitted to use in stories.
        </p>
      </div>

      <div style={{ backgroundColor: 'var(--bg-card)', padding: '1.5rem', borderRadius: '16px', marginBottom: '1.5rem' }}>
        <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.1em', marginBottom: '1.5rem', textTransform: 'uppercase' }}>
          Grammar Level (JLPT)
        </label>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {[5, 4, 3, 2, 1].map(n => (
            <button
              key={n}
              onClick={() => setJlptLevel(n)}
              style={{
                flex: 1,
                padding: '0.75rem 0',
                borderRadius: '8px',
                border: jlptLevel === n ? '2px solid var(--text-main)' : '1px solid var(--border-light)',
                backgroundColor: jlptLevel === n ? 'var(--text-main)' : 'transparent',
                color: jlptLevel === n ? 'var(--bg-pure)' : 'var(--text-main)',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.2s'
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
