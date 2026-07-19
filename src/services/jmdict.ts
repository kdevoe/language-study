/**
 * JMDict Lookup Service
 * 
 * Queries the JMDict tables in Supabase for dictionary lookups.
 * Provides both direct lookups and LLM-assisted disambiguation
 * for ambiguous words with multiple entries.
 */

import { supabase } from './supabase';
import { alignReading, hasKanji } from './furigana';
import type { CoarsePos } from './tokenizer';
import type { IntakeCandidate } from './intake';

export interface JMDictResult {
  entryId: string;
  kanji: string[];
  readings: string[];
  senses: {
    pos: string[];
    gloss: string[];
    field: string[];
    misc: string[];
  }[];
  jlptLevel: number | null;
  /** Best (lowest) frequency band across the entry's forms; null = rare/unranked. */
  freqRank: number | null;
  isCommon: boolean;
  /** JLPT level inferred from kanji/frequency when jlptLevel is null (Phase 4). */
  derivedJlpt?: number | null;
}

const LOOKUP_TIMEOUT_MS = 6000;

function withTimeout<T>(p: PromiseLike<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    Promise.resolve(p).then(
      v => { clearTimeout(t); resolve(v); },
      e => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * Look up a word in JMDict by its surface form (kanji or kana).
 * Tries kanji match first, falls back to kana.
 */
export async function lookupWord(text: string): Promise<JMDictResult[]> {
  // 1. Try kanji surface form first
  const kanjiResults = await lookupByKanji(text);
  if (kanjiResults.length > 0) return kanjiResults;

  // 2. Fall back to kana. Order kana-primary entries first so downstream
  // "first candidate" fallbacks (e.g. failed LLM disambiguation) land on the
  // word actually written in kana, not a kanji-primary homophone.
  const kanaResults = await lookupByKana(text);
  return [...kanaResults].sort((a, b) => {
    const ka = isKanaPrimary(a) ? 0 : 1;
    const kb = isKanaPrimary(b) ? 0 : 1;
    if (ka !== kb) return ka - kb;
    if (a.isCommon !== b.isCommon) return a.isCommon ? -1 : 1;
    return (a.freqRank ?? Infinity) - (b.freqRank ?? Infinity);
  });
}

async function lookupByKanji(text: string): Promise<JMDictResult[]> {
  const { data: kanjiRows, error } = await withTimeout(
    supabase.from('jmdict_kanji').select('entry_id').eq('text', text).limit(10),
    LOOKUP_TIMEOUT_MS,
    'jmdict_kanji lookup',
  );

  if (error || !kanjiRows || kanjiRows.length === 0) return [];

  const entryIds = [...new Set(kanjiRows.map(r => r.entry_id))];
  return fetchEntries(entryIds);
}

async function lookupByKana(text: string): Promise<JMDictResult[]> {
  const { data: kanaRows, error } = await withTimeout(
    supabase.from('jmdict_kana').select('entry_id').eq('text', text).limit(10),
    LOOKUP_TIMEOUT_MS,
    'jmdict_kana lookup',
  );

  if (error || !kanaRows || kanaRows.length === 0) return [];

  const entryIds = [...new Set(kanaRows.map(r => r.entry_id))];
  return fetchEntries(entryIds);
}

export async function fetchEntries(entryIds: string[]): Promise<JMDictResult[]> {
  // Fetch entries, kanji forms, kana forms, and senses in parallel
  const [entriesRes, kanjiRes, kanaRes, sensesRes] = await withTimeout(Promise.all([
    supabase.from('jmdict_entries').select('id, common, jlpt_level, freq_rank').in('id', entryIds),
    supabase.from('jmdict_kanji').select('entry_id, text').in('entry_id', entryIds),
    supabase.from('jmdict_kana').select('entry_id, text').in('entry_id', entryIds),
    supabase.from('jmdict_senses').select('entry_id, pos, gloss, field, misc').in('entry_id', entryIds),
  ]), LOOKUP_TIMEOUT_MS, 'jmdict entry fetch');

  if (!entriesRes.data) return [];

  return entriesRes.data.map(entry => {
    const kanji = (kanjiRes.data || []).filter(k => k.entry_id === entry.id).map(k => k.text);
    const readings = (kanaRes.data || []).filter(k => k.entry_id === entry.id).map(k => k.text);
    const senses = (sensesRes.data || []).filter(s => s.entry_id === entry.id).map(s => ({
      pos: s.pos || [],
      gloss: s.gloss || [],
      field: s.field || [],
      misc: s.misc || [],
    }));

    return {
      entryId: entry.id,
      kanji,
      readings,
      senses,
      jlptLevel: entry.jlpt_level,
      freqRank: entry.freq_rank ?? null,
      isCommon: entry.common || false,
    };
  });
}

// ── Lemma batch lookup + disambiguation ──────────────────────────────────────
// kuromoji gives us a lemma (鎮める) and coarse POS per content word; one query
// per article collapses N per-word lookups into a single round-trip.

/** Does any sense of this entry match the analyzer's coarse POS? */
function posMatches(result: JMDictResult, pos: CoarsePos | undefined): boolean {
  if (!pos) return false;
  const codes = result.senses.flatMap(s => s.pos);
  if (pos === 'verb') return codes.some(c => /^v/.test(c));
  if (pos === 'noun') return codes.some(c => /^n/.test(c));
  if (pos === 'adjective') return codes.some(c => /^adj/.test(c));
  if (pos === 'adverb') return codes.some(c => /^adv/.test(c) || c === 'n-adv');
  return false;
}

/** Entry is written in kana in practice: no kanji forms, or usually-kana senses. */
function isKanaPrimary(e: JMDictResult): boolean {
  return e.kanji.length === 0 || e.senses.some(s => s.misc.includes('uk'));
}

/**
 * Pick the best entry for a lemma: prefer a POS match, then — for kana lemmas —
 * kana-primary entries, then common words, then the most frequent (lowest
 * freq_rank). The kana-primary step matters because homophone verbs are all
 * common and freq_rank alone routes する to 擦る "to rub" (為る has no rank) and
 * いる to 射る "to shoot" — a word WRITTEN in kana is almost never the
 * kanji-primary homophone. Replaces the old "first entry wins".
 */
export function pickBestEntry(candidates: JMDictResult[], pos?: CoarsePos, kanaLemma = false): JMDictResult {
  return [...candidates].sort((a, b) => {
    const pa = posMatches(a, pos) ? 0 : 1;
    const pb = posMatches(b, pos) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if (kanaLemma) {
      const ka = isKanaPrimary(a) ? 0 : 1;
      const kb = isKanaPrimary(b) ? 0 : 1;
      if (ka !== kb) return ka - kb;
    }
    if (a.isCommon !== b.isCommon) return a.isCommon ? -1 : 1;
    return (a.freqRank ?? Infinity) - (b.freqRank ?? Infinity);
  })[0];
}

/**
 * Look up many lemmas at once. Returns lemma → best JMDict entry.
 * Kanji surface matches win over kana matches for the same lemma.
 * Entries with no JLPT tag get a derived level (kanji_jlpt, else freq_rank).
 */
export async function lookupLemmasBatch(
  lemmas: string[],
  posByLemma?: Map<string, CoarsePos>,
): Promise<Map<string, JMDictResult>> {
  const unique = [...new Set(lemmas.filter(Boolean))];
  if (unique.length === 0) return new Map();

  const [kanjiRes, kanaRes] = await withTimeout(Promise.all([
    supabase.from('jmdict_kanji').select('entry_id, text').in('text', unique),
    supabase.from('jmdict_kana').select('entry_id, text').in('text', unique),
  ]), LOOKUP_TIMEOUT_MS, 'lemma batch surface lookup');

  // lemma → candidate entry ids, kanji matches kept separate so they take priority.
  const kanjiIds = new Map<string, Set<string>>();
  const kanaIds = new Map<string, Set<string>>();
  const collect = (rows: { entry_id: string; text: string }[] | null, into: Map<string, Set<string>>) => {
    (rows || []).forEach(r => {
      if (!into.has(r.text)) into.set(r.text, new Set());
      into.get(r.text)!.add(r.entry_id);
    });
  };
  collect(kanjiRes.data, kanjiIds);
  collect(kanaRes.data, kanaIds);

  const allIds = new Set<string>();
  [kanjiIds, kanaIds].forEach(m => m.forEach(set => set.forEach(id => allIds.add(id))));
  if (allIds.size === 0) return new Map();

  const entries = await fetchEntries([...allIds]);
  const byId = new Map(entries.map(e => [e.entryId, e]));

  const result = new Map<string, JMDictResult>();
  for (const lemma of unique) {
    const viaKanji = !!kanjiIds.get(lemma)?.size;
    const ids = (viaKanji ? kanjiIds.get(lemma) : kanaIds.get(lemma)) ?? new Set();
    const cands = [...ids].map(id => byId.get(id)).filter((e): e is JMDictResult => !!e);
    if (cands.length > 0) result.set(lemma, pickBestEntry(cands, posByLemma?.get(lemma), !viaKanji));
  }

  await applyJlptFallback(result);
  return result;
}

/**
 * Fill in a derived JLPT level for matched entries that carry no official tag:
 *   (a) the hardest (lowest-numbered) JLPT level among the lemma's kanji, else
 *   (b) a coarse bucket from frequency rank.
 * Stored on `derivedJlpt` so the UI can mark it as approximate.
 */
async function applyJlptFallback(byLemma: Map<string, JMDictResult>): Promise<void> {
  const needKanji = new Set<string>();
  byLemma.forEach((entry, lemma) => {
    if (entry.jlptLevel == null) {
      for (const ch of lemma) if (hasKanji(ch)) needKanji.add(ch);
    }
  });

  const kanjiLevels = await fetchKanjiJlpt(needKanji);

  byLemma.forEach((entry, lemma) => {
    if (entry.jlptLevel != null) return;
    entry.derivedJlpt = deriveJlpt(lemma, entry.freqRank, kanjiLevels);
  });
}

/** Look up the JLPT level for each kanji character. Empty/failed → empty map. */
async function fetchKanjiJlpt(chars: Set<string>): Promise<Map<string, number>> {
  if (chars.size === 0) return new Map();
  try {
    const { data } = await withTimeout(
      supabase.from('kanji_jlpt').select('kanji, jlpt_level').in('kanji', [...chars]),
      LOOKUP_TIMEOUT_MS,
      'kanji_jlpt fallback',
    );
    return new Map(
      ((data || []) as { kanji: string; jlpt_level: number }[]).map(r => [r.kanji, r.jlpt_level]),
    );
  } catch (e) {
    console.warn('kanji_jlpt fallback failed:', e);
    return new Map();
  }
}

/**
 * Derive an approximate JLPT level for an untagged entry: the hardest (lowest-
 * numbered) JLPT level among `scanText`'s kanji, else a coarse frequency bucket.
 */
function deriveJlpt(
  scanText: string,
  freqRank: number | null,
  kanjiLevels: Map<string, number>,
): number | null {
  // Hardest kanji = lowest JLPT number (N1 hardest = 1).
  let derived: number | null = null;
  for (const ch of scanText) {
    const lv = kanjiLevels.get(ch);
    if (lv != null) derived = derived == null ? lv : Math.min(derived, lv);
  }
  if (derived == null) derived = freqRankToJlpt(freqRank);
  return derived;
}

/**
 * Resolve a JLPT level for each JMDict entry id, applying the same official-tag →
 * kanji → frequency fallback used during enrichment. Used to backfill word
 * records that were stored (e.g. read-past, pre-enrichment) without a level.
 * Chunks the id list so a large backlog doesn't blow the PostgREST `in(...)` limit.
 */
export async function fetchJlptByEntryIds(
  ids: string[],
): Promise<Map<string, { jlptLevel: number | null; jlptDerived: boolean }>> {
  const out = new Map<string, { jlptLevel: number | null; jlptDerived: boolean }>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return out;

  const CHUNK = 300;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const entries = await fetchEntries(unique.slice(i, i + CHUNK));

    // Gather kanji from untagged entries' surfaces for one batched fallback query.
    const needKanji = new Set<string>();
    for (const e of entries) {
      if (e.jlptLevel == null) {
        for (const form of e.kanji) for (const ch of form) if (hasKanji(ch)) needKanji.add(ch);
      }
    }
    const kanjiLevels = await fetchKanjiJlpt(needKanji);

    for (const e of entries) {
      if (e.jlptLevel != null) {
        out.set(e.entryId, { jlptLevel: e.jlptLevel, jlptDerived: false });
      } else {
        const derived = deriveJlpt(e.kanji.join(''), e.freqRank, kanjiLevels);
        out.set(e.entryId, { jlptLevel: derived, jlptDerived: derived != null });
      }
    }
  }
  return out;
}

/**
 * Reconstruct full word details (surface, reading, meaning, JLPT, pos, furigana)
 * for each JMDict entry id. Used to rehydrate the local word cache from the
 * server after a reinstall/localStorage wipe, where only entry ids + SRS state
 * survive. Keyed by entry id; `word` is the primary surface (kanji else kana).
 */
export async function fetchDetailsByEntryIds(
  ids: string[],
): Promise<Map<string, { word: string; reading: string; meaning: string; jlptLevel: number | null; jlptDerived: boolean; freqRank: number | null; pos: string[]; furiganaMap: { kanji: string; kana: string }[]; jmdictEntryId: string }>> {
  const out = new Map<string, { word: string; reading: string; meaning: string; jlptLevel: number | null; jlptDerived: boolean; freqRank: number | null; pos: string[]; furiganaMap: { kanji: string; kana: string }[]; jmdictEntryId: string }>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return out;

  // Keep chunks small enough that a chunk's child-row queries (senses especially,
  // several rows per entry) stay under the PostgREST ~1000-row cap, so no entry
  // comes back missing its surface/meaning.
  const CHUNK = 200;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const entries = await fetchEntries(unique.slice(i, i + CHUNK));

    const needKanji = new Set<string>();
    for (const e of entries) {
      if (e.jlptLevel == null) {
        for (const form of e.kanji) for (const ch of form) if (hasKanji(ch)) needKanji.add(ch);
      }
    }
    const kanjiLevels = await fetchKanjiJlpt(needKanji);

    for (const e of entries) {
      const surface = e.kanji[0] ?? e.readings[0] ?? '';
      if (!surface) continue;
      // jmdictToWordDetails reads result.derivedJlpt when the official tag is null.
      const withDerived = e.jlptLevel == null
        ? { ...e, derivedJlpt: deriveJlpt(e.kanji.join(''), e.freqRank, kanjiLevels) }
        : e;
      const d = jmdictToWordDetails(surface, withDerived);
      out.set(e.entryId, { word: surface, ...d });
    }
  }
  return out;
}

