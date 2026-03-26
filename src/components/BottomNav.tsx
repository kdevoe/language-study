import { Newspaper, BarChart2, Settings } from 'lucide-react';

interface Props {
  activeTab: 'news' | 'progress' | 'settings';
  onChange: (tab: 'news' | 'progress' | 'settings') => void;
  isVisible?: boolean;
}

export function BottomNav({ activeTab, onChange, isVisible = true }: Props) {
  const tabs = [
    { id: 'news', label: 'NEWS', icon: Newspaper },
    { id: 'progress', label: 'PROGRESS', icon: BarChart2 },
    { id: 'settings', label: 'SETTINGS', icon: Settings }
  ] as const;

  return (
    <nav style={{
      position: 'fixed',
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'var(--bg-pure)',
      display: 'flex',
      justifyContent: 'space-around',
      padding: '0.75rem 0',
      paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))',
      borderTop: '1px solid var(--border-light)',
      zIndex: 20,
      transform: isVisible ? 'translateY(0)' : 'translateY(100%)',
      transition: 'transform 0.4s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.4s',
      opacity: isVisible ? 1 : 0
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
