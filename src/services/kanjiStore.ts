// RTK kanji deck state, in its own small persisted store (localStorage key
// `yugen-kanji`) so it never grows the main `yugen-storage` blob. Holds only the
// introduced kanji (726 at import, 2,200 at most); the review history stays in
// Supabase. Selection and seeding logic lives in kanjiDeck.ts, scheduling in srs.ts.
//
// The deck is "on" once it has rows: the Anki import creates them, and from then on
// the daily drip adds `newKanjiPerDay` kanji in Heisig order. The user's RTK level
// (rtkLevel, which steers article rewriting) follows the deck's highest Heisig number.

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { rtkKanjiList } from '../data/rtkKanji';
import { sessionUserId } from './supabase';
import { useAppStore } from './store';
import { scheduleKanji, type Rating } from './srs';
import {
  highestHeisig, kanjiSrsState, kanjiToIntroduce, newKanjiProgress, selectKanjiDeck,
  type KanjiCard, type KanjiProgress,
} from './kanjiDeck';
import { fetchKanjiProgress, logKanjiReview, upsertKanjiProgress } from './kanjiApi';

interface KanjiState {
  progress: Record<string, KanjiProgress>;
  newKanjiPerDay: number;
  setNewKanjiPerDay: (n: number) => void;
  /** Pull the server rows, merge last-write-wins, push anything newer locally. */
  sync: (userId: string) => Promise<void>;
  /** Add today's new kanji (once per calendar day, deck must already exist). */
  introduceDaily: (userId: string | null, now: number) => Promise<void>;
  review: (kanji: string, rating: Rating, thinkMs: number | null, now: number) => void;
}

async function currentUserId(): Promise<string | null> {
  return sessionUserId();
}

// Keep the app-wide RTK level on the deck's frontier (article rewriting reads it).
function syncRtkLevel(progress: Record<string, KanjiProgress>) {
  const level = highestHeisig(Object.values(progress));
  const app = useAppStore.getState();
  if (level > 0 && app.rtkLevel !== level) app.setRtkLevel(level);
}

export const useKanjiStore = create<KanjiState>()(
  persist(
    (set, get) => ({
      progress: {},
      newKanjiPerDay: 3,
      setNewKanjiPerDay: (n) => set({ newKanjiPerDay: Math.min(20, Math.max(0, Math.round(n))) }),

      sync: async (userId) => {
        const remote = await fetchKanjiProgress(userId);
        if (remote == null) return; // offline or table missing: keep local as is
        const local = get().progress;
        const merged: Record<string, KanjiProgress> = {};
        for (const r of remote) merged[r.kanji] = r;
        const push: KanjiProgress[] = [];
        for (const l of Object.values(local)) {
          const r = merged[l.kanji];
          if (!r || l.updatedAt > r.updatedAt) {
            merged[l.kanji] = l;
            push.push(l);
          }
        }
        set({ progress: merged });
        if (push.length > 0) await upsertKanjiProgress(userId, push);
        syncRtkLevel(merged);
      },

      introduceDaily: async (userId, now) => {
        const progress = get().progress;
        const rows = Object.values(progress);
        if (rows.length === 0) return; // no deck yet (nothing imported)
        const picks = kanjiToIntroduce(rows, rtkKanjiList, get().newKanjiPerDay, now);
        if (picks.length === 0) return;
        const added = picks
          .filter((p) => !progress[p.kanji])
          .map((p) => newKanjiProgress(p.kanji, p.heisigNo, now));
        if (added.length === 0) return;
        const next = { ...progress };
        for (const a of added) next[a.kanji] = a;
        set({ progress: next });
        syncRtkLevel(next);
        if (userId && !useAppStore.getState().sandboxMode) await upsertKanjiProgress(userId, added);
      },

      review: (kanji, rating, thinkMs, now) => {
        if (useAppStore.getState().sandboxMode) return;
        const p = get().progress[kanji];
        if (!p) return;
        const sched = scheduleKanji(kanjiSrsState(p), rating, now);
        const updated: KanjiProgress = {
          ...p,
          stability: sched.stability,
          fsrsDifficulty: sched.fsrsDifficulty,
          dueAt: sched.dueAt,
          lastReviewedAt: now,
          intervalDays: sched.intervalDays,
          reps: sched.reps,
          lapses: sched.lapses,
          status: sched.status,
          updatedAt: now,
        };
        set({ progress: { ...get().progress, [kanji]: updated } });
        useAppStore.getState().recordReview(now);
        currentUserId().then((uid) => {
          if (!uid) return;
          upsertKanjiProgress(uid, [updated]);
          logKanjiReview(uid, {
            kanji, rating, intervalDays: sched.intervalDays, stabilityAfter: sched.stability, thinkMs, reviewedAt: now,
          });
        });
      },
    }),
    {
      name: 'yugen-kanji',
      version: 1,
      storage: createJSONStorage(() => ({
        getItem: (name) => {
          try { return localStorage.getItem(name); } catch { return null; }
        },
        setItem: (name, value) => {
          // Quota or blocked storage: the server copy is the source of truth and the
          // next sync restores it, so a failed local write is safe to drop.
          try { localStorage.setItem(name, value); } catch { /* ignore */ }
        },
        removeItem: (name) => {
          try { localStorage.removeItem(name); } catch { /* ignore */ }
        },
      })),
      partialize: (s) => ({ progress: s.progress, newKanjiPerDay: s.newKanjiPerDay }),
    },
  ),
);

/** Today's kanji session, from the current progress. */
export function buildKanjiDeck(now = Date.now()): KanjiCard[] {
  return selectKanjiDeck(Object.values(useKanjiStore.getState().progress), now);
}

/** Whether the user has a kanji deck at all (imported or started). */
export function hasKanjiDeck(): boolean {
  return Object.keys(useKanjiStore.getState().progress).length > 0;
}
