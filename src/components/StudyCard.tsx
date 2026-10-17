import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

// The study card's physical feel, shared by both decks (docs/design-system.md
// §6.16, mockup docs/mockups/flashcard-feel-2.html, variant C). Still at rest; it
// moves only in answer to a touch:
//   • press    — the card gives slightly under the thumb and its shadow tightens
//   • flip     — it turns evenly (no spring), lifting 6px off the table mid-turn
//                while the shadow on the table softens
//   • move on  — it drifts up 24px as it fades, and the pile beneath moves up one
//                place, so the next card is already there
// The cards still to come wait underneath (up to two show) and the pile thins
// as the session goes.
//
// Layers: stack › pile cards + slot (enter/leave) › ground shadow + lift (rise)
// › press (sink) › card (rotateY, two CardFaces).

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const FLIP_EASE: [number, number, number, number] = [0.45, 0, 0.2, 1];
const FLIP_S = 0.6;

// Pile positions by depth below the top card (transform origin: bottom centre).
// Depth 0 is only shown while the top card is leaving: the next card rising into place.
const DEPTH = [
  { y: 0, scale: 1, opacity: 1 },
  { y: 12, scale: 0.95, opacity: 1 },
  { y: 22, scale: 0.9, opacity: 0.75 },
  { y: 30, scale: 0.86, opacity: 0 },
];
/** Room the pile needs under the card. */
export const PILE_SPACE = '22px';

export function StudyCard({ cardKey, index, total, revealed, height, onClick, cursor = 'pointer', front, back }: {
  cardKey: string;
  /** Position in the session and its length: the pile shows what's left. */
  index: number;
  total: number;
  revealed: boolean;
  height: string;
  onClick: (e: React.MouseEvent) => void;
  cursor?: string;
  front: React.ReactNode;
  back: React.ReactNode;
}) {
  const [pressed, setPressed] = useState(false);
  const [flipping, setFlipping] = useState(false);
  // The key on screen; differs from cardKey while the previous card leaves.
  const [shownKey, setShownKey] = useState(cardKey);
  const leaving = shownKey !== cardKey;

  // Rise during a flip of the same card (not when a new card arrives face down).
  const last = useRef({ cardKey, revealed });
  useEffect(() => {
    const prev = last.current;
    last.current = { cardKey, revealed };
    if (prev.cardKey !== cardKey || prev.revealed === revealed) return;
    setFlipping(true);
    const t = setTimeout(() => setFlipping(false), FLIP_S * 1000 + 50);
    return () => clearTimeout(t);
  }, [cardKey, revealed]);

  const pile: number[] = [];
  for (let k = leaving ? index : index + 1; k <= index + 2 && k < total; k++) pile.push(k);

  const release = () => setPressed(false);

  return (
    <div style={{ position: 'relative', width: '100%', height, transition: 'height 0.4s cubic-bezier(0.22, 1, 0.36, 1)' }}>
      {pile.map((k) => (
        <motion.div
          key={k}
          aria-hidden
          className="study-pile"
          initial={DEPTH[3]}
          animate={DEPTH[Math.min(k - index, 3)]}
          transition={{ duration: 0.38, ease: EASE }}
        />
      ))}

      <AnimatePresence mode="wait" onExitComplete={() => setShownKey(cardKey)}>
        <motion.div
          key={cardKey}
          initial={false}
          exit={{ opacity: 0, y: -24, transition: { duration: 0.34, ease: EASE } }}
          style={{ position: 'absolute', inset: 0 }}
        >
          <div className="study-shadow">
            <div className={`study-ground${pressed ? ' down' : ''}${flipping ? ' flipping' : ''}`} />
          </div>
          <div className={`study-lift${flipping ? ' flipping' : ''}`}>
            <div className={`study-press${pressed ? ' down' : ''}`}>
              <motion.div
                onClick={onClick}
                onPointerDown={() => setPressed(true)}
                onPointerUp={release}
                onPointerLeave={release}
                onPointerCancel={release}
                initial={false}
                animate={{ rotateY: revealed ? 180 : 0 }}
                transition={{ duration: FLIP_S, ease: FLIP_EASE }}
                style={{ position: 'absolute', inset: 0, transformStyle: 'preserve-3d', cursor, WebkitTapHighlightColor: 'transparent' }}
              >
                {front}
                {back}
              </motion.div>
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
