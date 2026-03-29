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
  const spanRef = useRef<HTMLSpanElement>(null);

  const handlePointerDown = () => {
    startTime.current = Date.now();
    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = window.setTimeout(() => {
      if (furigana && furigana.trim() !== '') {
        const rect = spanRef.current?.getBoundingClientRect();
        if (rect) {
          setPeekPos({
            top: rect.top - 65, // slightly more float
            left: rect.left + rect.width / 2
          });
          setIsPeeking(true);
          if (navigator.vibrate) navigator.vibrate(40);
        }
      }
    }, 350);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const duration = Date.now() - startTime.current;

    if (isPeeking) {
      setIsPeeking(false);
      touchLock.lock(); // Lock to prevent accidental second word tap
    } else if (duration < 350) {
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
        style={{ cursor: 'pointer', touchAction: 'none' }}
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
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
          color: 'var(--text-main)',
          padding: '12px 18px',
          borderRadius: '12px',
          border: '1px solid var(--border-light)',
          zIndex: 9999,
          pointerEvents: 'none',
          fontSize: '1.35rem',
          fontWeight: 700,
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
