import React from 'react';

type FuriganaMode = 'always' | 'never' | 'dynamic';

interface Props {
  word: string;
  furigana?: string;
  mode?: FuriganaMode;
  isKnown?: boolean;
  onClick?: () => void;
}

export function FuriganaText({ word, furigana, mode = 'always', isKnown = false, onClick }: Props) {
  const show = mode === 'always' || (mode === 'dynamic' && !isKnown);

  const handleClick = (e: React.MouseEvent) => {
    if (onClick) {
      e.stopPropagation();
      onClick();
    }
  };

  const style: React.CSSProperties = {
    cursor: onClick ? 'pointer' : 'auto',
    borderBottom: onClick ? '1px dashed transparent' : 'none',
    transition: 'border-color 0.2s ease',
  };

  if (!furigana || !show) {
    return (
      <span onClick={handleClick} style={style} className="interactive-word">
        {word}
      </span>
    );
  }

  return (
    <ruby onClick={handleClick} style={style} className="interactive-word">
      {word}
      <rt>{furigana}</rt>
    </ruby>
  );
}
