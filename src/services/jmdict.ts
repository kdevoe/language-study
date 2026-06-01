/**
 * JMDict Lookup Service
 * 
 * Queries the JMDict tables in Supabase for dictionary lookups.
 * Provides both direct lookups and LLM-assisted disambiguation
 * for ambiguous words with multiple entries.
 */

import { supabase } from './supabase';

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
  isCommon: boolean;
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

  // 2. Fall back to kana
  return lookupByKana(text);
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
    supabase.from('jmdict_entries').select('id, common, jlpt_level').in('id', entryIds),
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
      isCommon: entry.common || false,
    };
  });
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
 * Convert a JMDictResult into a format compatible with WordDetails.
 * Generates a furiganaMap by splitting the word into kanji/kana segments.
 */
export function jmdictToWordDetails(
  word: string,
  result: JMDictResult
): { reading: string; meaning: string; jmdictEntryId: string; pos: string[]; jlptLevel: number | null; furiganaMap: { kanji: string; kana: string }[] } {
  const reading = result.readings[0] || '';
  const allGlosses = result.senses.flatMap(s => s.gloss);
  const meaning = allGlosses.slice(0, 3).join('; ') || '';
  const pos = [...new Set(result.senses.flatMap(s => s.pos))];

  // Build furiganaMap from the word and its kana reading
  const furiganaMap = buildFuriganaMap(word, reading);

  return {
    reading,
    meaning,
    jmdictEntryId: result.entryId,
    pos,
    jlptLevel: result.jlptLevel,
    furiganaMap,
  };
}

const isKana = (c: string) => /[\u3040-\u309f\u30a0-\u30ff]/.test(c);

/**
 * Build a furigana map from a word and its reading.
 * Splits the word into segments: kana chars map to themselves,
 * kanji groups get the remaining reading portion.
 * 
 * Example: "食べる" + "たべる" → [{kanji:"食", kana:"た"}, {kanji:"べ", kana:"べ"}, {kanji:"る", kana:"る"}]
 */
function buildFuriganaMap(word: string, reading: string): { kanji: string; kana: string }[] {
  const chars = Array.from(word);
  
  // If the word is entirely kana, each char maps to itself
  if (chars.every(isKana)) {
    return chars.map(c => ({ kanji: c, kana: c }));
  }

  const segments: { kanji: string; kana: string }[] = [];
  let readingIdx = 0;

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (isKana(char)) {
      segments.push({ kanji: char, kana: char });
      const kanaPos = reading.indexOf(char, readingIdx);
      if (kanaPos !== -1) {
        readingIdx = kanaPos + 1;
      } else {
        readingIdx++;
      }
    } else {
      // Kanji character or consecutive kanjis
      let kanjiEnd = i + 1;
      while (kanjiEnd < chars.length && !isKana(chars[kanjiEnd])) {
        kanjiEnd++;
      }
      
      // Determine the reading for this block of kanji
      let readingEnd = readingIdx;
      if (kanjiEnd < chars.length) {
        const nextKana = chars[kanjiEnd];
        const nextAnchorPos = reading.indexOf(nextKana, readingIdx);
        readingEnd = nextAnchorPos !== -1 ? nextAnchorPos : readingIdx + (kanjiEnd - i);
      } else {
        readingEnd = reading.length;
      }

      const kanjiBlock = chars.slice(i, kanjiEnd);
      const blockReading = reading.slice(readingIdx, readingEnd);

      // MANDATORY: Split the block into individual kanji characters
      // so each gets its own spacing and RTK meaning in the UI.
      if (kanjiBlock.length === 1) {
        segments.push({ kanji: kanjiBlock[0], kana: blockReading });
      } else {
        // Balanced heuristic for multi-kanji blocks (e.g., 2 kanji + 4 kana -> 2:2)
        const readingPerKanji = Math.floor(blockReading.length / kanjiBlock.length);
        const remainder = blockReading.length % kanjiBlock.length;

        let rIdx = 0;
        for (let k = 0; k < kanjiBlock.length; k++) {
          const count = readingPerKanji + (k < remainder ? 1 : 0);
          segments.push({
            kanji: kanjiBlock[k],
            kana: blockReading.slice(rIdx, rIdx + count)
          });
          rIdx += count;
        }
      }

      readingIdx = readingEnd;
      i = kanjiEnd - 1;
    }
  }

  return segments.length > 0 ? segments : [{ kanji: word, kana: reading }];
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

