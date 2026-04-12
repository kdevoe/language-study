import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { GoogleGenerativeAI } from 'https://esm.sh/@google/generative-ai';
import { rtkKanjiList } from '../_shared/rtkKanji.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { userId, articleId, title, snippet } = await req.json();
    if (!userId || !title || !snippet) {
      return new Response(JSON.stringify({ error: 'userId, title, and snippet are required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const geminiKey = Deno.env.get('GEMINI_API_KEY')!;
    const groqKey = Deno.env.get('GROQ_API_KEY')!;

    const supabase = createClient(supabaseUrl, supabaseKey);

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

    // 2. Fetch hard/medium vocab targets from user's SRS progress
    const { data: wordProgress } = await supabase
      .from('user_word_progress')
      .select('word_id, mastery_level')
      .eq('user_id', userId)
      .in('mastery_level', ['hard', 'medium'])
      .limit(30);

    const vocabTargetsData = (wordProgress as any[])?.map(r => r.word_id) ?? [];
    let vocabTargets: string[] = [];
    if (vocabTargetsData.length > 0) {
      // Pick up to 5 random targets to avoid overwhelming the prompt
      const shuffled = [...vocabTargetsData].sort(() => 0.5 - Math.random()).slice(0, 5);
      const { data: kanjiRes } = await supabase.from('jmdict_kanji').select('text').in('entry_id', shuffled);
      if (kanjiRes) {
        vocabTargets = Array.from(new Set(kanjiRes.map((r: any) => r.text)));
      }
    }

    // 3. Build Gemini prompts (same logic as client-side rewriteArticleWithGemini)
    const jlptStr = `N${jlptLevel}`;

    const HEISIG_RTK_RANGE_SIZE = 15;
    const knownKanjiCount = Math.max(0, rtkLevel - HEISIG_RTK_RANGE_SIZE);
    const studyKanji = rtkKanjiList.slice(knownKanjiCount, rtkLevel);

    let biasInstruction = 'NATURAL KANJI READING: Prioritize fluid, authentic, natural Japanese text.';
    if (studyMode === 'study') {
      biasInstruction = `STRICT KANJI BIAS: Target Kanji for this student: [${studyKanji.join(', ')}]. Weave as many of these target Kanji into the story as possible, BUT DO NOT sacrifice natural grammar to do so.`;
    } else if (studyMode === 'balanced') {
      biasInstruction = `BALANCED KANJI BIAS: Target Kanji for this student: [${studyKanji.join(', ')}]. Prefer these Kanji when multiple natural word choices exist.`;
    }

    let vocabInstruction = 'NATURAL VOCABULARY: Use the most fitting authentic Japanese syntax.';
    if (vocabTargets.length > 0) {
      if (vocabMode === 'study') {
        vocabInstruction = `STRICT VOCABULARY BIAS: Target vocabulary: [${vocabTargets.join(', ')}]. Weave these words into the article naturally. Do NOT compromise the clarity or meaning of the news just to use target vocabulary.`;
      } else if (vocabMode === 'balanced') {
        vocabInstruction = `BALANCED VOCABULARY: Target vocabulary: [${vocabTargets.join(', ')}]. Prefer these words when adjacent synonyms exist. Ensure the prose remains completely natural.`;
      }
    }

    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      generationConfig: { responseMimeType: 'application/json' },
    });

    // Pass 1: Rewrite article
    const prompt1 = `
You are a Japanese teacher writing a 3-paragraph news article for a JLPT ${jlptStr} learner.
Student Target Vocabulary: [${vocabTargets.join(', ')}].
Rules:
1. Tone must be like a Japanese news broadcast.
2. Pick 1 or 2 important vocabulary words and explain them in English as a "yugen-box".
3. Provide the full Japanese text strings. DO NOT tokenize the text yet.
4. KANJI PREFERENCE: ${biasInstruction}
5. VOCABULARY PREFERENCE: ${vocabInstruction}
6. NO MARKUP: DO NOT use brackets [], parentheses (), or special formatting around Japanese words.

Output EXACTLY a JSON array:
[{"type":"paragraph"|"yugen-box","text":"...","keyword":"...","reading":"...","description":"..."}]

News Headline: ${title}
News Snippet: ${snippet}
`;

    console.log(`[process-article] Pass 1 for user ${userId}`);
    const result1 = await model.generateContent(prompt1);
    let rawText1 = result1.response.text().replace(/^```(json)?[\s\n]*/i, '').replace(/[\s\n]*```$/i, '').trim();
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
    const result2 = await model.generateContent(prompt2);
    let rawText2 = result2.response.text().replace(/^```(json)?[\s\n]*/i, '').replace(/[\s\n]*```$/i, '').trim();
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
