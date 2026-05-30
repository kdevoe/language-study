import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { GoogleGenAI } from 'https://esm.sh/@google/genai';
import { rtkKanjiList } from '../_shared/rtkKanji.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GROQ_MODEL = 'openai/gpt-oss-20b';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// ── Opportunistic full-text extraction ──────────────────────────────────────
// A NewsAPI/RSS teaser is ~150-200 chars; the real article body is 10-100x
// richer. We pull it from the source URL via Jina Reader, but only for sources
// whose teaser is thin (full-text feeds like Ars already ship the body) and
// only for articles the user actually opens. Always falls back to the teaser.
const JINA_READER_URL = 'https://r.jina.ai/';
const EXTRACT_TEASER_THRESHOLD = 600; // skip extraction when teaser already this long
const EXTRACT_TIMEOUT_MS = 8000;
const MAX_EXTRACT_SOURCES = 4;
const PER_SOURCE_CHAR_CAP = 2500;
const TOTAL_SOURCE_CHAR_CAP = 7000;

interface SourceRef { title?: string; url?: string; teaser?: string }

async function extractFullText(url: string, jinaKey: string | undefined): Promise<string> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), EXTRACT_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'User-Agent': 'YugenStudy/1.0', 'Accept': 'text/plain' };
    if (jinaKey) headers['Authorization'] = `Bearer ${jinaKey}`;
    const res = await fetch(JINA_READER_URL + url, { headers, signal: ctrl.signal });
    if (!res.ok) return '';
    const txt = await res.text();
    // Jina prepends a "Title:/URL Source:/Markdown Content:" header — keep the body.
    return (txt.split(/Markdown Content:\s*/i).pop() || txt).trim();
  } catch {
    return '';
  } finally {
    clearTimeout(to);
  }
}

// Build the richest source block we can: extracted full text where a teaser is
// thin and extraction succeeds, teaser otherwise. Returns '' if no sources.
async function buildSourceBlock(sources: SourceRef[], jinaKey: string | undefined): Promise<string> {
  const picked = sources.filter((s) => s && (s.teaser || s.url)).slice(0, MAX_EXTRACT_SOURCES);
  if (picked.length === 0) return '';

  const parts = await Promise.all(picked.map(async (s, n) => {
    let body = (s.teaser || '').trim();
    if (s.url && body.length < EXTRACT_TEASER_THRESHOLD) {
      const full = await extractFullText(s.url, jinaKey);
      if (full && full.length > body.length) body = full;
    }
    body = body.slice(0, PER_SOURCE_CHAR_CAP);
    return `${n + 1}. ${s.title || ''} — ${body}`.trim();
  }));

  let block = parts.join('\n\n');
  if (block.length > TOTAL_SOURCE_CHAR_CAP) block = block.slice(0, TOTAL_SOURCE_CHAR_CAP);
  return block.trim();
}

// Approximate number of unique word tokens in a 3-paragraph article.
// Used to translate intensity ratios into concrete palette counts.
const WORDS_PER_ARTICLE = 200;

// reading_intensity preset -> target distribution of known/review/new vocab.
// See database/10_reading_intensity.sql for the column definition.
const INTENSITY_RATIOS: Record<string, { known: number; review: number; new: number }> = {
  leisure:   { known: 0.980, review: 0.015, new: 0.005 },
  balanced:  { known: 0.950, review: 0.040, new: 0.010 },
  intensive: { known: 0.900, review: 0.080, new: 0.020 },
};

// Representative grammar / phrasing patterns per JLPT level. Constraining grammar
// — not just vocabulary — is the single biggest lever for actually hitting a
// level: "N4" otherwise means whatever the model feels like on a given run, which
// is exactly what makes a level hard to dial in. We tell Gemini to build sentences
// from the target level's patterns and to paraphrase anything above it down.
const JLPT_GRAMMAR: Record<number, string[]> = {
  5: ['です・ます体', '〜は〜です', '〜があります／います', '〜たいです', '〜てください', '〜てから', '〜から（理由）', '〜が、（逆接）', '〜ましょう'],
  4: ['〜なければならない', '〜たほうがいい', '〜つもりだ', '〜（よ）うと思う', '〜そうだ（様態）', '〜たり〜たり', '〜ことができる', '〜ながら', '〜ば', '〜なら', '〜てしまう', '基本的な受身・使役'],
  3: ['〜ものの', '〜において', '〜に対して', '〜によって', '〜ため（に）', '〜ように', '〜ば〜ほど', '〜わけだ', '〜とともに', '〜にとって', '〜ことになる', '〜はずだ'],
  2: ['〜にもかかわらず', '〜を通じて', '〜に基づいて', '〜をめぐって', '〜どころか', '〜ざるを得ない', '〜に限らず', '〜つつある', '〜一方で'],
  1: ['〜をもって', '〜にあって', '〜ならではの', '〜を余儀なくされる', '〜とあって', '〜きらいがある', '抽象的・論説的な複文'],
};