/** Coarse JLPT bucket from a frequency band (1 = most common … 48 = rare). */
function freqRankToJlpt(rank: number | null): number | null {
  if (rank == null) return null;
  if (rank <= 4) return 5;
  if (rank <= 8) return 4;
  if (rank <= 16) return 3;
  if (rank <= 24) return 2;
  return 1;
}

/**
 * Use an LLM to disambiguate between multiple JMDict candidates
 * given a word and its sentence context.
 */
export async function disambiguateWithLLM(
  word: string,
  contextSentence: string,
  candidates: JMDictResult[]
): Promise<JMDictResult> {
  const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
  const GROQ_MODEL = 'openai/gpt-oss-20b';
  const apiKey = import.meta.env.VITE_GROQ_API_KEY;

  if (!apiKey || candidates.length <= 1) {
    return candidates[0];
  }

  const candidateDescriptions = candidates.map((c, i) => {
    const glosses = c.senses.map(s => s.gloss.join(', ')).join(' / ');
    const pos = c.senses.flatMap(s => s.pos).filter(Boolean).join(', ');
    return `[${i}] ${c.kanji.join(', ') || c.readings.join(', ')} (${pos}): ${glosses}`;
  }).join('\n');

  const prompt = `Given the Japanese word "${word}" in this sentence: "${contextSentence}"

Which dictionary entry is the correct match? Return ONLY the index number.

Candidates:
${candidateDescriptions}

Answer (just the number):`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 5
      })
    });
    
    clearTimeout(timeoutId);

    if (!response.ok) return candidates[0];

    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content?.trim() || '0';
    const index = parseInt(answer, 10);

    if (!isNaN(index) && index >= 0 && index < candidates.length) {
      return candidates[index];
    }
  } catch (e) {
    console.warn('LLM disambiguation failed, using first candidate:', e);
  }

  return candidates[0];
}

