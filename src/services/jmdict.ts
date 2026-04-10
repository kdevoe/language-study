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
  const { data: kanjiRows, error } = await supabase
    .from('jmdict_kanji')
    .select('entry_id')
    .eq('text', text)
    .limit(10);

  if (error || !kanjiRows || kanjiRows.length === 0) return [];

  const entryIds = [...new Set(kanjiRows.map(r => r.entry_id))];
  return fetchEntries(entryIds);
}

async function lookupByKana(text: string): Promise<JMDictResult[]> {
  const { data: kanaRows, error } = await supabase
    .from('jmdict_kana')
    .select('entry_id')
    .eq('text', text)
    .limit(10);

  if (error || !kanaRows || kanaRows.length === 0) return [];

  const entryIds = [...new Set(kanaRows.map(r => r.entry_id))];
  return fetchEntries(entryIds);
}

export async function fetchEntries(entryIds: string[]): Promise<JMDictResult[]> {
  // Fetch entries, kanji forms, kana forms, and senses in parallel
  const [entriesRes, kanjiRes, kanaRes, sensesRes] = await Promise.all([
    supabase.from('jmdict_entries').select('id, common, jlpt_level').in('id', entryIds),
    supabase.from('jmdict_kanji').select('entry_id, text').in('entry_id', entryIds),
    supabase.from('jmdict_kana').select('entry_id, text').in('entry_id', entryIds),
    supabase.from('jmdict_senses').select('entry_id, pos, gloss, field, misc').in('entry_id', entryIds),
  ]);

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

  try {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 5
      })
    });

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

