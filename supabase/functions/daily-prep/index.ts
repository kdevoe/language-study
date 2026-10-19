// daily-prep (docs/learning-strategy-review.md §4–5): get tomorrow ready overnight,
// so opening the app is instant. Run per active user by pg_cron
// (database/40_overnight_prep.sql), in two stages:
//
//   intake (08:30 UTC) — after the 08:00 dream, before the 09:00 news refill:
//     1. ハルカ's struggle rule: a word the learner got wrong in chat in two or more
//        separate conversations (learner_notes 'usage' rows, correct = false, last
//        30 days) is queued as CHOSEN (chosen_by 'haruka'), so it leads the ranking.
//        The evidence is only the learner's own Japanese — record_usage is written
//        from their messages, never from article or tool text — and queueing spends
//        nothing; the daily cap still decides what becomes a card. 今日 shows each
//        add with an undo.
//     2. Intake: the same ranking the app uses (_shared/intake.ts) picks today's
//        new words up to new_words_per_day, minus any already promoted today.
//     3. A per-level snapshot for 進捗's "this week".
//   digest (09:40 UTC) — after the refill: requests today's morning podcast
//     through generate-podcast (service call; it dedupes by date and applies the
//     learner's own limits), so it's ready before they open 聞く.
//
// Cron or service caller only. The app keeps an on-open intake pass as a fallback;
// it counts today's promotions first, so nothing doubles.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveCaller, actingUserId } from '../_shared/auth.ts';
import { fetchAllRows } from '../_shared/readerVocab.ts';
import { selectPromotions, workingLevel, type IntakeItem, type IntakeCandidate, type LevelProgress } from '../_shared/intake.ts';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const STRUGGLE_MIN_THREADS = 2;
const STRUGGLE_WINDOW_DAYS = 30;
const STRUGGLE_MAX_PER_NIGHT = 3;

/** YYYY-MM-DD in the learner's zone (falls back to UTC on a bad zone name). */
function localDate(tz: string, d: Date): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

// Mirrors store.seedDifficulty / bucketForDifficulty (src/services/store.ts).
const clamp = (n: number) => Math.max(1, Math.min(10, Math.round(n)));
function seedDifficulty(level: number | null, user: number | null): number {
  if (level == null) return 6;
  if (user == null) return 5;
  return clamp(6 + (user - level) * 2);
}
const bucket = (d: number) => (d <= 3 ? 'easy' : d <= 7 ? 'medium' : 'hard');

type ProgressRow = {
  word_id: string; mastery_level: string | null; difficulty: number | null; times_seen: number | null;
  last_seen_at: string | null; intake_status: string | null; promoted_at: string | null; chosen_at: string | null; chosen_by?: string | null;
};

async function entrySignals(supabase: SupabaseClient, ids: string[]) {
  const out = new Map<string, { level: number | null; freq: number | null }>();
  const numeric = ids.filter((id) => /^\d+$/.test(id));
  for (let i = 0; i < numeric.length; i += 200) {
    const { data, error } = await supabase.from('jmdict_entries').select('id, jlpt_level, freq_rank').in('id', numeric.slice(i, i + 200));
    if (error) throw error;
    for (const e of data ?? []) out.set(String(e.id), { level: e.jlpt_level ?? null, freq: e.freq_rank ?? null });
  }
  return out;
}

async function surfaces(supabase: SupabaseClient, ids: string[]) {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const { data } = await supabase.from('jmdict_entries').select('id, jmdict_kanji(text, common), jmdict_kana(text, common)').in('id', ids);
  for (const e of (data ?? []) as { id: string; jmdict_kanji: { text: string }[]; jmdict_kana: { text: string }[] }[]) {
    const s = e.jmdict_kanji?.[0]?.text ?? e.jmdict_kana?.[0]?.text;
    if (s) out.set(String(e.id), s);
  }
  return out;
}

/** Resolve a word the tutor recorded to a JMDict entry: kanji form first, then kana. */
async function resolveEntry(supabase: SupabaseClient, text: string): Promise<string | null> {
  const t = text.trim().replace(/^[〜~]/, '');
  if (!t || t.length > 12 || /[a-zA-Z]/.test(t)) return null; // grammar labels and English aren't words
  for (const table of ['jmdict_kanji', 'jmdict_kana']) {
    const { data } = await supabase.from(table).select('entry_id').eq('text', t).limit(5);
    const ids = (data ?? []).map((r) => String(r.entry_id));
    if (!ids.length) continue;
    if (ids.length === 1) return ids[0];
    // Several entries share the spelling: take the most common one.
    const sig = await entrySignals(supabase, ids);
    return ids.sort((a, b) => (sig.get(a)?.freq ?? 99) - (sig.get(b)?.freq ?? 99))[0];
  }
  return null;
}

