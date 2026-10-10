import { Newspaper, BookOpen, Headphones, Layers } from 'lucide-react';

type Tab = 'news' | 'library' | 'listen' | 'flashcards' | 'settings';

interface Props {
  activeTab: Tab;
  onChange: (tab: Tab) => void;
  isVisible?: boolean;
}

export function BottomNav({ activeTab, onChange, isVisible = true }: Props) {
  const tabs = [
    { id: 'news', label: 'NEWS', icon: Newspaper },
    { id: 'library', label: 'LIBRARY', icon: BookOpen },
    { id: 'listen', label: 'LISTEN', icon: Headphones },
    { id: 'flashcards', label: 'REVIEW', icon: Layers },
  ] as const;

  return (
    <nav style={{
      position: 'fixed',
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'var(--bg-pure)',
      display: 'flex',
      justifyContent: 'center',
      padding: '0.95rem 1rem',
      // Sit a touch lower: borrow a little of the home-indicator inset.
      paddingBottom: 'max(0.6rem, calc(env(safe-area-inset-bottom) - 0.4rem))',
      borderTop: '1px solid var(--border-light)',
      zIndex: 20,
      transform: isVisible ? 'translateY(0)' : 'translateY(100%)',
      transition: 'transform 0.4s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.4s',
      opacity: isVisible ? 1 : 0
    }}>
      {/* Tabs sit in a centered group so the outer tabs aren't pushed to the
          screen edges: with 4 tabs, full-width distribution left NEWS/REVIEW
          hugging the bezels. Even gaps inside a capped width keep the edge
          inset about equal to the spacing between tabs on a phone. */}
      <div style={{ display: 'flex', justifyContent: 'space-evenly', width: '100%', maxWidth: '392px' }}>
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
              // Fixed-width slots; the group above handles distribution.
              width: '76px',
            }}
          >
            <div style={{
              padding: '0.4rem 1rem',
              borderRadius: '100px', 
              backgroundColor: isActive ? 'var(--accent-primary)' : 'transparent',
              transition: 'background-color 0.2s'
            }}>
              <Icon size={28} strokeWidth={isActive ? 1.9 : 1.5} />
            </div>
            <span style={{ fontSize: '0.6rem', letterSpacing: '0.05em', fontWeight: isActive ? 600 : 500, marginTop: '2px' }}>
              {label}
            </span>
          </button>
        );
      })}
      </div>
    </nav>
  );
}
