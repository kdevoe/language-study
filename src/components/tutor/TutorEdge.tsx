import { useRef } from 'react';
import { useTutor } from './TutorProvider';
import { useAppStore } from '../../services/store';

// Swipe in from the hand-side edge to open ハルカ (docs/tutor-agent-design.md §2).
// The touch must START inside a 16px strip, so the Feed's card swipes and the
// lists' swipe-to-delete never compete with it; the panel follows the finger and
// commits once it has been pulled in past COMMIT_PX. Installed PWAs get the edge
// (no browser back/forward swipe); in a Safari tab the bottom-nav drag is the way in.

const COMMIT_PX = 70;

export function TutorEdge({ hidden }: { hidden?: boolean }) {
  const { open, openTutor, setDrag } = useTutor();
  const hand = useAppStore((s) => s.tutorHand);
  const start = useRef<{ x: number; y: number; horizontal: boolean | null } | null>(null);
  const pulled = useRef(0);

  if (open || hidden) return null;
  const side = hand === 'left' ? 'l' : 'r';

  const onTouchStart = (e: React.TouchEvent) => {
    start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, horizontal: null };
    pulled.current = 0;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const s = start.current;
    if (!s) return;
    const dx = e.touches[0].clientX - s.x;
    const dy = e.touches[0].clientY - s.y;
    if (s.horizontal === null && Math.abs(dx) + Math.abs(dy) > 8) s.horizontal = Math.abs(dx) > Math.abs(dy);
    if (!s.horizontal) return;
    pulled.current = Math.max(0, side === 'r' ? -dx : dx);
    setDrag(pulled.current);
  };
  const onTouchEnd = () => {
    const committed = pulled.current > COMMIT_PX;
    start.current = null;
    pulled.current = 0;
    if (committed) openTutor();
    else setDrag(null);
  };

  return (
    <>
      <div className={`tutor-edge-mark ${side}`} />
      <div
        className={`tutor-edge ${side}`}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      />
    </>
  );
}