/**
 * Build the modal's one-line meaning from an entry's senses.
 *
 * A single-sense word shows its first few synonymous glosses ("to run; to dash").
 * A polysemous word instead leads with ONE gloss from each sense, so genuinely
 * distinct meanings all surface instead of drowning in the first sense's synonyms.
 * Without this, 手当て (手当/手当て, entry 1598240: [1] salary/pay/compensation…
 * [2] medical care/treatment [3] preparation) displayed only "salary; pay;
 * compensation" and the treatment sense — the one meant in a medical context —
 * never appeared (#37).
 */
function summarizeSenses(senses: JMDictResult['senses'], limit = 4): string {
  const withGloss = senses.filter(s => s.gloss.length > 0);
  if (withGloss.length <= 1) {
    return withGloss[0]?.gloss.slice(0, 3).join('; ') ?? '';
  }
  return withGloss.slice(0, limit).map(s => s.gloss[0]).filter(Boolean).join('; ');
}

/**
 * Convert a JMDictResult into a format compatible with WordDetails.
 * Generates a furiganaMap by splitting the word into kanji/kana segments.
 */
export function jmdictToWordDetails(
  word: string,
  result: JMDictResult
): { reading: string; meaning: string; jmdictEntryId: string; pos: string[]; jlptLevel: number | null; jlptDerived: boolean; freqRank: number | null; furiganaMap: { kanji: string; kana: string }[] } {
  const reading = result.readings[0] || '';
  const meaning = summarizeSenses(result.senses);
  const pos = [...new Set(result.senses.flatMap(s => s.pos))];

  // Prefer the official JLPT tag; fall back to the derived level when untagged.
  const jlptLevel = result.jlptLevel ?? result.derivedJlpt ?? null;
  const jlptDerived = result.jlptLevel == null && jlptLevel != null;

  // Per-kanji reading alignment (shared with the tokenizer).
  const furiganaMap = alignReading(word, reading);

  return {
    reading,
    meaning,
    jmdictEntryId: result.entryId,
    pos,
    jlptLevel,
    jlptDerived,
    freqRank: result.freqRank ?? null,
    furiganaMap,
  };
}

