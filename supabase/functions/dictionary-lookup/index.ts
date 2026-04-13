import { GoogleGenAI } from 'https://esm.sh/@google/genai';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GROQ_MODEL = 'openai/gpt-oss-20b';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// --- JMDict lookup helpers (server-side, mirrors client jmdict.ts) ---

const isKana = (c: string) => /[\u3040-\u309f\u30a0-\u30ff]/.test(c);

function buildFuriganaMap(word: string, reading: string): { kanji: string; kana: string }[] {
  const chars = Array.from(word);

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
      let kanjiEnd = i + 1;
      while (kanjiEnd < chars.length && !isKana(chars[kanjiEnd])) {
        kanjiEnd++;
      }

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

      if (kanjiBlock.length === 1) {
        segments.push({ kanji: kanjiBlock[0], kana: blockReading });
      } else {
        const readingPerKanji = Math.floor(blockReading.length / kanjiBlock.length);
        const remainder = blockReading.length % kanjiBlock.length;
        let rIdx = 0;
        for (let k = 0; k < kanjiBlock.length; k++) {
          const count = readingPerKanji + (k < remainder ? 1 : 0);
          segments.push({ kanji: kanjiBlock[k], kana: blockReading.slice(rIdx, rIdx + count) });
          rIdx += count;
        }
      }

      readingIdx = readingEnd;
      i = kanjiEnd - 1;
    }
  }

  return segments.length > 0 ? segments : [{ kanji: word, kana: reading }];
}

interface JMDictDefinition {
  word: string;
  reading: string;
  meaning: string;
  furiganaMap: { kanji: string; kana: string }[];
  jmdictEntryId?: string;
  pos?: string[];
  jlptLevel?: number | null;
}

async function lookupJMDict(word: string): Promise<JMDictDefinition | null> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  // Try kanji match first, then kana
  let entryIds: string[] = [];

  const { data: kanjiRows } = await supabase
    .from('jmdict_kanji').select('entry_id').eq('text', word).limit(5);
  if (kanjiRows && kanjiRows.length > 0) {
    entryIds = [...new Set(kanjiRows.map((r: { entry_id: string }) => r.entry_id))];
  } else {
    const { data: kanaRows } = await supabase
      .from('jmdict_kana').select('entry_id').eq('text', word).limit(5);
    if (kanaRows && kanaRows.length > 0) {
      entryIds = [...new Set(kanaRows.map((r: { entry_id: string }) => r.entry_id))];
    }
  }

  if (entryIds.length === 0) return null;

  const [entriesRes, kanjiRes, kanaRes, sensesRes] = await Promise.all([
    supabase.from('jmdict_entries').select('id, common, jlpt_level').in('id', entryIds),
    supabase.from('jmdict_kanji').select('entry_id, text').in('entry_id', entryIds),
    supabase.from('jmdict_kana').select('entry_id, text').in('entry_id', entryIds),
    supabase.from('jmdict_senses').select('entry_id, pos, gloss').in('entry_id', entryIds),
  ]);

  if (!entriesRes.data || entriesRes.data.length === 0) return null;

  // Pick the first (most common) entry
  const entry = entriesRes.data[0];
  const reading = (kanaRes.data || []).find((k: { entry_id: string }) => k.entry_id === entry.id)?.text || '';
  const senses = (sensesRes.data || []).filter((s: { entry_id: string }) => s.entry_id === entry.id);
  const allGlosses = senses.flatMap((s: { gloss: string[] }) => s.gloss || []);
  const meaning = allGlosses.slice(0, 3).join('; ') || '';
  const pos = [...new Set(senses.flatMap((s: { pos: string[] }) => s.pos || []))];

  return {
    word,
    reading,
    meaning,
    furiganaMap: buildFuriganaMap(word, reading),
    jmdictEntryId: entry.id,
    pos,
    jlptLevel: entry.jlpt_level,
  };
}

async function groqComplete(prompt: string, jsonMode = false): Promise<string> {
  const apiKey = Deno.env.get('GROQ_API_KEY')!;
  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      response_format: jsonMode ? { type: 'json_object' } : undefined,
    }),
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(`Groq error: ${err.error?.message || response.statusText}`);
  }
  const data = await response.json();
  return data.choices[0].message.content;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { word, contextSentence, jmdictEntryId, type } = await req.json();

    if (!word) {
      return new Response(JSON.stringify({ error: 'word is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // type = 'definition' | 'grammar' | 'translation'
    if (type === 'grammar') {
      // Grammar insight using Gemini
      const geminiKey = Deno.env.get('GEMINI_API_KEY')!;
      const prompt = `Analyze the word "${word}" in this sentence: "${contextSentence}".
MANDATORY: Provide ONLY 1 SINGLE brief sentence in English explaining its specific usage or grammar in this context.
Be extremely concise.`;

      const ai = new GoogleGenAI({ apiKey: geminiKey, httpOptions: { apiVersion: 'v1beta' } });
      const result = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt,
      });
      const insight = (result.text ?? '').trim();

      return new Response(JSON.stringify({ insight }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (type === 'translation') {
      // Sentence translation using Groq
      const prompt = `Translate this Japanese sentence into natural, elegant English: "${word}"
Context: "${(contextSentence || '').substring(0, 300)}"
Just provide the English translation, no other text.`;
      const translation = await groqComplete(prompt);
      return new Response(JSON.stringify({ translation }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Default: word definition — try JMDict first for consistent furigana, fall back to Groq
    const jmdictResult = await lookupJMDict(word).catch(() => null);
    if (jmdictResult) {
      console.log(`[dictionary-lookup] JMDict HIT for "${word}"`);
      return new Response(JSON.stringify(jmdictResult), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[dictionary-lookup] JMDict MISS for "${word}", falling back to Groq`);
    const prompt = `Define "${word}" for context: "${contextSentence}".
CRITICAL: The "furiganaMap" MUST account for EVERY character in "${word}". Break it down 1:1.
Output JSON:
{
  "word": "${word}",
  "reading": "full reading",
  "meaning": "English translation",
  "furiganaMap": [ { "kanji": "...", "kana": "..." }, ... ]
}`;

    const text = await groqComplete(prompt, true);
    const definition = JSON.parse(text);

    return new Response(JSON.stringify(definition), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('[dictionary-lookup] Error:', err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
