// Grammar cards (database/43-44), in their own small persisted store (localStorage
// key `yugen-grammar`) like the kanji deck, so they never grow the main blob. The
// server writes the cards and their sentence pools (learner-dream, after each
// weekly recap); this store pulls them on app open, schedules each grade with
// FSRS, and writes the schedule back with a log row, marking the sentence shown
// so the next review shows another. The learner can't insert cards, only update
// their own, so grades are updates, never upserts.

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { sessionUserId, supabase } from './supabase';
import { send } from './outbox';
import { useAppStore } from './store';
import { schedule, type Rating } from './srs';
import { grammarSrsState, selectGrammarCards, withNextSentence, type GrammarCard, type GrammarSentence } from './grammarDeck';

interface GrammarState {
  cards: Record<string, GrammarCard>;
  /** Pull the server rows; a schedule graded here more recently wins and is pushed. */
  sync: (userId: string) => Promise<void>;
  /** Grade the card on the sentence it showed (`shown`: the card as on screen). */
  review: (shown: GrammarCard, rating: Rating, picked: string, thinkMs: number | null, now: number) => void;
  /** A sentence came up without a grade (a もう一度 repeat). */
  markShown: (cardId: string, sentenceId: string | null, now: number) => void;
}

const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
const ms = (ts: string | null) => (ts ? new Date(ts).getTime() : null);

interface SentenceRow {
  id: string;
  before: string;
  answer: string;
  wrong: string;
  after: string;
  from_slip: boolean;
  shown_at: string | null;
  created_at: string;
}

interface GrammarRow {
  id: string;
  pattern: string;
  rule: string | null;
  sentences: SentenceRow[] | null;
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
    rule: r.rule ?? r.pattern,
    sentences: (r.sentences ?? []).map((x) => ({
      id: x.id, before: x.before, answer: x.answer, wrong: x.wrong, after: x.after,
      fromSlip: x.from_slip, shownAt: ms(x.shown_at), createdAt: ms(x.created_at) ?? 0,
    })),
    sentenceId: null,
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
  const { error } = await send({
    t: 'update', table: 'grammar_cards', patch: scheduleRow(c), match: { id: c.id, user_id: userId }, key: `grammar_cards:${c.id}`,
  });
  if (error) console.warn('[grammar] update failed:', error.message);
}

function pushShown(userId: string, sentenceId: string, now: number) {
  send({
    t: 'update', table: 'grammar_sentences', patch: { shown_at: iso(now) }, match: { id: sentenceId, user_id: userId }, key: `grammar_sentences:${sentenceId}`,
  }).then(({ error }) => { if (error) console.warn('[grammar] shown failed:', error.message); });
}

/** The card with one sentence marked shown at `now`. */
function shown(c: GrammarCard, sentenceId: string | null, now: number): GrammarCard {
  if (!sentenceId) return c;
  return { ...c, sentences: c.sentences.map((x) => (x.id === sentenceId ? { ...x, shownAt: now } : x)) };
}

async function currentUserId(): Promise<string | null> {
  return sessionUserId();
}

export const useGrammarStore = create<GrammarState>()(
  persist(
    (set, get) => ({
      cards: {},

      sync: async (userId) => {
        // At most 9 a week, so one page covers years of them.
        const { data, error } = await supabase.from('grammar_cards').select('*, sentences:grammar_sentences(*)').eq('user_id', userId)
          .order('created_at').limit(1000);
        if (error) { console.warn('[grammar] fetch failed:', error.message); return; } // keep local as is
        const local = get().cards;
        const merged: Record<string, GrammarCard> = {};
        const push: GrammarCard[] = [];
        for (const row of (data ?? []) as GrammarRow[]) {
          const r = fromRow(row);
          const l = local[r.id];
          // A sentence shown here before the push landed keeps its later time.
          if (l) r.sentences = r.sentences.map((x) => laterShown(x, l.sentences?.find((y) => y.id === x.id)));
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

      review: (view, rating, picked, thinkMs, now) => {
        if (useAppStore.getState().sandboxMode) return;
        const id = view.id;
        if (!get().cards[id]) return;
        const c = shown(get().cards[id], view.sentenceId, now);
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
          if (view.sentenceId) pushShown(uid, view.sentenceId, now);
          const { error } = await send({ t: 'insert', table: 'grammar_review_log', row: {
            user_id: uid, card_id: id, sentence_id: view.sentenceId, rating, picked, correct: picked === view.answer,
            interval_days: sched.intervalDays, stability_after: sched.stability, think_ms: thinkMs, reviewed_at: iso(now),
          } });
          if (error) console.warn('[grammar] review log failed:', error.message);
        });
      },

      markShown: (cardId, sentenceId, now) => {
        const c = get().cards[cardId];
        if (!c || !sentenceId || useAppStore.getState().sandboxMode) return;
        set({ cards: { ...get().cards, [cardId]: shown(c, sentenceId, now) } });
        currentUserId().then((uid) => { if (uid) pushShown(uid, sentenceId, now); });
      },
    }),
    {
      name: 'yugen-grammar',
      version: 2,
      // v1 cards had no pool: an empty one until the next sync shows their own sentence.
      migrate: (old) => {
        const cards = (old as { cards?: Record<string, GrammarCard> })?.cards ?? {};
        return { cards: Object.fromEntries(Object.entries(cards).map(([k, c]) => [k, { ...c, rule: c.rule ?? c.pattern, sentences: c.sentences ?? [], sentenceId: null }])) };
      },
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

function laterShown(server: GrammarSentence, local?: GrammarSentence): GrammarSentence {
  return local?.shownAt != null && (server.shownAt == null || local.shownAt > server.shownAt) ? { ...server, shownAt: local.shownAt } : server;
}

/** Today's grammar cards for the 単語 session, each on its next sentence. */
export function buildGrammarCards(now = Date.now()) {
  return selectGrammarCards(Object.values(useGrammarStore.getState().cards), now)
    .map((g) => ({ ...g, card: withNextSentence(g.card) }));
}

/** A card again, on another sentence than `shown` (a もう一度 repeat). */
export function nextGrammarSentence(shown: GrammarCard): GrammarCard {
  const c = useGrammarStore.getState().cards[shown.id] ?? shown;
  return withNextSentence(c, shown.sentenceId);
}