// ── JLPT corpus coverage ────────────────────────────────────────────────────
// The Progress screen contrasts the handful of words a user has actually
// encountered against the full vocabulary pool of each JLPT level (5=N5 ... 1=N1).
// word_frequency carries no JLPT tag, so the denominator is the JMDict entry
// count per level.

let jlptTotalsCache: Record<number, number> | null = null;

/** Number of JMDict entries at each JLPT level. Cached for the session. */
export async function fetchJlptTotals(): Promise<Record<number, number>> {
  if (jlptTotalsCache) return jlptTotalsCache;

  const totals: Record<number, number> = {};
  await Promise.all(
    [1, 2, 3, 4, 5].map(async (level) => {
      const { count, error } = await supabase
        .from('jmdict_entries')
        .select('id', { count: 'exact', head: true })
        .eq('jlpt_level', level);
      if (!error && count != null) totals[level] = count;
    })
  );

  // Only cache a successful fetch so a transient/offline failure can be retried.
  if (Object.keys(totals).length > 0) jlptTotalsCache = totals;
  return totals;
}

export interface UnseenWord {
  word: string;     // surface form (matches the frequency-list key)
  reading: string;  // kana reading
  meaning: string;  // first JMDict gloss, if one exists
  rank: number;     // frequency rank (1 = most common)
}

