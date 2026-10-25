import { useEffect, useState } from 'react';
import { useTutor, useTutorScreen } from './TutorProvider';
import { fetchOpener, fetchTutorHistory, localDay, type WorkRef } from '../../services/tutor';

// Pinned to the top of 今日. Before you've talked today: ハルカ's line from last
// night's brief (something real — a finished article, a plan you mentioned), and
// tapping opens the panel with it as her first message. Once today's conversation
// is going: her last line (usually the question she left you with), and tapping
// picks the conversation back up. A new day starts a new thread, and the opener again.
// On Sunday the opener announces the weekly recap, which the chat shows under it;
// after a long-read night it announces the long read, the same way.

const FALLBACK = '今日は何について話そうか？';
const OPENER_KEY = 'yugen-tutor-opener';
const LATEST_KEY = 'yugen-tutor-latest';
const RECAP_KEY = 'yugen-tutor-opener-recap';
const WORK_KEY = 'yugen-tutor-opener-work';

/** The last Japanese paragraph of her message: asides dropped, recast tags unwrapped. */
function lastLine(text: string): string {
  const paras = text
    .replace(/<aside>[\s\S]*?(<\/aside>|$)/g, '\n')
    .replace(/<fix[^>]*>([\s\S]*?)<\/fix>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .split(/\n+/).map((p) => p.trim()).filter(Boolean);
  return paras[paras.length - 1] ?? '';
}

function readCache<T>(key: string): T | null {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) as T : null; } catch { return null; }
}
function writeCache(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota or blocked */ }
}

export function TutorHomeCard() {
  const { open, openTutor } = useTutor();
  const [opener, setOpener] = useState<string>(() => {
    try { return localStorage.getItem(OPENER_KEY) || FALLBACK; } catch { return FALLBACK; }
  });
  const [recapId, setRecapId] = useState<string | undefined>(() => {
    try { return localStorage.getItem(RECAP_KEY) || undefined; } catch { return undefined; }
  });
  const [work, setWork] = useState<WorkRef | undefined>(() => readCache<WorkRef>(WORK_KEY) ?? undefined);
  const [latest, setLatest] = useState<string | null>(() => {
    const c = readCache<{ day: string; line: string }>(LATEST_KEY);
    return c && c.day === localDay() ? c.line : null;
  });

  // Swiping in on 今日 starts from the same place as tapping the card. No chip:
  // there's nothing specific on screen.
  useTutorScreen(() => ({ screen: 'home', detail: '', ...(!latest && { opener, recapId, work }) }));

  useEffect(() => {
    fetchOpener().then((o) => {
      if (!o) return;
      setOpener(o.line);
      setRecapId(o.recapId);
      setWork(o.work);
      try {
        localStorage.setItem(OPENER_KEY, o.line);
        if (o.recapId) localStorage.setItem(RECAP_KEY, o.recapId); else localStorage.removeItem(RECAP_KEY);
        if (o.work) localStorage.setItem(WORK_KEY, JSON.stringify(o.work)); else localStorage.removeItem(WORK_KEY);
      } catch { /* quota or blocked */ }
    }).catch(() => { /* keep the cached or default line */ });
  }, []);

  // Today's conversation: on mount, and again each time the panel closes.
  useEffect(() => {
    if (open) return;
    fetchTutorHistory().then(({ threadId, messages }) => {
      const hers = [...messages].reverse().find((m) => m.role === 'assistant' && m.text);
      const line = threadId && hers?.text ? lastLine(hers.text) : '';
      setLatest(line || null);
      writeCache(LATEST_KEY, { day: localDay(), line: line || '' });
    }).catch(() => { /* keep what's shown */ });
  }, [open]);

  const line = latest ?? opener;
  const go = () => openTutor(latest ? {} : { opener, recapId, work });

  return (
    <div className="tutor-card" role="button" tabIndex={0}
      onClick={go}
      onKeyDown={(e) => { if (e.key === 'Enter') go(); }}>
      <div className="tutor-card-top"><span className="tutor-av sm">ハ</span><span className="tutor-card-name">ハルカ</span></div>
      <div className="tutor-card-line">{line}</div>
    </div>
  );
}
