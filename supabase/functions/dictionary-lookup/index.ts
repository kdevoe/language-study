import Anthropic from 'npm:@anthropic-ai/sdk@0.132.1';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CLAUDE_HAIKU, GROQ_GENERAL as GROQ_MODEL } from '../_shared/models.ts';
import { buildFuriganaMap } from '../_shared/furiganaMap.ts';
import { resolveCaller } from '../_shared/auth.ts';

// Reads ANTHROPIC_API_KEY from the function's secrets.
const anthropic = new Anthropic();

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// --- JMDict lookup helpers (server-side, mirrors client jmdict.ts) ---

// isKana / buildFuriganaMap moved to ../_shared/furiganaMap.ts so the alignment
// is unit-testable offline (scripts/test-furigana-map.mjs).

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
    // Signed-in users only (_shared/auth.ts): every call spends Groq / Claude credits.
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const caller = await resolveCaller(req, createClient(Deno.env.get('SUPABASE_URL')!, serviceKey), serviceKey);
    if (!caller) {
      return new Response(JSON.stringify({ error: 'sign in required', errorKind: 'unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json();
    const { word, contextSentence, jmdictEntryId, type, items, points, point } = body;

    // Batched heteronym reading disambiguation. The client sends words whose
    // surface has more than one common reading (今日, 市場, 上手, 日本…) with the
    // sentence they appear in and the candidate readings; Groq picks the right
    // one per item in a single call. This is the narrow, constrained task an LLM
    // is actually good at — the deterministic tokenizer (kuromoji) does the rest.
    // Which JMDict entry a word means in its sentence (several entries share a
    // surface). Moved here from the client, which called Groq with a key that
    // shipped in the web bundle. Returns the candidate's index, 0 when unsure.
    if (type === 'disambiguate') {
      const list: string[] = Array.isArray(body.candidates) ? body.candidates.slice(0, 10).map(String) : [];
      let index = 0;
      if (list.length > 1 && typeof word === 'string') {
        const prompt = `Given the Japanese word "${word}" in this sentence: "${String(contextSentence ?? '')}"

Which dictionary entry is the correct match? Return ONLY the index number.

Candidates:
${list.map((c, i) => `[${i}] ${c}`).join('\n')}

Answer (just the number):`;
        try {
          const n = parseInt((await groqComplete(prompt)).trim(), 10);
          if (!isNaN(n) && n >= 0 && n < list.length) index = n;
        } catch (e) {
          console.warn('[dictionary-lookup] disambiguate failed:', e instanceof Error ? e.message : e);
        }
      }
      return new Response(JSON.stringify({ index }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (type === 'readings') {
      const list: { surface: string; sentence: string; candidates: string[] }[] =
        Array.isArray(items) ? items.slice(0, 40) : [];
      if (list.length === 0) {
        return new Response(JSON.stringify({ readings: [] }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const lines = list.map((it, i) =>
        `${i + 1}. word: "${it.surface}" | candidates: ${(it.candidates || []).join(', ')} | sentence: "${it.sentence}"`,
      ).join('\n');
      const prompt = `You are a Japanese reading disambiguator. For each item, give the correct reading of "word" as it is used in its "sentence", in HIRAGANA only. Pick from "candidates" when the right reading is among them.
Return ONLY JSON: {"readings": ["…", "…"]} — one hiragana reading per item, in the same order, exactly ${list.length} entries.

${lines}`;

      let readings: string[] = [];
      try {
        const text = await groqComplete(prompt, true);
        const parsed = JSON.parse(text);
        const arr = Array.isArray(parsed) ? parsed : (parsed.readings ?? parsed.results ?? []);
        if (Array.isArray(arr)) readings = arr.map((r: unknown) => String(r ?? '').trim());
      } catch (e) {
        console.warn('[dictionary-lookup] readings disambiguation failed:', e);
      }
      return new Response(JSON.stringify({ readings }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!word) {
      return new Response(JSON.stringify({ error: 'word is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // type = 'definition' | 'grammar' | 'translation'
    if (type === 'grammar') {
      // Grammar insight using Claude Haiku: ~1s vs ~3-4s on Gemini flash at a
      // fraction of the cost, and plain-text output (Gemini wrapped terms in
      // *markdown* that WordModal renders literally). Haiku occasionally invented
      // romanized readings, hence the no-romaji line.
      // Grammar points (#43) come from the reader's catalogue: `point` asks about
      // one point in this sentence (the grammar panel); `points` names the points
      // a word takes part in, so the word insight uses the same names as the
      // panel's rows and doesn't contradict them.
      const clip = (v: unknown) => String(v ?? '').slice(0, 80);
      const named = (p: { pattern?: unknown; meaning?: unknown }) => `${clip(p.pattern)} (${clip(p.meaning)})`;
      const prompt = point
        ? `In this Japanese sentence: "${contextSentence}", the part "${word}" is the grammar pattern ${named(point)}.
MANDATORY: In 1-2 brief sentences of English, explain what this pattern does in this particular sentence: what it attaches to here and what it adds to the meaning.
Be concise. Write plain text (no markdown) and do not include romanized readings.`
        : `Analyze the word "${word}" in this sentence: "${contextSentence}".
MANDATORY: Provide ONLY 1 SINGLE brief sentence in English explaining its specific usage or grammar in this context.
Be extremely concise. Write plain text (no markdown) and do not include romanized readings.${
          Array.isArray(points) && points.length
            ? `\nThe word is part of this grammar pattern: ${points.slice(0, 4).map(named).join('; ')}. If you mention it, use that name.`
            : ''}`;

      const message = await anthropic.messages.create({
        model: CLAUDE_HAIKU,
        max_tokens: 2048, // covers adaptive thinking + the one-sentence answer
        messages: [{ role: 'user', content: prompt }],
      });
      if (message.stop_reason === 'refusal') throw new Error('grammar insight declined by model');
      const insight = message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();

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