/**
 * Fetch the most common words at a JLPT level that the user has NOT yet seen,
 * ordered by frequency rank (most common first).
 *
 * Backed by the `get_unseen_common_words` Postgres RPC (database/13): it joins
 * the flat word_frequency ranking to JMDict on surface form to recover JLPT
 * level, reading and gloss, then excludes the user's already-tracked words.
 */
export async function fetchUnseenCommonWords(
  level: number,
  seenWords: string[],
  limit = 40
): Promise<UnseenWord[]> {
  let data: unknown;
  let error: unknown;
  try {
    ({ data, error } = await withTimeout(
      supabase.rpc('get_unseen_common_words', {
        p_level: level,
        p_seen_words: seenWords,
        p_limit: limit,
      }),
      LOOKUP_TIMEOUT_MS,
      'get_unseen_common_words',
    ));
  } catch (e) {
    // A slow RPC is bounded here so it can't hang the UI or pile up connections
    // against an already-strained database.
    console.warn('get_unseen_common_words timed out or failed:', e);
    return [];
  }
  if (error || !data) return [];

  return (data as Array<{
    word: string;
    reading: string | null;
    meaning: string | null;
    rank: number;
  }>).map((r) => ({
    word: r.word,
    reading: r.reading || '',
    meaning: r.meaning || '',
    rank: r.rank,
  }));
}

