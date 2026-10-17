import { House, BookOpen, Headphones, Layers } from 'lucide-react';
import { useRef } from 'react';
import { AdaptiveLabel } from './AdaptiveLabel';
import { useTutorMaybe } from './tutor/TutorProvider';

export type Tab = 'today' | 'read' | 'listen' | 'flashcards' | 'settings';

interface Props {
  activeTab: Tab;
  onChange: (tab: Tab) => void;
  isVisible?: boolean;
}

// Dragging up on the nav opens ハルカ: the way in from a Safari tab, where the
// browser keeps the screen edges for back/forward (docs/tutor-agent-design.md §2).
const NAV_DRAG_PX = 40;

export function BottomNav({ activeTab, onChange, isVisible = true }: Props) {
  const tutor = useTutorMaybe();
  const dragStart = useRef<{ y: number; x: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => { dragStart.current = { y: e.touches[0].clientY, x: e.touches[0].clientX }; };
  const onTouchMove = (e: React.TouchEvent) => {
    const s = dragStart.current;
    if (!s || !tutor) return;
    const dy = s.y - e.touches[0].clientY;
    if (dy > NAV_DRAG_PX && dy > Math.abs(e.touches[0].clientX - s.x) * 1.5) {
      dragStart.current = null;
      tutor.openTutor();
    }
  };
  const tabs = [
    { id: 'today', label: 'today', icon: House },
    { id: 'read', label: 'read', icon: BookOpen },
    { id: 'listen', label: 'listen', icon: Headphones },
    { id: 'flashcards', label: 'review', icon: Layers },
  ] as const;

  return (
    <nav onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={() => { dragStart.current = null; }} style={{
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
          screen edges: with 4 tabs, full-width distribution left the outer tabs
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
            {/* Labels follow the page titles: Japanese once that title has switched. */}
            <span translate="no" className="nav-label" style={{ display: 'block', height: '1rem', fontSize: '0.6rem', lineHeight: '1rem', letterSpacing: '0.05em', fontWeight: isActive ? 600 : 500, marginTop: '2px' }}>
              <AdaptiveLabel id={label} upper />
            </span>
          </button>
        );
      })}
      </div>
    </nav>
  );
}