async function struggleRule(supabase: SupabaseClient, userId: string, rows: Map<string, ProgressRow>) {
  const since = new Date(Date.now() - STRUGGLE_WINDOW_DAYS * 86_400_000).toISOString();
  const { data: notes, error } = await supabase.from('learner_notes')
    .select('ref, created_at').eq('user_id', userId).eq('kind', 'usage').eq('source', 'tutor').gte('created_at', since);
  if (error) throw error;
  const threadsByItem = new Map<string, Set<string>>();
  for (const n of notes ?? []) {
    const ref = (n.ref ?? {}) as { item?: string; correct?: boolean; threadId?: string };
    if (ref.correct !== false || !ref.item) continue;
    const set = threadsByItem.get(ref.item) ?? new Set<string>();
    set.add(ref.threadId ?? String(n.created_at).slice(0, 10));
    threadsByItem.set(ref.item, set);
  }
  const added: string[] = [];
  const nowIso = new Date().toISOString();
  for (const [item, threads] of threadsByItem) {
    if (added.length >= STRUGGLE_MAX_PER_NIGHT) break;
    if (threads.size < STRUGGLE_MIN_THREADS) continue;
    const entryId = await resolveEntry(supabase, item);
    if (!entryId) continue;
    const row = rows.get(entryId);
    if (row?.chosen_at) continue;                                  // already chosen
    if (row?.intake_status === 'active') continue;                 // already being studied
    const patch = { chosen_at: nowIso, chosen_by: 'haruka' };
    const { error: wErr } = row
      ? await supabase.from('user_word_progress').update(patch).eq('user_id', userId).eq('word_id', entryId)
      : await supabase.from('user_word_progress').insert({
          user_id: userId, word_id: entryId, mastery_level: 'medium', difficulty: 6, times_seen: 0,
          intake_status: 'queued', ...patch,
        });
    if (wErr) { console.warn('[daily-prep] struggle add failed:', item, wErr.message); continue; }
    rows.set(entryId, { ...(row ?? { word_id: entryId, mastery_level: 'medium', difficulty: 6, times_seen: 0, last_seen_at: null, intake_status: 'queued', promoted_at: null }), ...patch } as ProgressRow);
    added.push(item);
  }
  return added;
}

