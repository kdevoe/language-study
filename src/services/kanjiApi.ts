// Supabase persistence for the RTK kanji deck (database/35_kanji_deck.sql).
// user_kanji_progress holds one row per introduced kanji; kanji_review_log is the
// append-only history (the Anki import plus every grade), kept server-side only.

import { supabase } from './supabase';
import type { KanjiProgress } from './kanjiDeck';

const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
const ms = (ts: string | null) => (ts ? new Date(ts).getTime() : null);

interface KanjiRow {
  kanji: string;
  heisig_no: number;
  stability: number | null;
  fsrs_difficulty: number | null;
  due_at: string | null;
  last_reviewed_at: string | null;
  interval_days: number | null;
  reps: number | null;
  lapses: number | null;
  srs_status: KanjiProgress['status'] | null;
  introduced_at: string | null;
  source: string | null;
  updated_at: string | null;
}

function fromRow(row: KanjiRow): KanjiProgress {
  return {
    kanji: row.kanji,
    heisigNo: row.heisig_no,
    stability: row.stability ?? null,
    fsrsDifficulty: row.fsrs_difficulty ?? null,
    dueAt: ms(row.due_at),
    lastReviewedAt: ms(row.last_reviewed_at),
    intervalDays: row.interval_days ?? null,
    reps: row.reps ?? 0,
    lapses: row.lapses ?? 0,
    status: row.srs_status ?? 'new',
    introducedAt: ms(row.introduced_at) ?? Date.now(),
    source: row.source === 'anki' ? 'anki' : 'yugen',
    updatedAt: ms(row.updated_at) ?? 0,
  };
}

function toRow(userId: string, p: KanjiProgress) {
  return {
    user_id: userId,
    kanji: p.kanji,
    heisig_no: p.heisigNo,
    stability: p.stability,
    fsrs_difficulty: p.fsrsDifficulty,
    due_at: iso(p.dueAt),
    last_reviewed_at: iso(p.lastReviewedAt),
    interval_days: p.intervalDays,
    reps: p.reps,
    lapses: p.lapses,
    srs_status: p.status,
    introduced_at: iso(p.introducedAt),
    source: p.source,
    updated_at: iso(p.updatedAt),
  };
}

/**
 * Every introduced kanji for the user. Paged: PostgREST caps a select at about
 * 1000 rows and the deck grows to 2,200. Returns null on error so a failed fetch
 * is never mistaken for an empty deck.
 */
export async function fetchKanjiProgress(userId: string): Promise<KanjiProgress[] | null> {
  const out: KanjiProgress[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('user_kanji_progress')
      .select('*')
      .eq('user_id', userId)
      .order('heisig_no')
      .range(from, from + PAGE - 1);
    if (error) {
      console.warn('[kanji] fetch failed:', error.message);
      return null;
    }
    out.push(...(data ?? []).map(fromRow));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

export async function upsertKanjiProgress(userId: string, rows: KanjiProgress[]): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await supabase.from('user_kanji_progress').upsert(rows.map((p) => toRow(userId, p)));
  if (error) console.warn('[kanji] upsert failed:', error.message);
}

export async function logKanjiReview(
  userId: string,
  entry: { kanji: string; rating: number; intervalDays: number; stabilityAfter: number; thinkMs: number | null; reviewedAt: number },
): Promise<void> {
  const { error } = await supabase.from('kanji_review_log').insert({
    user_id: userId,
    kanji: entry.kanji,
    rating: entry.rating,
    source: 'flashcard',
    interval_days: entry.intervalDays,
    stability_after: entry.stabilityAfter,
    think_ms: entry.thinkMs,
    reviewed_at: iso(entry.reviewedAt),
  });
  if (error) console.warn('[kanji] review log failed:', error.message);
}
