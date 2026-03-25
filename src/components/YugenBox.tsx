

interface Props {
  keyword: string;
  reading?: string;
  description: string;
}

export function YugenBox({ keyword, reading, description }: Props) {
  return (
    <div style={{
      borderLeft: '4px solid var(--text-main)',
      backgroundColor: 'var(--bg-card)',
      padding: '2rem',
      margin: '3rem 0',
      boxShadow: '0 4px 20px rgba(0,0,0,0.03)'
    }}>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem', fontWeight: 600, letterSpacing: '0.05em' }}>
        キーワード
      </div>
      <h3 className="serif" style={{ fontSize: '1.6rem', marginBottom: '1rem', color: 'var(--text-main)', fontWeight: 500 }}>
        {keyword} {reading && <span className="sans" style={{ fontSize: '1.1rem', color: 'var(--text-muted)', fontWeight: 400 }}>({reading})</span>}
      </h3>
      <p style={{ color: 'var(--text-main)', fontSize: '1rem', lineHeight: 1.8 }}>
        {description}
      </p>
    </div>
  );
}
