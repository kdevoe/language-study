// The reader's vocabulary, as the generators see it (docs/vocab-palette-redesign.md).
// Shared by process-article (articles) and generate-song (songs), so a song is
// held to the same level as an article:
//   • buildLexicon — the reader's full KNOWN list (confirmed-easy SRS words, then
//     assumed-known N5/N4 minus anything they graded medium/hard), injected whole
//     as the ALLOWED LIST: the list IS the level.
//   • pickReviewWords — a few struggling words in their pre-due window (or
//     overdue), most urgent first, to slip in where they fit: reading or hearing
//     one in context reinforces it before it becomes a flashcard.
// Katakana-only surfaces are left out of both: loanwords read for free.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { selectPreDueFloor, type WordSignal } from './wordPriority.ts';

export const KATAKANA_ONLY_RE = /^[ァ-ヶヽヾー・゠]+$/;
// Prompt-size safety cap (~4k surfaces ≈ ~9k tokens) — known-first order means the
// cap drops assumed-known tail words, never confirmed-easy ones.
export const LEXICON_MAX_WORDS = 4000;
// Below this the list can't carry a text — callers fall back to their own pipeline.
export const LEXICON_MIN_WORDS = 300;

// Page past supabase's 1000-row response cap (unranged .select() silently truncates).
export async function fetchAllRows<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  const SIZE = 1000;
  for (let from = 0; ; from += SIZE) {
    const { data, error } = await page(from, from + SIZE - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if ((data ?? []).length < SIZE) break;
  }
  return out;
}

export type EmbeddedEntry = { id: string; jmdict_kanji: { text: string; common: boolean }[]; jmdict_kana: { text: string; common: boolean }[] };

// Preferred display surface for an entry: common kanji > common kana > any kanji
// > any kana. Preferring a common KANA reading over a non-common kanji form keeps
// words whose only kanji spelling is rare (その's 其の, とても's 迚も) in kana,
// instead of feeding an unnatural surface into the vocab palette.
export function pickSurface(e: EmbeddedEntry): string | null {
  const commonOf = (rows: { text: string; common: boolean }[]) =>
    rows.find((r) => r.common)?.text ?? null;
  const anyOf = (rows: { text: string; common: boolean }[]) => rows[0]?.text ?? null;
  return (
    commonOf(e.jmdict_kanji ?? []) ??
    commonOf(e.jmdict_kana ?? []) ??
    anyOf(e.jmdict_kanji ?? []) ??
    anyOf(e.jmdict_kana ?? [])
  );
}

/** The reader's known lexicon, known-first. Throws on a query error. */
export async function buildLexicon(supabase: SupabaseClient, userId: string): Promise<string[]> {
  const [srsRows, n54Entries] = await Promise.all([
    fetchAllRows<{ word_id: string; mastery_level: string }>((from, to) =>
      supabase.from('user_word_progress').select('word_id, mastery_level').eq('user_id', userId).range(from, to)),
    fetchAllRows<EmbeddedEntry>((from, to) =>
      supabase.from('jmdict_entries').select('id, jmdict_kanji(text, common), jmdict_kana(text, common)').gte('jlpt_level', 4).range(from, to)),
  ]);
  const struggling = new Set(srsRows.filter((r) => r.mastery_level === 'medium' || r.mastery_level === 'hard').map((r) => r.word_id));
  const easyIds = srsRows.filter((r) => r.mastery_level === 'easy').map((r) => r.word_id);
  // Surfaces for confirmed-easy words above N4 (not covered by the N5/N4 fetch).
  const n54ById = new Map(n54Entries.map((e) => [e.id, e]));
  const missingEasy = easyIds.filter((id) => !n54ById.has(id));
  const easyById = new Map<string, EmbeddedEntry>();
  for (let i = 0; i < missingEasy.length; i += 200) {
    const { data } = await supabase
      .from('jmdict_entries')
      .select('id, jmdict_kanji(text, common), jmdict_kana(text, common)')
      .in('id', missingEasy.slice(i, i + 200));
    for (const e of (data ?? []) as EmbeddedEntry[]) easyById.set(e.id, e);
  }
  // Known-first order: confirmed-easy leads, then assumed-known N5/N4 — minus words
  // the reader actually graded medium/hard (their own evidence beats the JLPT tag).
  const ordered = [
    ...easyIds.map((id) => easyById.get(id) ?? n54ById.get(id)),
    ...n54Entries.filter((e) => !struggling.has(e.id)),
  ];
  const words: string[] = [];
  const seen = new Set<string>();
  for (const e of ordered) {
    if (!e) continue;
    const s = pickSurface(e);
    if (!s || seen.has(s) || KATAKANA_ONLY_RE.test(s)) continue;
    seen.add(s);
    words.push(s);
    if (words.length >= LEXICON_MAX_WORDS) break;
  }
  return words;
}

