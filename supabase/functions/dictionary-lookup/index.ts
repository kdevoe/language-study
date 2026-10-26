import Anthropic from 'npm:@anthropic-ai/sdk@0.132.1';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CLAUDE_HAIKU } from '../_shared/models.ts';
import { parseJsonObject, quickHaiku, withGeminiFallback } from '../_shared/claude.ts';
import { buildFuriganaMap } from '../_shared/furiganaMap.ts';
import { actingUserId, resolveCaller } from '../_shared/auth.ts';
import { dataRule, fence, fenceInline } from '../_shared/untrusted.ts';

// Article sentences are untrusted (CLAUDE.md › Security › Prompt injection).
const sentence = (v: unknown) => fenceInline('sentence', String(v ?? ''));
const RULE = dataRule(['sentence', 'text']);

// Offline pack pre-translation (docs/offline-mode-plan.md, phase 6): all of one
// article's sentences in one call, at most this many articles a day per user.
const BATCH_ARTICLES_PER_DAY = 10;
const BATCH_SENTENCES = 80;
const BATCH_SENTENCE_CHARS = 300;

type Json = Record<string, unknown>;

/** The article's Japanese text as the Reader shows it (tokens joined, else raw text). */
function articleText(content: Json): string {
  const blocks = Array.isArray(content.blocks) ? content.blocks as Json[] : [];
  return blocks.map((b) => Array.isArray(b.content)
    ? (b.content as Json[]).map((t) => String(t.text ?? '')).join('')
    : String(b.text ?? '')).join('\n');
}

