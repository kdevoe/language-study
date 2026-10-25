// Grammar cards (database/43), in their own small persisted store (localStorage
// key `yugen-grammar`) like the kanji deck, so they never grow the main blob. The
// server writes the cards (learner-dream, after each weekly recap); this store
// pulls them on app open, schedules each grade with FSRS, and writes the schedule
// back with a log row. The learner can't insert cards, only update their own, so
// grades are updates, never upserts.

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { supabase } from './supabase';
import { useAppStore } from './store';
import { schedule, type Rating } from './srs';
import { grammarSrsState, selectGrammarCards, type GrammarCard } from './grammarDeck';

interface GrammarState {
  cards: Record<string, GrammarCard>;
  /** Pull the server rows; a schedule graded here more recently wins and is pushed. */
  sync: (userId: string) => Promise<void>;
  review: (id: string, rating: Rating, picked: string, thinkMs: number | null, now: number) => void;
}

const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
const ms = (ts: string | null) => (ts ? new Date(ts).getTime() : null);

interface GrammarRow {
  id: string;
  pattern: string;
  before: string;
  answer: string;
  wrong: string;
  after: string;
  explain: string;
  from_slip: boolean;
  stability: number | null;
  fsrs_difficulty: number | null;
  due_at: string | null;
  last_reviewed_at: string | null;
  interval_days: number | null;
  reps: number | null;
  lapses: number | null;
  srs_status: GrammarCard['status'] | null;
  introduced_at: string | null;
  created_at: string;
  updated_at: string;
}

function fromRow(r: GrammarRow): GrammarCard {
  return {
    id: r.id,
    pattern: r.pattern,
    before: r.before,
    answer: r.answer,
    wrong: r.wrong,
    after: r.after,
    explain: r.explain,
    fromSlip: r.from_slip,
    stability: r.stability,
    fsrsDifficulty: r.fsrs_difficulty,
    dueAt: ms(r.due_at),
    lastReviewedAt: ms(r.last_reviewed_at),
    intervalDays: r.interval_days,
    reps: r.reps ?? 0,
    lapses: r.lapses ?? 0,
    status: r.srs_status ?? 'new',
    introducedAt: ms(r.introduced_at),
    createdAt: ms(r.created_at) ?? 0,
    updatedAt: ms(r.updated_at) ?? 0,
  };
}

/** The schedule columns only: the card's text is the server's. */
function scheduleRow(c: GrammarCard) {
  return {
    stability: c.stability,
    fsrs_difficulty: c.fsrsDifficulty,
    due_at: iso(c.dueAt),
    last_reviewed_at: iso(c.lastReviewedAt),
    interval_days: c.intervalDays,
    reps: c.reps,
    lapses: c.lapses,
    srs_status: c.status,
    introduced_at: iso(c.introducedAt),
    updated_at: iso(c.updatedAt),
  };
}

async function pushSchedule(userId: string, c: GrammarCard) {
  const { error } = await supabase.from('grammar_cards').update(scheduleRow(c)).eq('id', c.id).eq('user_id', userId);
  if (error) console.warn('[grammar] update failed:', error.message);
}

async function currentUserId(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.user?.id ?? null;
}

export const useGrammarStore = create<GrammarState>()(
  persist(
    (set, get) => ({
      cards: {},

      sync: async (userId) => {
        // At most 9 a week, so one page covers years of them.
        const { data, error } = await supabase.from('grammar_cards').select('*').eq('user_id', userId)
          .order('created_at').limit(1000);
        if (error) { console.warn('[grammar] fetch failed:', error.message); return; } // keep local as is
        const local = get().cards;
        const merged: Record<string, GrammarCard> = {};
        const push: GrammarCard[] = [];
        for (const row of (data ?? []) as GrammarRow[]) {
          const r = fromRow(row);
          const l = local[r.id];
          if (l && l.updatedAt > r.updatedAt) {
            merged[r.id] = { ...r, ...pickSchedule(l) };
            push.push(merged[r.id]);
          } else {
            merged[r.id] = r;
          }
        }
        set({ cards: merged });
        await Promise.all(push.map((c) => pushSchedule(userId, c)));
      },

      review: (id, rating, picked, thinkMs, now) => {
        if (useAppStore.getState().sandboxMode) return;
        const c = get().cards[id];
        if (!c) return;
        const sched = schedule(grammarSrsState(c), rating, now);
        const updated: GrammarCard = {
          ...c,
          stability: sched.stability,
          fsrsDifficulty: sched.fsrsDifficulty,
          dueAt: sched.dueAt,
          lastReviewedAt: now,
          intervalDays: sched.intervalDays,
          reps: sched.reps,
          lapses: sched.lapses,
          status: sched.status,
          introducedAt: c.introducedAt ?? now,
          updatedAt: now,
        };
        set({ cards: { ...get().cards, [id]: updated } });
        useAppStore.getState().recordReview(now);
        currentUserId().then(async (uid) => {
          if (!uid) return;
          await pushSchedule(uid, updated);
          const { error } = await supabase.from('grammar_review_log').insert({
            user_id: uid, card_id: id, rating, picked, correct: picked === c.answer,
            interval_days: sched.intervalDays, stability_after: sched.stability, think_ms: thinkMs, reviewed_at: iso(now),
          });
          if (error) console.warn('[grammar] review log failed:', error.message);
        });
      },
    }),
    {
      name: 'yugen-grammar',
      version: 1,
      storage: createJSONStorage(() => ({
        getItem: (name) => {
          try { return localStorage.getItem(name); } catch { return null; }
        },
        setItem: (name, value) => {
          // Quota or blocked storage: the server copy is the source of truth.
          try { localStorage.setItem(name, value); } catch { /* ignore */ }
        },
        removeItem: (name) => {
          try { localStorage.removeItem(name); } catch { /* ignore */ }
        },
      })),
      partialize: (s) => ({ cards: s.cards }),
    },
  ),
);

function pickSchedule(c: GrammarCard): Partial<GrammarCard> {
  const { stability, fsrsDifficulty, dueAt, lastReviewedAt, intervalDays, reps, lapses, status, introducedAt, updatedAt } = c;
  return { stability, fsrsDifficulty, dueAt, lastReviewedAt, intervalDays, reps, lapses, status, introducedAt, updatedAt };
}

/** Today's grammar cards for the 単語 session. */
export function buildGrammarCards(now = Date.now()) {
  return selectGrammarCards(Object.values(useGrammarStore.getState().cards), now);
}