export interface ReviewWord {
  entryId: string;
  word: string;
}

/**
 * Up to `limit` review words: struggling (hard/medium) words in their pre-due
 * window or overdue, most urgent first — the same floor articles reserve slots
 * for — topped up with any-mastery words due within a week. Still-queued intake
 * words are never offered.
 */
export async function pickReviewWords(supabase: SupabaseClient, userId: string, limit: number): Promise<ReviewWord[]> {
  const PROGRESS_COLS = 'word_id, mastery_level, difficulty, times_seen, last_seen_at, due_at, stability, interval_days';
  const intakeGate = 'intake_status.is.null,intake_status.eq.active';
  type ProgressRow = {
    word_id: string; mastery_level: string; difficulty: number | null; times_seen: number | null;
    last_seen_at: string | null; due_at: string | null; stability: number | null; interval_days: number | null;
  };
  const weekOut = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const [{ data: stuckRows, error: e1 }, { data: dueRows, error: e2 }] = await Promise.all([
    supabase.from('user_word_progress').select(PROGRESS_COLS)
      .eq('user_id', userId).in('mastery_level', ['hard', 'medium']).or(intakeGate).limit(200),
    supabase.from('user_word_progress').select(PROGRESS_COLS)
      .eq('user_id', userId).not('due_at', 'is', null).lt('due_at', weekOut).or(intakeGate).limit(100),
  ]);
  if (e1 || e2) throw e1 ?? e2;
  const toSignal = (r: ProgressRow): WordSignal => ({
    entryId: r.word_id,
    jlptLevel: null,
    freqRank: null,
    isCommon: false,
    mastery: r.mastery_level as WordSignal['mastery'],
    difficulty: r.difficulty ?? null,
    timesSeen: r.times_seen ?? null,
    lastSeenAt: r.last_seen_at ?? null,
    dueAt: r.due_at ?? null,
    stability: r.stability ?? null,
    intervalDays: r.interval_days ?? null,
  });
  const stuck = ((stuckRows ?? []) as ProgressRow[]).map(toSignal);
  const stuckIds = new Set(stuck.map((s) => s.entryId));
  const due = ((dueRows ?? []) as ProgressRow[]).filter((r) => !stuckIds.has(r.word_id)).map(toSignal);
  // Over-pick so katakana drops don't cost slots.
  const now = Date.now();
  const pool = [...selectPreDueFloor(stuck, now, limit + 12), ...selectPreDueFloor(due, now, limit + 12)];
  const ids = Array.from(new Set(pool.map((s) => s.entryId)));
  if (!ids.length) return [];

  // Same surface rule as the lexicon (common kanji > common kana > any), so a word
  // whose only kanji spelling is rare (しかし's 併し) is offered in kana.
  const { data: entries, error: e3 } = await supabase
    .from('jmdict_entries').select('id, jmdict_kanji(text, common), jmdict_kana(text, common)').in('id', ids);
  if (e3) throw e3;
  const surface = new Map(((entries ?? []) as EmbeddedEntry[]).map((e) => [e.id, pickSurface(e)]));
  const out: ReviewWord[] = [];
  for (const id of ids) {
    const word = surface.get(id);
    if (!word || KATAKANA_ONLY_RE.test(word)) continue;
    out.push({ entryId: id, word });
    if (out.length >= limit) break;
  }
  return out;
}
