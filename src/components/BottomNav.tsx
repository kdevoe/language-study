import { Newspaper, BarChart2, Settings } from 'lucide-react';

interface Props {
  activeTab: 'news' | 'progress' | 'settings';
  onChange: (tab: 'news' | 'progress' | 'settings') => void;
}

export function BottomNav({ activeTab, onChange }: Props) {
  const tabs = [
    { id: 'news', label: 'NEWS', icon: Newspaper },
    { id: 'progress', label: 'PROGRESS', icon: BarChart2 },
    { id: 'settings', label: 'SETTINGS', icon: Settings }
  ] as const;

  return (
    <nav style={{
      position: 'sticky',
      bottom: 0,
      backgroundColor: 'var(--bg-pure)',
      display: 'flex',
      justifyContent: 'space-around',
      padding: '0.75rem 0',
      paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))',
      borderTop: '1px solid var(--border-light)',
      zIndex: 20
    }}>
      {tabs.map(({ id, label, icon: Icon }) => {
        const isActive = activeTab === id;
        return (
          <button
            key={id}
            onClick={() => onChange(id)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '0.25rem',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: isActive ? 'var(--text-main)' : 'var(--text-muted)',
              transition: 'color 0.2s',
              width: '80px'
            }}
          >
            <div style={{ 
              padding: '0.4rem 1.25rem', 
              borderRadius: '100px', 
              backgroundColor: isActive ? 'var(--accent-primary)' : 'transparent',
              transition: 'background-color 0.2s'
            }}>
              <Icon size={24} strokeWidth={isActive ? 2 : 1.5} />
            </div>
            <span style={{ fontSize: '0.6rem', letterSpacing: '0.05em', fontWeight: isActive ? 600 : 500, marginTop: '2px' }}>
              {label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
