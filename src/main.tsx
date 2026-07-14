import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { loadReadingData } from './services/furigana'

// Prime the per-kanji reading tables (#36) as early as possible — alignReading
// degrades to the coarser okurigana aligner until they land, and enrichment
// STORES its furiganaMap, so a pre-load alignment would persist. Fire-and-forget:
// the chunk is code-split and loads well before the first lookup's network
// round-trip completes.
loadReadingData()

createRoot(document.getElementById('root')!).render(
  <App />
)
