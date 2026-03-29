import React, { useState, useRef } from 'react';

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
  const timerRef = useRef<number | null>(null);
  const startTime = useRef(0);

  const handlePointerDown = () => {
    startTime.current = Date.now();
    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = window.setTimeout(() => {
      if (furigana) {
        setIsPeeking(true);
        if (navigator.vibrate) navigator.vibrate(40);
      }
    }, 350);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const duration = Date.now() - startTime.current;

    if (isPeeking) {
      setIsPeeking(false);
    } else if (duration < 350) {
      if (onClick) onClick(e);
    }
  };

  const handlePointerLeave = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setIsPeeking(false);
  };

  if (!furigana) {
    return <span 
      className={isSelected ? 'word-highlight' : ''}
      onPointerDown={handlePointerDown} 
      onPointerUp={handlePointerUp} 
      onPointerLeave={handlePointerLeave}
    >{word}</span>;
  }

  return (
    <ruby 
      className={`${isPeeking ? 'peek-furigana' : ''} ${isSelected ? 'word-highlight' : ''}`}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
    >
      {word}
      <rt>{furigana}</rt>
    </ruby>
  );
}
