import React, { useState, useRef } from 'react';

type FuriganaMode = 'always' | 'never' | 'dynamic';

interface Props {
  word: string;
  furigana?: string;
  mode?: FuriganaMode;
  isKnown?: boolean;
  onClick?: () => void;
}

export function FuriganaText({ word, furigana, onClick }: Props) {
  const [showFurigana, setShowFurigana] = useState(false);
  const timerRef = useRef<number | null>(null);
  const isLongPressRef = useRef(false);

  const handlePointerDown = () => {
    isLongPressRef.current = false;
    timerRef.current = window.setTimeout(() => {
      isLongPressRef.current = true;
      if (navigator.vibrate) navigator.vibrate(50);
      if (onClick) onClick();
    }, 450);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!isLongPressRef.current && furigana) {
      e.preventDefault();
      setShowFurigana(!showFurigana);
    } else if (!isLongPressRef.current && !furigana && onClick) {
      // It's a short tap but there is no furigana to show, so execute click handler directly
      e.preventDefault();
      onClick();
    }
  };

  const handlePointerLeave = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  };

  if (!furigana) {
    return <span 
      onPointerDown={handlePointerDown} 
      onPointerUp={handlePointerUp} 
      onPointerLeave={handlePointerLeave}
    >{word}</span>;
  }

  return (
    <ruby 
      className={showFurigana ? 'force-show' : ''}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
    >
      {word}
      <rt>{furigana}</rt>
    </ruby>
  );
}
