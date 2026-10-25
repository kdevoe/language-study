import { useEffect, useState } from 'react';
import { fetchRecaps, practiceLine, recapRange, type RecapListItem } from '../services/tutor';
import { readListCache, writeListCache } from '../services/listCache';
import { RecapSheet } from './tutor/RecapSheet';
import { useTutor } from './tutor/TutorProvider';

// The bottom of 進捗 (docs/grammar-cards-plan.md, mockup docs/mockups/grammar-cards.html, 3):
// every weekly recap ハルカ wrote, newest first. A row opens the same sheet as
// her chat; ハルカと練習する opens the chat and says it for you. Nothing shows
// until there's a recap. Cache-first, like the rest of 進捗.
export function WeeklyRecaps() {
  const [recaps, setRecaps] = useState<RecapListItem[]>(() => readListCache<RecapListItem>('recaps') ?? []);
  const [openId, setOpenId] = useState<string | null>(null);
  const { openTutor } = useTutor();

  useEffect(() => {
    let live = true;
    fetchRecaps()
      .then((rows) => { if (!live) return; setRecaps(rows); writeListCache('recaps', rows); })
      .catch((e) => console.warn('[progress] recaps failed:', e));
    return () => { live = false; };
  }, []);

  if (recaps.length === 0) return null;
  return (
    <section className="recaps">
      <div className="recaps-k">WEEKLY RECAPS</div>
      {recaps.map((r) => (
        <button key={r.id} className="recaps-row" onClick={() => setOpenId(r.id)}>
          <span className="recaps-d">{recapRange(r)}</span>
          <span className="recaps-t">{r.title}</span>
        </button>
      ))}
      <RecapSheet id={openId} onClose={() => setOpenId(null)}
        onPractice={(pattern) => { setOpenId(null); openTutor({ send: practiceLine(pattern) }); }} />
    </section>
  );
}
