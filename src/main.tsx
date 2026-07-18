import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { loadReadingData } from './services/furigana'
import { initMonitoring } from './services/monitoring'
import { ErrorBoundary } from './components/ErrorBoundary'

// Prime the per-kanji reading tables (#36) as early as possible — alignReading
// degrades to the coarser okurigana aligner until they land, and enrichment
// STORES its furiganaMap, so a pre-load alignment would persist. Fire-and-forget:
// the chunk is code-split and loads well before the first lookup's network
// round-trip completes.
loadReadingData()

// Error monitoring (path-forward §0.3) — no-op unless VITE_SENTRY_DSN is set.
initMonitoring()

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
