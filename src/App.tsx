import { ArrowLeft, MoreVertical } from 'lucide-react'
import './App.css'

import { Reader } from './components/Reader'
import { Onboarding } from './components/Onboarding'
import { BottomNav } from './components/BottomNav'
import { useAppStore } from './services/store'
import { useEffect, useState } from 'react'

function App() {
  const isOnboarded = useAppStore(state => state.isOnboarded);
  const checkDailyKanji = useAppStore(state => state.checkDailyKanji);
  const [activeTab, setActiveTab] = useState<'news' | 'progress' | 'settings'>('news');

  useEffect(() => {
    if (isOnboarded) {
      checkDailyKanji();
    }
  }, [isOnboarded, checkDailyKanji]);

  if (!isOnboarded) {
    return <Onboarding />;
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center', 
        padding: '1.5rem 1.25rem',
        position: 'sticky',
        top: 0,
        backgroundColor: 'var(--bg-color)',
        zIndex: 10
      }}>
        <button style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
          <ArrowLeft size={24} strokeWidth={1.5} />
        </button>
        <h1 className="serif" style={{ fontSize: '1.25rem', letterSpacing: '0.1em' }}>読書家</h1>
        <button style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
          <MoreVertical size={24} strokeWidth={1.5} />
        </button>
      </header>

      <main style={{ flex: 1, padding: '2rem 1.25rem', maxWidth: '600px', margin: '0 auto', width: '100%' }}>
        {activeTab === 'news' && <Reader />}
        {activeTab === 'progress' && (
          <div className="fade-in" style={{ textAlign: 'center', marginTop: '4rem', color: 'var(--text-muted)' }}>
            <p>Progress dashboard placeholder.</p>
          </div>
        )}
        {activeTab === 'settings' && (
          <div className="fade-in" style={{ textAlign: 'center', marginTop: '4rem', color: 'var(--text-muted)' }}>
            <p>Settings placeholder.</p>
          </div>
        )}
      </main>

      <BottomNav activeTab={activeTab} onChange={setActiveTab} />
    </div>
  )
}

export default App
