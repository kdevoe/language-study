import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ScreenContext, WorkRef } from '../../services/tutor';
import { sharedAudio } from '../../services/sharedAudio';

// The screen-context registry and open state for ハルカ (docs/tutor-agent-design.md §3).
// Each screen registers a function describing what's on it (useTutorScreen); the
// panel calls it when it opens, so the snapshot is taken at that moment (the
// paragraph on screen, the podcast's current line, whether a card is revealed).

export interface OpenOptions {
  /** A specific thing asked about (ハルカに聞く in a lookup panel). Wins over the screen. */
  ask?: ScreenContext;
  /** The Home card's line, shown as ハルカ's first message of a fresh thread. */
  opener?: string;
  /** Sunday: the weekly recap that line announces, shown under it. */
  recapId?: string;
  /** After a long-read night: the long read that line announces, shown under it. */
  work?: WorkRef;
}

interface TutorState {
  open: boolean;
  /** Edge-swipe drag in progress: px the panel has been pulled in (null = not dragging). */
  drag: number | null;
  options: OpenOptions;
  /** Bumped on every open, so the panel re-reads the screen. */
  openSeq: number;
  openTutor: (opts?: OpenOptions) => void;
  closeTutor: () => void;
  setDrag: (px: number | null) => void;
  snapshot: () => ScreenContext | null;
  register: (fn: () => ScreenContext | null, on: boolean) => void;
}

const Ctx = createContext<TutorState | null>(null);

export function TutorProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const [options, setOptions] = useState<OpenOptions>({});
  const [openSeq, setOpenSeq] = useState(0);
  const screenFn = useRef<(() => ScreenContext | null) | null>(null);
  const pausedAudio = useRef(false);

  const openTutor = useCallback((opts: OpenOptions = {}) => {
    setOptions(opts);
    setOpenSeq((n) => n + 1);
    setDrag(null);
    setOpen(true);
    // Audio pauses while ハルカ is open and resumes on close (design §3).
    const audio = sharedAudio();
    if (!audio.paused) { audio.pause(); pausedAudio.current = true; }
  }, []);

  const closeTutor = useCallback(() => {
    setOpen(false);
    setDrag(null);
    if (pausedAudio.current) {
      pausedAudio.current = false;
      sharedAudio().play().catch(() => { /* the player's own button still works */ });
    }
  }, []);

  const register = useCallback((fn: () => ScreenContext | null, on: boolean) => {
    if (on) screenFn.current = fn;
    else if (screenFn.current === fn) screenFn.current = null;   // a newer screen may have taken over
  }, []);
  const snapshot = useCallback(() => {
    try { return screenFn.current?.() ?? null; } catch { return null; }
  }, []);

  const value = useMemo(() => ({ open, drag, options, openSeq, openTutor, closeTutor, setDrag, snapshot, register }),
    [open, drag, options, openSeq, openTutor, closeTutor, snapshot, register]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTutor() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTutor outside TutorProvider');
  return v;
}

/** Optional variant for components that may render outside the provider (tests, PageHeading). */
export function useTutorMaybe() {
  return useContext(Ctx);
}

/**
 * Register what this screen shows. `describe` runs when ハルカ opens; return null
 * for nothing specific (no chip). The latest mounted screen wins; unmount clears.
 */
export function useTutorScreen(describe: () => ScreenContext | null) {
  const ctx = useContext(Ctx);
  const ref = useRef(describe);
  ref.current = describe;
  const register = ctx?.register;
  useEffect(() => {
    if (!register) return;
    const fn = () => ref.current();
    register(fn, true);
    return () => register(fn, false);
  }, [register]);
}
