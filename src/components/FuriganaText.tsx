import React, { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { touchLock } from '../services/touchLock';

type FuriganaMode = 'always' | 'never' | 'dynamic';

interface Props {
  word: string;
  furigana?: string;
  mode?: FuriganaMode;
  isSelected?: boolean;
  onClick?: (e: React.MouseEvent | React.TouchEvent) => void;
}

export function FuriganaText({ word, furigana, isSelected, onClick }: Props) {
  const [isPeeking, setIsPeeking] = useState(false);
  const [peekPos, setPeekPos] = useState({ top: 0, left: 0 });
  const timerRef = useRef<number | null>(null);
  const startTime = useRef(0);
  const startPos = useRef({ x: 0, y: 0 });
  const spanRef = useRef<HTMLSpanElement>(null);

  const handlePointerDown = (e: React.PointerEvent) => {
    // We REMOVED touchAction: none to restore system scrolling. 
    // We use user-select: none in CSS to prevent blue boxes.
    startTime.current = Date.now();
    startPos.current = { x: e.clientX, y: e.clientY };
    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = window.setTimeout(() => {
      // Sensitivity check: don't peek if they started a drag
      const curRect = spanRef.current?.getBoundingClientRect();
      if (curRect && furigana && furigana.trim() !== '') {
        setPeekPos({
          top: curRect.top - 70,
          left: curRect.left + curRect.width / 2
        });
        setIsPeeking(true);
        if (navigator.vibrate) navigator.vibrate(40);
      }
    }, 350);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const duration = Date.now() - startTime.current;
    
    // Distance check: ignore if they moved more than 25px (scrolling)
    // We increased this threshold to allow slight "jitters" during tap
    const dist = Math.sqrt(Math.pow(e.clientX - startPos.current.x, 2) + Math.pow(e.clientY - startPos.current.y, 2));
    
    if (isPeeking) {
      setIsPeeking(false);
      touchLock.lock();
      return;
    }

    if (dist > 15) return; // User is scrolling, not tapping

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

  return (
    <>
      <span 
        ref={spanRef}
        className={isSelected ? 'word-highlight' : ''}
        onPointerDown={handlePointerDown} 
        onPointerUp={handlePointerUp} 
        onPointerLeave={handlePointerLeave}
        style={{ 
          cursor: 'pointer',
          display: 'inline-block',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          WebkitTouchCallout: 'none'
        }}
      >
        {word}
      </span>

      {isPeeking && furigana && createPortal(
        <div style={{
          position: 'fixed',
          top: peekPos.top,
          left: peekPos.left,
          transform: 'translateX(-50%)',
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
