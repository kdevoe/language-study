import { useEffect, useState } from 'react';
import { useTutor, useTutorScreen } from './TutorProvider';
import { fetchOpener } from '../../services/tutor';

// Pinned to the top of 今日: ハルカ's line from last night's brief (something real —
// a finished article, a plan you mentioned). Tapping it opens the panel with that
// line as her first message, so the card and the edge swipe land in one place.

const FALLBACK = '今日は何について話そうか？';

export function TutorHomeCard() {
  const { openTutor } = useTutor();
  const [line, setLine] = useState<string>(() => {
    try { return localStorage.getItem('yugen-tutor-opener') || FALLBACK; } catch { return FALLBACK; }
  });

  // Swiping in on 今日 starts from the same line as tapping the card. No chip:
  // there's nothing specific on screen.
  useTutorScreen(() => ({ screen: 'home', detail: '', opener: line }));

  useEffect(() => {
    fetchOpener().then((l) => {
      if (!l) return;
      setLine(l);
      try { localStorage.setItem('yugen-tutor-opener', l); } catch { /* quota or blocked */ }
    }).catch(() => { /* keep the cached or default line */ });
  }, []);

  return (
    <div className="tutor-card" role="button" tabIndex={0}
      onClick={() => openTutor({ opener: line })}
      onKeyDown={(e) => { if (e.key === 'Enter') openTutor({ opener: line }); }}>
      <div className="tutor-card-top"><span className="tutor-av sm">ハ</span><span className="tutor-card-name">ハルカ</span></div>
      <div className="tutor-card-line">{line}</div>
    </div>
  );
}