// Build the grammar directive for the target level: lean on this level's
// patterns, paraphrase anything from the level above back down. Lower JLPT
// number = harder, so "one level up" is jlpt - 1.
function buildGrammarDirective(jlpt: number): string {
  const jlptStr = `N${jlpt}`;
  const use = (JLPT_GRAMMAR[jlpt] ?? JLPT_GRAMMAR[3]).join('、');
  const harderStr = jlpt > 1 ? (JLPT_GRAMMAR[Math.max(1, jlpt - 1)] ?? []).join('、') : '';
  const avoidLine = harderStr
    ? `\n- AVOID grammar above ${jlptStr} (e.g. ${harderStr}) — paraphrase those into the patterns above instead.`
    : '';

  return `GRAMMAR (primary level lever — match these patterns closely):
- Build sentences mainly from these ${jlptStr} grammar/phrasing patterns: ${use}.${avoidLine}`;
}

async function extractKeywordsWithGroq(title: string, snippet: string, apiKey: string): Promise<string[]> {
  const prompt = `Extract 10-15 topic keywords from this English news article. Return ONLY a JSON array of lowercase single-word or two-word phrases — concrete nouns and topic terms preferred (skip filler like "the", "said", "people"). No explanation.

Title: ${title}
Snippet: ${snippet}

Example output: ["economy", "trade", "tariff", "minister", "election"]`;

  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Groq keyword extraction failed: ${err.error?.message || response.statusText}`);
  }
  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content ?? '[]';
  // gpt-oss-20b in json_object mode may wrap in {"keywords": [...]} or return a bare array
  const parsed = JSON.parse(raw);
  const arr: unknown = Array.isArray(parsed) ? parsed : (parsed.keywords ?? parsed.topics ?? parsed.terms ?? []);
  if (!Array.isArray(arr)) return [];
  return arr.map(String).map((s) => s.toLowerCase().trim()).filter((s) => s.length >= 2 && s.length <= 30);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { userId, articleId, title, snippet, sources } = await req.json();
    if (!userId || !title || !(snippet || (Array.isArray(sources) && sources.length))) {
      return new Response(JSON.stringify({ error: 'userId, title, and snippet or sources are required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const geminiKey = Deno.env.get('GEMINI_API_KEY')!;
    const groqKey = Deno.env.get('GROQ_API_KEY')!;
    const jinaKey = Deno.env.get('JINA_API_KEY'); // optional — lifts extraction hit rate

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Opportunistically upgrade thin teasers to full article text. Falls back
    // to the merged teaser block (snippet) when no sources / extraction fails.
    let sourceText = snippet ?? '';
    if (Array.isArray(sources) && sources.length > 0) {
      try {
        const built = await buildSourceBlock(sources as SourceRef[], jinaKey);
        if (built) {
          sourceText = built;
          console.log(`[process-article] built source block from ${sources.length} source(s), ${built.length} chars`);
        }
      } catch (e) {
        console.warn('[process-article] source extraction failed, using teaser:', e instanceof Error ? e.message : e);
      }
    }

    // 1. Fetch user preferences
    const { data: prefs } = await supabase
      .from('user_preferences')
      .select('*')
      .eq('user_id', userId)
      .single();

    const jlptLevel = prefs?.jlpt_level ?? 5;
    const rtkLevel = prefs?.rtk_level ?? 0;
    const studyMode = prefs?.study_mode ?? 'balanced';
    const vocabMode = prefs?.vocab_mode ?? 'balanced';
    const readingIntensity: string = prefs?.reading_intensity ?? 'balanced';
    const ratios = INTENSITY_RATIOS[readingIntensity] ?? INTENSITY_RATIOS.balanced;
    const targetReview = Math.max(1, Math.round(ratios.review * WORDS_PER_ARTICLE));
    const targetNew = Math.max(1, Math.round(ratios.new * WORDS_PER_ARTICLE));

    // 2. Vocabulary palette pipeline
    //    a) Extract topic keywords from the English source (Groq)
    //    b) Query JMDict for candidate entries whose glosses match
    //    c) Bucket candidates into known / review / new vs. user_word_progress
    let knownPalette: string[] = [];
    let reviewPalette: string[] = [];
    let newPalette: string[] = [];
    let vocabTargets: string[] = []; // legacy: kept for vocab_mode prompt back-compat
    try {
      const keywords = await extractKeywordsWithGroq(title, sourceText.slice(0, 2000), groqKey);
      if (keywords.length > 0) {
        const keywordPatterns = keywords.map((k) => `%${k}%`);
        const { data: candidates, error: candErr } = await supabase.rpc('jmdict_vocab_candidates', {
          keywords: keywordPatterns,
          user_jlpt: jlptLevel,
          max_results: 200,
        });
        if (candErr) throw candErr;

        const entryIds: string[] = (candidates ?? []).map((c: any) => c.entry_id);
        let progressMap = new Map<string, string>();
        if (entryIds.length > 0) {
          const { data: progress } = await supabase
            .from('user_word_progress')
            .select('word_id, mastery_level')
            .eq('user_id', userId)
            .in('word_id', entryIds);
          progressMap = new Map((progress ?? []).map((p: any) => [p.word_id, p.mastery_level]));
        }

        // Sort candidates: common words first, then by jlpt_level (easier first).
        const sorted = [...(candidates ?? [])].sort((a: any, b: any) => {
          if (a.is_common !== b.is_common) return a.is_common ? -1 : 1;
          return (b.jlpt_level ?? 0) - (a.jlpt_level ?? 0);
        });

        for (const c of sorted) {
          const display = c.kanji || c.kana;
          if (!display) continue;
          const mastery = progressMap.get(c.entry_id);
          if (mastery === 'easy') {
            knownPalette.push(display);
          } else if (mastery === 'hard' || mastery === 'medium') {
            reviewPalette.push(display);
          } else if (c.jlpt_level > jlptLevel) {
            // Below user's study level (easier) => treat as assumed-known
            knownPalette.push(display);
          } else if (c.jlpt_level === jlptLevel && !mastery) {
            newPalette.push(display);
          }
        }
        // De-dupe while preserving order
        knownPalette = Array.from(new Set(knownPalette)).slice(0, 30);
        reviewPalette = Array.from(new Set(reviewPalette)).slice(0, Math.max(5, targetReview + 2));
        newPalette = Array.from(new Set(newPalette)).slice(0, Math.max(3, targetNew + 2));
      }
      console.log(`[process-article] Palette: ${knownPalette.length} known, ${reviewPalette.length} review, ${newPalette.length} new (intensity=${readingIntensity})`);
    } catch (palErr) {
      console.error('[process-article] Palette pipeline error (continuing without palette):', palErr);
    }

    // Legacy vocab_mode targets: any user review words, regardless of this article's topic.
    // Still used below so the vocab_mode "Study" prompt keeps working even when the
    // topic-keyed review palette is empty.
    if (reviewPalette.length > 0) {
      vocabTargets = reviewPalette.slice(0, 5);
    } else {
      const { data: wordProgress } = await supabase
        .from('user_word_progress')
        .select('word_id')
        .eq('user_id', userId)
        .in('mastery_level', ['hard', 'medium'])
        .limit(30);
      const ids = (wordProgress as any[])?.map((r) => r.word_id) ?? [];
      if (ids.length > 0) {
        const shuffled = [...ids].sort(() => 0.5 - Math.random()).slice(0, 5);
        const { data: kanjiRes } = await supabase.from('jmdict_kanji').select('text').in('entry_id', shuffled);
        if (kanjiRes) vocabTargets = Array.from(new Set(kanjiRes.map((r: any) => r.text)));
      }
    }

    // 3. Build Gemini prompts (same logic as client-side rewriteArticleWithGemini)
    const jlptStr = `N${jlptLevel}`;

    const JLPT_LEVEL_CONFIG: Record<number, { description: string; paragraphs: string }> = {
      5: {
        description: 'N5: The reader understands some basic Japanese. Write simple sentences using hiragana, katakana, and basic kanji. Basic vocabulary and elementary grammar only.',
        paragraphs: '3',
      },
      4: {
        description: 'N4: The reader understands basic Japanese. Write about familiar daily topics using basic vocabulary and kanji. Simple compound sentences are acceptable.',
        paragraphs: '3-4',
      },
      3: {
        description: 'N3: The reader understands everyday Japanese. Write like a real newspaper article — use compound sentences, natural news phrasing, and intermediate grammar. The reader can handle newspaper headlines and slightly difficult text with context. Do NOT over-simplify to basic sentence patterns.',
        paragraphs: '4-5',
      },
      2: {
        description: 'N2: The reader understands Japanese used in everyday situations and a variety of circumstances. Write like a real newspaper article or commentary — clear, natural prose on general topics at near-natural complexity.',
        paragraphs: '5-6',
      },
      1: {
        description: 'N1: The reader understands Japanese used in a variety of circumstances. Write with full natural complexity — abstract reasoning, editorials, and nuanced prose are appropriate.',
        paragraphs: '5-6',
      },
    };
    const levelConfig = JLPT_LEVEL_CONFIG[jlptLevel] ?? JLPT_LEVEL_CONFIG[3];
    const grammarDirective = buildGrammarDirective(jlptLevel);

    const HEISIG_RTK_RANGE_SIZE = 15;
    const knownKanjiCount = Math.max(0, rtkLevel - HEISIG_RTK_RANGE_SIZE);
    const studyKanji = rtkKanjiList.slice(knownKanjiCount, rtkLevel);

    let biasInstruction = 'NATURAL KANJI READING: Prioritize fluid, authentic, natural Japanese text.';
    if (studyMode === 'study') {
      biasInstruction = `STRICT KANJI PREFERENCE: The student is studying these Kanji: [${studyKanji.join(', ')}]. Prefer vocabulary using these Kanji ONLY IF the word accurately describes the actual facts of the news. CRITICAL: DO NOT invent poetic metaphors or unrelated events just to use a Kanji.`;
    } else if (studyMode === 'balanced') {
      biasInstruction = `BALANCED KANJI BIAS: Target Kanji for this student: [${studyKanji.join(', ')}]. Prefer these Kanji when multiple natural word choices exist.`;
    }

    let vocabInstruction = 'NATURAL VOCABULARY: Use the most fitting authentic Japanese syntax.';
    if (vocabTargets.length > 0) {
      if (vocabMode === 'study') {
        vocabInstruction = `STRICT VOCABULARY BIAS: Target vocabulary: [${vocabTargets.join(', ')}]. Use these words ONLY if they perfectly fit the factual events in the headline. DO NOT hallucinate facts, use heavy metaphors, or warp the news story just to fit a word.`;
      } else if (vocabMode === 'balanced') {
        vocabInstruction = `BALANCED VOCABULARY: Target vocabulary: [${vocabTargets.join(', ')}]. Prefer these words when adjacent synonyms exist. Ensure the prose remains completely natural.`;
      }
    }

    const ai = new GoogleGenAI({ apiKey: geminiKey, httpOptions: { apiVersion: 'v1beta' } });

    // Build targeted vocab palette block (empty string if pipeline produced nothing)
    let palettePrompt = '';
    if (knownPalette.length + reviewPalette.length + newPalette.length > 0) {
      const pctKnown = Math.round(ratios.known * 100);
      const pctReview = Math.round(ratios.review * 100);
      const pctNew = Math.round(ratios.new * 100);
      palettePrompt = `
VOCABULARY PALETTE (aim for ~${pctKnown}% known / ~${pctReview}% review / ~${pctNew}% new by token count):
- KNOWN words — draw freely from this list; these form the backbone of the article: ${knownPalette.join('、') || '(rely on natural ' + jlptStr + ' and easier vocabulary)'}
- REVIEW words — work about ${targetReview} of these in where they fit the facts naturally: ${reviewPalette.join('、') || '(none)'}
- NEW words — introduce about ${targetNew} of these if the topic allows, and gloss any you use in a yugen-box: ${newPalette.join('、') || '(none)'}
Treat this palette as a GUIDE, not a quota. Never distort the facts or insert unnatural phrasing just to hit a word.`;
    }

    // Pass 1: Rewrite article
    const prompt1 = `
You are a factual Japanese news reporter writing a ${levelConfig.paragraphs} paragraph news article for a JLPT ${jlptStr} learner.
LEVEL GUIDANCE: ${levelConfig.description}
${grammarDirective}
Topic: ${title}
Sources (real English news text; the FIRST source is the primary story):
${sourceText}

SOURCE HANDLING: Build ONE coherent article around the first source as the main story. Where the other sources genuinely concern the same story, combine their overlapping facts and add their detail without repeating points. If a source is about a clearly different or unrelated story, IGNORE it — never stitch unrelated events together into one article.

GOLDEN RULE: The article MUST accurately report only the events described in the Sources above. DO NOT invent facts not present in the Sources, and DO NOT use abstract, poetic, or metaphorical language. Stick to facts.
${palettePrompt}

Rules:
1. Tone must be like a factual Japanese news broadcast.
2. Pick 1 or 2 important vocabulary words and explain them in English as a "yugen-box".
3. Provide the full Japanese text strings. DO NOT tokenize the text yet.
4. KANJI PREFERENCE: ${biasInstruction}
5. VOCABULARY PREFERENCE: ${vocabInstruction}
6. NO MARKUP: DO NOT use brackets [], parentheses (), or special formatting around Japanese words.

Output EXACTLY a JSON array:
[{"type":"paragraph"|"yugen-box","text":"...","keyword":"...","reading":"...","description":"..."}]
`;

    console.log(`[process-article] Pass 1 for user ${userId}`);
    const result1 = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt1,
      config: { responseMimeType: 'application/json' },
    });
    let rawText1 = (result1.text ?? '').replace(/^```(json)?[\s\n]*/i, '').replace(/[\s\n]*```$/i, '').trim();
    const rawBlocks = JSON.parse(rawText1);

    // Pass 2: Tokenize + furigana
    const prompt2 = `
You are a morphological analyzer. For every "text" field in this JSON, replace it with a "content" array of individual Japanese tokens.
CRITICAL: For EVERY word token containing Kanji, provide a "furigana" field showing its reading.
CRITICAL: Strip all brackets [], special markup from text.

Input:
${JSON.stringify(rawBlocks, null, 2)}

Output EXACTLY a JSON array:
[{"type":"paragraph"|"yugen-box","content":[{"text":"...","furigana":"..."}],"keyword":"...","reading":"...","description":"..."}]
`;

    console.log(`[process-article] Pass 2 (tokenize) for user ${userId}`);
    const result2 = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt2,
      config: { responseMimeType: 'application/json' },
    });
    let rawText2 = (result2.text ?? '').replace(/^```(json)?[\s\n]*/i, '').replace(/[\s\n]*```$/i, '').trim();
    const processedBlocks = JSON.parse(rawText2);

    // ─────────────────────────────────────────────────────────────────────────
    // Pass 3: Server-Side JMDict Linking
    // ─────────────────────────────────────────────────────────────────────────
    try {
      console.log(`[process-article] Pass 3 (JMDict linking) for user ${userId}`);
      
      const tokensToLink = new Set<string>();
      processedBlocks.forEach((block: any) => {
        block.content?.forEach((token: any) => {
          if (token.furigana) tokensToLink.add(token.text);
        });
      });

      const uniqueWords = Array.from(tokensToLink);
      if (uniqueWords.length > 0) {
        // Batch query Kanji and Kana matches
        const [kanjiRes, kanaRes] = await Promise.all([
          supabase.from('jmdict_kanji').select('entry_id, text').in('text', uniqueWords),
          supabase.from('jmdict_kana').select('entry_id, text').in('text', uniqueWords),
        ]);

        const resolvedMap = new Map<string, string>(); // word -> entry_id

        // Simple mapping: Store the first entry_id found for each word
        // (In a more advanced version, we could check for 'common' flags or disambiguate)
        kanjiRes.data?.forEach((r: any) => { if (!resolvedMap.has(r.text)) resolvedMap.set(r.text, r.entry_id); });
        kanaRes.data?.forEach((r: any) => { if (!resolvedMap.has(r.text)) resolvedMap.set(r.text, r.entry_id); });

        // Update blocks with entry IDs
        processedBlocks.forEach((block: any) => {
          block.content?.forEach((token: any) => {
            if (resolvedMap.has(token.text)) {
              token.jmdict_entry_id = resolvedMap.get(token.text);
            }
          });
        });
        console.log(`[process-article] Successfully linked ${resolvedMap.size} unique tokens.`);
      }
    } catch (linkErr) {
      console.error('[process-article] JMDict linking error (skipping):', linkErr);
      // We don't fail the whole request if linking fails; just return unlinked article
    }

    // 4. Save to processed_news
    const finalArticleId = articleId || `${Date.now()}-${userId.slice(0, 8)}`;
    const { error: saveError } = await supabase
      .from('processed_news')
      .upsert({
        id: finalArticleId,
        user_id: userId,
        title,
        content: {
          id: finalArticleId,
          title,
          originalUrl: '',
          blocks: processedBlocks,
          date: new Date().toISOString(),
          readTime: '5分で読める',
          category: 'Recent News',
        },
        metadata: { date: new Date().toISOString(), category: 'Recent News' },
      });

    if (saveError) {
      console.error('[process-article] Save error:', saveError);
      return new Response(JSON.stringify({ error: saveError.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[process-article] ✅ Saved article ${finalArticleId}`);
    return new Response(JSON.stringify({ success: true, articleId: finalArticleId, blocks: processedBlocks }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('[process-article] Error:', err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