// Reads ANTHROPIC_API_KEY from the function's secrets.
const anthropic = new Anthropic();

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Signed-in users only (_shared/auth.ts): every call spends Claude credits.
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
    // sentence they appear in and the candidate readings; Haiku picks the right
    // one per item in a single call. This is the narrow, constrained task an LLM
    // is actually good at — the deterministic tokenizer (kuromoji) does the rest.
    // Which JMDict entry a word means in its sentence (several entries share a
    // surface). Moved here from the client, which called Groq with a key that
    // shipped in the web bundle; now Haiku. Returns the candidate's index, 0 when unsure.
    if (type === 'disambiguate') {
      const list: string[] = Array.isArray(body.candidates) ? body.candidates.slice(0, 10).map(String) : [];
      let index = 0;
      if (list.length > 1 && typeof word === 'string') {
        const prompt = `Given the Japanese word "${word}" in this sentence: ${sentence(contextSentence)}

Which dictionary entry is the correct match? Return ONLY the index number.
${RULE}

Candidates:
${list.map((c, i) => `[${i}] ${c}`).join('\n')}

Answer (just the number):`;
        try {
          const n = parseInt((await quickHaiku(prompt, 16)).trim(), 10);
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
        `${i + 1}. word: "${it.surface}" | candidates: ${(it.candidates || []).join(', ')} | sentence: ${sentence(it.sentence)}`,
      ).join('\n');
      const prompt = `You are a Japanese reading disambiguator. For each item, give the correct reading of "word" as it is used in its "sentence", in HIRAGANA only. Pick from "candidates" when the right reading is among them.
Return ONLY JSON: {"readings": ["…", "…"]} — one hiragana reading per item, in the same order, exactly ${list.length} entries.
${RULE}

${lines}`;

      let readings: string[] = [];
      try {
        const parsed = parseJsonObject<{ readings?: unknown; results?: unknown }>(await quickHaiku(prompt, 1024));
        const arr = parsed.readings ?? parsed.results ?? [];
        if (Array.isArray(arr)) readings = arr.map((r: unknown) => String(r ?? '').trim());
      } catch (e) {
        console.warn('[dictionary-lookup] readings disambiguation failed:', e);
      }
      return new Response(JSON.stringify({ readings }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // The offline pack's sentence translations for one of the caller's own
    // articles. Only sentences found in that article's stored text are
    // translated (the action can't be used as a general translator), the result
    // is saved on the article row and returned from there next time, and a
    // per-user daily cap bounds the spend.
    if (type === 'translate_batch') {
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), {
        status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
      const userId = actingUserId(caller, body.userId);
      const articleId = typeof body.articleId === 'string' ? body.articleId : '';
      if (!userId || !articleId) return json({ error: 'articleId is required' }, 400);
      const admin = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey);
      const { data: row, error } = await admin.from('processed_news').select('content')
        .eq('id', articleId).eq('user_id', userId).maybeSingle();
      if (error) throw error;
      if (!row?.content) return json({ error: 'article not found' }, 404);
      const content = row.content as Json;
      const saved = (content.translations ?? {}) as Record<string, string>;

      const text = articleText(content);
      const asked: string[] = Array.isArray(body.sentences) ? body.sentences : [];
      const wanted = [...new Set(asked.map((x) => String(x ?? '').trim()))]
        .filter((x) => x && x.length <= BATCH_SENTENCE_CHARS && /[\u3040-\u30ff\u4e00-\u9fff]/.test(x) && text.includes(x))
        .slice(0, BATCH_SENTENCES);
      const missing = wanted.filter((x) => !saved[x]);
      if (missing.length === 0) return json({ translations: saved });

      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);
      const { count } = await admin.from('processed_news').select('id', { count: 'exact', head: true })
        .eq('user_id', userId).gte('content->>translatedAt', startOfDay.toISOString());
      if ((count ?? 0) >= BATCH_ARTICLES_PER_DAY) return json({ translations: saved, errorKind: 'cap' }, 429);

      const prompt = `Translate each numbered Japanese sentence into natural, elegant English. The sentences come from one article, in order, so use the earlier ones as context.
Return ONLY JSON: {"translations": ["…", "…"]} with exactly ${missing.length} entries, one per sentence, in the same order. Plain text, no notes.
${dataRule(['sentences'])}

${fence('sentences', missing.map((x, i) => `${i + 1}. ${x}`).join('\n'))}`;
      const reply = parseJsonObject<{ translations?: unknown }>(await quickHaiku(prompt, 8192));
      const list = Array.isArray(reply.translations) ? reply.translations : [];
      // Output check: plain short strings, nothing to follow (no links or addresses).
      const next = { ...saved };
      missing.forEach((x, i) => {
        const t = String(list[i] ?? '').trim();
        if (t && t.length <= 600 && !/https?:|www\.|\S+@\S+\.\w/.test(t)) next[x] = t;
      });
      await admin.from('processed_news')
        .update({ content: { ...content, translations: next, translatedAt: new Date().toISOString() } })
        .eq('id', articleId).eq('user_id', userId);
      return json({ translations: next });
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
        ? `In this Japanese sentence: ${sentence(contextSentence)}, the part "${word}" is the grammar pattern ${named(point)}.
${RULE}
MANDATORY: In 1-2 brief sentences of English, explain what this pattern does in this particular sentence: what it attaches to here and what it adds to the meaning.
Be concise. Write plain text (no markdown) and do not include romanized readings.`
        : `Analyze the word "${word}" in this sentence: ${sentence(contextSentence)}.
${RULE}
MANDATORY: Provide ONLY 1 SINGLE brief sentence in English explaining its specific usage or grammar in this context.
Be extremely concise. Write plain text (no markdown) and do not include romanized readings.${
          Array.isArray(points) && points.length
            ? `\nThe word is part of this grammar pattern: ${points.slice(0, 4).map(named).join('; ')}. If you mention it, use that name.`
            : ''}`;

      const insight = (await withGeminiFallback(async () => {
        const message = await anthropic.messages.create({
          model: CLAUDE_HAIKU,
          max_tokens: 2048, // covers adaptive thinking + the one-sentence answer
          messages: [{ role: 'user', content: prompt }],
        });
        if (message.stop_reason === 'refusal') throw new Error('grammar insight declined by model');
        return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      }, prompt, { maxTokens: 2048 })).trim();

      return new Response(JSON.stringify({ insight }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (type === 'translation') {
      // Sentence translation (Haiku, thinking off)
      const prompt = `Translate this Japanese sentence into natural, elegant English: ${fenceInline('text', String(word ?? ''))}
Context: ${sentence((contextSentence || '').substring(0, 300))}
Just provide the English translation, no other text.
${RULE}`;
      const translation = await quickHaiku(prompt, 1024);
      return new Response(JSON.stringify({ translation }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Default: word definition — try JMDict first for consistent furigana, fall back to Haiku
    const jmdictResult = await lookupJMDict(word).catch(() => null);
    if (jmdictResult) {
      console.log(`[dictionary-lookup] JMDict HIT for "${word}"`);
      return new Response(JSON.stringify(jmdictResult), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[dictionary-lookup] JMDict MISS for "${word}", falling back to Haiku`);
    const prompt = `Define "${word}" for context: ${sentence(contextSentence)}.
${RULE}
CRITICAL: The "furiganaMap" MUST account for EVERY character in "${word}". Break it down 1:1.
Output JSON:
{
  "word": "${word}",
  "reading": "full reading",
  "meaning": "English translation",
  "furiganaMap": [ { "kanji": "...", "kana": "..." }, ... ]
}`;

    const definition = parseJsonObject(await quickHaiku(prompt, 1024));

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