/**
 * Fetch unseen-foundation intake candidates (#68): important common words at or
 * BELOW the user's JLPT level that they have not yet tracked, ordered foundation-first
 * (easiest level first, then most common). This is the "important words the user hasn't
 * read yet" half of the intake queue — merged with locally-queued encountered words by
 * store.promoteIntakeQueue before the daily cap picks the top few.
 *
 * Backed by the `get_intake_candidates` RPC (database/24): a sibling of
 * get_unseen_common_words that scans all levels ≥ p_user_jlpt in one call, excludes
 * already-tracked words by canonical entry_id (#39), and returns entry_id + level so a
 * promoted word can be canonically keyed and ordered by compareIntake.
 */
export async function fetchIntakeCandidates(
  userJlpt: number,
  seenIds: string[],
  limit = 50,
): Promise<IntakeCandidate[]> {
  let data: unknown;
  let error: unknown;
  try {
    ({ data, error } = await withTimeout(
      supabase.rpc('get_intake_candidates', {
        p_user_jlpt: userJlpt,
        p_seen_ids: seenIds,
        p_limit: limit,
      }),
      LOOKUP_TIMEOUT_MS,
      'get_intake_candidates',
    ));
  } catch (e) {
    console.warn('get_intake_candidates timed out or failed:', e);
    return [];
  }
  if (error || !data) return [];

  return (data as Array<{
    entry_id: string;
    jlpt_level: number | null;
    freq_rank: number | null;
    word: string;
    reading: string | null;
    meaning: string | null;
  }>).map((r) => ({
    entryId: r.entry_id,
    jlptLevel: r.jlpt_level ?? null,
    freqRank: r.freq_rank ?? null,
    word: r.word,
    reading: r.reading || '',
    meaning: r.meaning || '',
  }));
}

