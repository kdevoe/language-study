import { useState, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { touchLock } from '../services/touchLock';

type FuriganaMode = 'always' | 'never' | 'dynamic';

// Deterministic tap-target weight. Words likely to be looked up (kanji content
// words) get a wider invisible hit area and sit above their neighbors so a
// near-miss toward an adjacent particle still resolves to the intended word.
export type HitWeight = 'hi' | 'mid' | 'lo';

const HIT_STYLE: Record<HitWeight, React.CSSProperties> = {
  hi: { paddingLeft: '0.4em', paddingRight: '0.4em', marginLeft: '-0.4em', marginRight: '-0.4em', zIndex: 3 },
  mid: { paddingLeft: '0.15em', paddingRight: '0.15em', marginLeft: '-0.15em', marginRight: '-0.15em', zIndex: 2 },
  lo: { zIndex: 1 },
};

interface Props {
  word: string;
  furigana?: string;
  mode?: FuriganaMode;
  isSelected?: boolean;
  hitWeight?: HitWeight;
  /** The part of the word inside an open grammar point's span, lit up (#43). */
  lit?: [number, number];
  onClick?: (e: any) => void;
}

export function FuriganaText({ word, furigana, isSelected, hitWeight = 'mid', lit, onClick }: Props) {
  const [isPeeking, setIsPeeking] = useState(false);
  // The word's box when the peek opened; the bubble is placed from it once it
  // has a size (see below).
  const [peekAt, setPeekAt] = useState<DOMRect | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);
  const startTime = useRef(0);
  const startPos = useRef({ x: 0, y: 0 });
  const spanRef = useRef<HTMLSpanElement>(null);

  const handlePointerDown = (e: React.PointerEvent) => {
    startTime.current = Date.now();
    startPos.current = { x: e.clientX, y: e.clientY };
    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = window.setTimeout(() => {
      const curRect = spanRef.current?.getBoundingClientRect();
      if (curRect && furigana && furigana.trim() !== '') {
        setPeekAt(curRect);
        setIsPeeking(true);
        if (navigator.vibrate) navigator.vibrate(40);
      }
    }, 350);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const duration = Date.now() - startTime.current;
    
    // Distance check
    const dist = Math.sqrt(Math.pow(e.clientX - startPos.current.x, 2) + Math.pow(e.clientY - startPos.current.y, 2));
    
    if (isPeeking) {
      setIsPeeking(false);
      touchLock.lock();
      return;
    }

    if (dist > 15) return; 

    if (duration < 350) {
      if (touchLock.isLocked()) return;
      if (onClick) onClick(e);
    }
  };

  const handlePointerLeave = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (isPeeking) {
      setIsPeeking(false);
      touchLock.lock();
    }
  };

  // The browser fires pointercancel (instead of pointerup) when it reclaims the
  // touch for a scroll gesture. Without handling it, the peek timer leaks and a
  // dropped tap leaves no trace — clean up so the next tap isn't swallowed.
  const handlePointerCancel = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (isPeeking) setIsPeeking(false);
  };

  // Centred over the word, but kept on screen: a word at the edge of a line
  // used to push half the reading off the side, and one on the top line pushed
  // it above the screen (then it goes under the word instead).
  useLayoutEffect(() => {
    const el = bubbleRef.current;
    if (!isPeeking || !peekAt || !el) return;
    const margin = 12;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const centre = peekAt.left + peekAt.width / 2;
    const left = Math.min(Math.max(centre - w / 2, margin), window.innerWidth - w - margin);
    const above = peekAt.top - h - 14;
    el.style.left = `${Math.max(margin, left)}px`;
    el.style.top = `${above >= margin ? above : peekAt.bottom + 14}px`;
    el.style.visibility = 'visible';
  }, [isPeeking, peekAt]);

  return (
    <>
      <span 
        ref={spanRef}
        className={isSelected ? 'word-highlight' : ''}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onPointerCancel={handlePointerCancel}
        style={{
          cursor: 'pointer',
          display: isSelected ? 'inline-block' : 'inline',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          WebkitTouchCallout: 'none',
          // Tell the browser this span won't pan/zoom, so it dispatches taps
          // immediately instead of holding them in scroll-vs-tap limbo (the
          // cause of light/quick taps not registering). Vertical scroll of the
          // article still works because it's driven by the parent container.
          touchAction: 'manipulation',
          position: 'relative',
          // Skip hit padding while selected so it doesn't fight the word-highlight pill.
          ...(isSelected ? {} : HIT_STYLE[hitWeight]),
        }}
      >
        {lit ? <>{word.slice(0, lit[0])}<span className="grammar-lit">{word.slice(lit[0], lit[1])}</span>{word.slice(lit[1])}</> : word}
      </span>

      {isPeeking && furigana && createPortal(
        <div ref={bubbleRef} style={{
          position: 'fixed',
          top: 0,
          left: 0,
          visibility: 'hidden', // until placed
          maxWidth: 'calc(100vw - 24px)',
          backgroundColor: 'var(--bg-pure)',
          boxShadow: '0 12px 40px rgba(0,0,0,0.3)',
          color: 'var(--text-main)',
          padding: '12px 20px',
          borderRadius: '14px',
          border: '1px solid var(--border-light)',
          zIndex: 9999,
          pointerEvents: 'none',
          fontSize: '1.4rem',
          fontWeight: 800,
          whiteSpace: 'nowrap',
          lineHeight: 1,
          fontFamily: 'var(--font-sans)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          animation: 'peekFadeIn 0.1s ease-out forwards'
        }}>
          {furigana}
        </div>,
        document.body
      )}
    </>
  );
}