async function runIntake(supabase: SupabaseClient, userId: string) {
  const { data: prefs } = await supabase.from('user_preferences')
    .select('jlpt_level, new_words_per_day, timezone').eq('user_id', userId).maybeSingle();
  const tz = prefs?.timezone || 'UTC';
  const userJlpt: number | null = prefs?.jlpt_level ?? null;
  const capPref: number = prefs?.new_words_per_day ?? 3;
  const now = new Date();
  const today = localDate(tz, now);

  const progressRows = await fetchAllRows<ProgressRow>((from, to) => supabase.from('user_word_progress')
    .select('word_id, mastery_level, difficulty, times_seen, last_seen_at, intake_status, promoted_at, chosen_at, chosen_by')
    .eq('user_id', userId).range(from, to));
  const rows = new Map(progressRows.map((r) => [r.word_id, r]));

  const strugglesAdded = await struggleRule(supabase, userId, rows);

  // Level progress (the same numbers as intake_level_progress).
  const levelTotals = await Promise.all([5, 4, 3, 2, 1].map(async (level) => {
    const { count } = await supabase.from('jmdict_entries').select('id', { count: 'exact', head: true }).eq('jlpt_level', level);
    return { level, total: count ?? 0 };
  }));
  const signals = await entrySignals(supabase, [...rows.keys()]);
  const solidBy = new Map<number, number>();
  for (const r of rows.values()) {
    const lv = signals.get(r.word_id)?.level;
    if (lv != null && r.mastery_level === 'easy') solidBy.set(lv, (solidBy.get(lv) ?? 0) + 1);
  }
  const progress: LevelProgress[] = levelTotals.map((t) => ({ ...t, solid: solidBy.get(t.level) ?? 0 }));
  await supabase.from('level_snapshots').upsert(progress.map((p) => ({ user_id: userId, day: today, ...p })));
  const working = workingLevel(progress, userJlpt);

  const promotedToday = progressRows.filter((r) => r.promoted_at && localDate(tz, new Date(r.promoted_at)) === today).length;
  const cap = capPref - promotedToday;
  if (cap <= 0) return { working, promoted: [], strugglesAdded, note: capPref <= 0 ? 'paused' : 'already promoted today' };

  const lookups = new Map<string, number>();
  for (const h of await fetchAllRows<{ word_id: string }>((from, to) => supabase.from('study_history')
    .select('word_id').eq('user_id', userId).eq('action', 'lookup').range(from, to))) {
    lookups.set(h.word_id, (lookups.get(h.word_id) ?? 0) + 1);
  }

  const queued: IntakeItem[] = [];
  for (const r of rows.values()) {
    if ((r.intake_status ?? 'queued') !== 'queued' || !/^\d+$/.test(r.word_id)) continue;
    const sig = signals.get(r.word_id);
    queued.push({
      key: r.word_id, entryId: r.word_id,
      jlptLevel: sig?.level ?? null, freqRank: sig?.freq ?? null,
      timesSeen: r.times_seen ?? 0, lookupCount: lookups.get(r.word_id) ?? 0,
      lastSeenTs: r.times_seen && r.last_seen_at ? new Date(r.last_seen_at).getTime() : 0,
      mastery: r.mastery_level, chosen: !!r.chosen_at,
    });
  }

  let candidates: IntakeItem[] = [];
  if (userJlpt != null) {
    const { data } = await supabase.rpc('get_intake_candidates', {
      p_user_jlpt: Math.min(userJlpt, working), p_seen_ids: [...rows.keys()], p_limit: cap + 20,
    });
    candidates = ((data ?? []) as { entry_id: string; jlpt_level: number | null; freq_rank: number | null; word: string; reading: string | null; meaning: string | null }[])
      .map((c) => {
        const candidate: IntakeCandidate = { entryId: c.entry_id, jlptLevel: c.jlpt_level, freqRank: c.freq_rank, word: c.word, reading: c.reading ?? '', meaning: c.meaning ?? '' };
        return { key: null, entryId: c.entry_id, jlptLevel: c.jlpt_level, freqRank: c.freq_rank, timesSeen: 0, surface: c.word, candidate };
      });
  }

  // Score everything, then check the leaders' spellings for junk before the final pick.
  const shortlist = selectPromotions(queued, candidates, cap * 6, working, now.getTime());
  const spell = await surfaces(supabase, shortlist.filter((p) => !p.surface).map((p) => p.entryId));
  const winners = selectPromotions(
    shortlist.map((p) => ({ ...p, surface: p.surface ?? spell.get(p.entryId) })), [], cap, working, now.getTime());

  const promotedAt = now.toISOString();
  const promoted: string[] = [];
  for (const w of winners) {
    const row = rows.get(w.entryId);
    const difficulty = row?.difficulty ?? seedDifficulty(w.jlptLevel, userJlpt);
    const fields = {
      intake_status: 'active', promoted_at: promotedAt, difficulty,
      mastery_level: row?.mastery_level && row.mastery_level !== 'unseen' ? row.mastery_level : bucket(difficulty),
      reps: 0,
    };
    const { error } = row
      ? await supabase.from('user_word_progress').update(fields).eq('user_id', userId).eq('word_id', w.entryId).eq('intake_status', 'queued')
      : await supabase.from('user_word_progress').insert({ user_id: userId, word_id: w.entryId, times_seen: 0, ...fields });
    if (error) { console.warn('[daily-prep] promote failed:', w.entryId, error.message); continue; }
    promoted.push(`${w.surface ?? w.entryId} (${w.score.toFixed(1)})`);
  }
  return { working, promoted, strugglesAdded };
}

async function runDigest(supabase: SupabaseClient, userId: string, serviceKey: string) {
  const { data: prefs } = await supabase.from('user_preferences').select('timezone').eq('user_id', userId).maybeSingle();
  const date = localDate(prefs?.timezone || 'UTC', new Date());
  const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/generate-podcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify({ userId, source: { kind: 'digest', date }, minutes: 5 }),
  });
  const body = await res.json().catch(() => ({}));
  return { date, status: res.status, episode: body?.episode?.id ?? null, error: body?.error ?? null };
}

Deno.serve(async (req) => {
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey);
  // Acts for whichever user the body names, so only the cron or the service role.
  const caller = await resolveCaller(req, supabase, serviceKey);
  if (!caller || caller.kind === 'user') return json(401, { error: 'unauthorized' });
  const body = await req.json().catch(() => ({}));
  const userId = actingUserId(caller, body?.userId);
  if (!userId) return json(400, { error: 'userId required' });
  const stage = body?.stage === 'digest' ? 'digest' : 'intake';
  try {
    const result = stage === 'digest' ? await runDigest(supabase, userId, serviceKey) : await runIntake(supabase, userId);
    console.log(`[daily-prep] ${stage} ${userId}:`, JSON.stringify(result));
    return json(200, { stage, ...result });
  } catch (e) {
    console.error(`[daily-prep] ${stage} failed for ${userId}:`, e);
    return json(500, { error: e instanceof Error ? e.message : String(e) });
  }
});
