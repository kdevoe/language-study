import { useEffect } from 'react';
import { send as sendWrite } from './outbox';
import { isUnlockClip, sharedAudio } from './sharedAudio';

// Daily activity for 進捗 (database/37_daily_activity.sql): seconds on screen,
// reading, listening, in the decks and with ハルカ, plus turns sent to her.
// Amounts build up here and are added to today's row about once a minute and
// whenever the app hides.

type Kind = 'app' | 'read' | 'listen' | 'review' | 'chat' | 'turns';
type Live = 'review' | 'chat';

const DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true';
const TICK_MS = 5000;
const FLUSH_MS = 60_000;

const pending: Record<Kind, number> = { app: 0, read: 0, listen: 0, review: 0, chat: 0, turns: 0 };
const live: Record<Live, number> = { review: 0, chat: 0 };   // counts, so overlapping screens don't cancel out
let started = false;

/** The learner's local calendar day (same as tutor.ts; kept here so api.ts can import this without a cycle). */
export const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Add an amount (seconds, or turns) to today's activity. */
export function addActivity(kind: Kind, amount: number) {
  if (amount > 0) pending[kind] += amount;
}

/** Count seconds toward `kind` while `on` and the app is visible (a deck on screen, ハルカ open). */
export function useActivityWhile(kind: Live, on: boolean) {
  useEffect(() => {
    if (!on) return;
    live[kind]++;
    return () => { live[kind]--; };
  }, [kind, on]);
}

async function flush() {
  const send: Record<Kind, number> = { ...pending };
  for (const k of Object.keys(send) as Kind[]) {
    send[k] = Math.floor(send[k]);
    pending[k] -= send[k];   // keep the fractions for next time
  }
  if (!Object.values(send).some((v) => v > 0) || DEV_MODE) return;
  // Offline, the outbox keeps it (with today's date) until the connection is back.
  const { error } = await sendWrite({ t: 'rpc', fn: 'bump_daily_activity', args: {
    p_day: localDay(), p_app: send.app, p_read: send.read, p_listen: send.listen,
    p_review: send.review, p_chat: send.chat, p_turns: send.turns,
  } });
  if (error) console.warn('[activity] flush failed:', error.message);
}

/** Start counting: once, from App. */
export function startActivityTracking() {
  if (started) return;
  started = true;

  window.setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    const s = TICK_MS / 1000;
    pending.app += s;
    if (live.review > 0) pending.review += s;
    if (live.chat > 0) pending.chat += s;
  }, TICK_MS);
  window.setInterval(flush, FLUSH_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  window.addEventListener('pagehide', () => { flush(); });

  // Listening: real playback time on the shared element (podcasts and songs),
  // from currentTime steps, so seeking doesn't count and speed is allowed for.
  const audio = sharedAudio();
  let last: number | null = null;
  audio.addEventListener('timeupdate', () => {
    if (audio.paused || isUnlockClip(audio)) { last = null; return; }
    const t = audio.currentTime;
    if (last !== null && t > last && t - last < 3) pending.listen += (t - last) / (audio.playbackRate || 1);
    last = t;
  });
  for (const ev of ['pause', 'seeking', 'emptied', 'ended']) audio.addEventListener(ev, () => { last = null; });
}
