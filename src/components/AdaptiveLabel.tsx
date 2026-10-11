import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../services/store';
import { labelText, useUiLabelState } from '../services/uiLabels';
import type { UiLabelId } from '../services/uiLabels';

// One adaptive label (docs/design-system.md §6.10). With `event`, a label whose
// next word the reader has learned plays the switch (index.css .ui-sw) once it's
// on screen, then stores the new stage. Without it (nav labels), the label just
// follows the stored stage — the page title is where the switch is announced.

const SWITCH_MS = 4600;
const FADE_MS = 700;
// Let the current label register before it changes.
const START_DELAY_MS = 700;

// Only one switch plays at a time across the app.
let playing: UiLabelId | null = null;

export function AdaptiveLabel({ id, event = false, upper = false }: { id: UiLabelId; event?: boolean; upper?: boolean }) {
  const { shown, next } = useUiLabelState(id);
  const setLabelStage = useAppStore((s) => s.setLabelStage);
  const ref = useRef<HTMLSpanElement>(null);
  const [phase, setPhase] = useState<{ kind: 'playing' | 'fading'; to: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!event || next == null || !el) return;
    const to = next;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let startTimer: ReturnType<typeof setTimeout> | undefined;
    let endTimer: ReturnType<typeof setTimeout> | undefined;
    let started = false;

    const tryStart = () => {
      if (started) return;
      if (playing || document.visibilityState !== 'visible') {
        startTimer = setTimeout(tryStart, 1000);
        return;
      }
      started = true;
      playing = id;
      setPhase({ kind: reduce ? 'fading' : 'playing', to });
      endTimer = setTimeout(() => {
        playing = null;
        setLabelStage(id, to);
        setPhase(null);
      }, reduce ? FADE_MS : SWITCH_MS);
    };

    const io = new IntersectionObserver(([entry]) => {
      clearTimeout(startTimer);
      if (entry.isIntersecting) startTimer = setTimeout(tryStart, START_DELAY_MS);
    }, { threshold: 0.6 });
    io.observe(el);

    return () => {
      io.disconnect();
      clearTimeout(startTimer);
      clearTimeout(endTimer);
      // Cut short (tab change): release the slot; it plays again next visit.
      if (started && playing === id) playing = null;
    };
  }, [event, next, id, setLabelStage]);

  if (phase) {
    return (
      <span ref={ref} className={`ui-sw ${phase.kind}`} lang="ja">
        <span className="ui-sw-en" aria-hidden="true">{labelText(id, shown, upper)}</span>
        <span className="ui-sw-ja">{labelText(id, phase.to, upper)}</span>
      </span>
    );
  }
  return (
    // data-word lets CSS tune a specific word (e.g. nav optical centring, index.css).
    <span ref={ref} className="ui-sw" lang={shown > 0 ? 'ja' : 'en'} data-word={labelText(id, shown, upper)}>
      {labelText(id, shown, upper)}
    </span>
  );
}

/** Plain-string form for attributes like placeholders; switches without an event. */
export function useAdaptiveText(id: UiLabelId): string {
  const { shown, next } = useUiLabelState(id);
  const setLabelStage = useAppStore((s) => s.setLabelStage);
  useEffect(() => {
    if (next != null) setLabelStage(id, next);
  }, [next, id, setLabelStage]);
  return labelText(id, next ?? shown);
}
