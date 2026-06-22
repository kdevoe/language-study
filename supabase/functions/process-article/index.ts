import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { GoogleGenAI } from 'https://esm.sh/@google/genai';
import { rtkKanjiList } from '../_shared/rtkKanji.ts';
import { GEMINI_FLASH, GROQ_GENERAL as GROQ_MODEL } from '../_shared/models.ts';
import { classifyBucket, compareByProximity, compareKnown, compareStuck, type WordSignal } from '../_shared/wordPriority.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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

// ── Source fullness classification ──────────────────────────────────────────
// We track how much real source material Gemini actually received, because
// article quality tracks it directly: a bare ~200-char teaser forces Gemini to
// pad ("50% means half"), while an extracted body produces real news prose.
// Stored on processed_news (source_kind / source_chars) for aggregate analytics
// and echoed into content JSON so the Feed can badge full-text articles.
//   full    — a real article body reached Gemini, whether Jina-extracted or
//             shipped whole by a full-text feed (e.g. Ars via content:encoded)
//   partial — more than a bare teaser (e.g. a short full-text RSS body), but thin
//   snippet — only the ~150-200 char NewsAPI/teaser fallback reached Gemini
type SourceKind = 'full' | 'partial' | 'snippet';
const FULL_SOURCE_CHARS = 1500;    // a body Gemini can build a real article from
const PARTIAL_SOURCE_CHARS = 600;  // richer than a bare teaser, but not a full body

function classifySourceFullness(chars: number, fullBody: boolean): SourceKind {
  if (fullBody && chars >= FULL_SOURCE_CHARS) return 'full';
  if (chars >= PARTIAL_SOURCE_CHARS) return 'partial';
  return 'snippet';
}

interface SourceBlock { text: string; chars: number; fullBody: boolean; sourceCount: number }

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
// thin and extraction succeeds, teaser otherwise. Reports whether any extraction
// contributed and the final char count so the caller can classify fullness.
async function buildSourceBlock(sources: SourceRef[], jinaKey: string | undefined): Promise<SourceBlock> {
  const picked = sources.filter((s) => s && (s.teaser || s.url)).slice(0, MAX_EXTRACT_SOURCES);
  if (picked.length === 0) return { text: '', chars: 0, fullBody: false, sourceCount: 0 };

  // Whether a real article body — not just a teaser — reached Gemini. True when
  // Jina extracts one, OR when a full-text feed already shipped one (its teaser
  // is itself a full body). Either way the article can be classified `full`.
  let fullBody = false;
  const parts = await Promise.all(picked.map(async (s, n) => {
    let body = (s.teaser || '').trim();
    if (s.url && body.length < EXTRACT_TEASER_THRESHOLD) {
      const full = await extractFullText(s.url, jinaKey);
      if (full && full.length > body.length) {
        body = full;
        fullBody = true;               // Jina supplied the body
      }
    } else if (body.length >= FULL_SOURCE_CHARS) {
      fullBody = true;                 // full-text feed shipped a real body — no Jina needed
    }
    body = body.slice(0, PER_SOURCE_CHAR_CAP);
    return `${n + 1}. ${s.title || ''} — ${body}`.trim();
  }));

  let block = parts.join('\n\n');
  if (block.length > TOTAL_SOURCE_CHAR_CAP) block = block.slice(0, TOTAL_SOURCE_CHAR_CAP);
  block = block.trim();
  return { text: block, chars: block.length, fullBody, sourceCount: picked.length };
}

// Article LENGTH is driven by source fullness (full text supports a longer
// article; a thin snippet should stay short to avoid padding), and is
// user-configurable. JLPT level drives COMPLEXITY (grammar/vocab difficulty), not
// length. These are the fallbacks when the user hasn't overridden them in Settings.
const DEFAULT_TARGET_PARAGRAPHS: Record<SourceKind, number> = {
  full: 5,
  partial: 4,
  snippet: 3,
};

// Unique-token budget per paragraph (~200 tokens over a 3-paragraph article was
// the original fixed basis). The vocab palette scales with paragraph count so a
// longer full-text article gets proportionally more review/new words — keeping
// the known/review/new density constant instead of diluting it across more text.
const WORDS_PER_PARAGRAPH = 67;
// Backbone (KNOWN) pool size per paragraph — a draw-from pool, not a quota — so a
// longer article has a richer known palette to build its spine from.
const KNOWN_WORDS_PER_PARAGRAPH = 10;

// #51: how many review slots to reserve for a topic-INDEPENDENT floor of the user's
// most-stuck words, blended in regardless of whether they match the article's topic.
// Clamped to the article's review budget so short articles don't get swamped.
const STUCK_REVIEW_FLOOR = 2;

// reading_intensity preset -> target distribution of known/review/new vocab.
// See database/10_reading_intensity.sql for the column definition.
const INTENSITY_RATIOS: Record<string, { known: number; review: number; new: number }> = {
  leisure:   { known: 0.980, review: 0.015, new: 0.005 },
  balanced:  { known: 0.950, review: 0.040, new: 0.010 },
  intensive: { known: 0.900, review: 0.080, new: 0.020 },
};

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
    let sourceChars = sourceText.length;
    let fullBody = false;
    if (Array.isArray(sources) && sources.length > 0) {
      try {
        const built = await buildSourceBlock(sources as SourceRef[], jinaKey);
        if (built.text) {
          sourceText = built.text;
          sourceChars = built.chars;
          fullBody = built.fullBody;
          console.log(`[process-article] built source block from ${sources.length} source(s), ${built.chars} chars`);
        }
      } catch (e) {
        console.warn('[process-article] source extraction failed, using teaser:', e instanceof Error ? e.message : e);
      }
    }
    const sourceKind = classifySourceFullness(sourceChars, fullBody);
    console.log(`[process-article] source fullness: ${sourceKind} (${sourceChars} chars, fullBody=${fullBody})`);

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

    // Length follows source fullness (user-configurable), not JLPT level.
    const paragraphPref: Record<SourceKind, number> = {
      full: prefs?.target_paragraphs_full ?? DEFAULT_TARGET_PARAGRAPHS.full,
      partial: prefs?.target_paragraphs_partial ?? DEFAULT_TARGET_PARAGRAPHS.partial,
      snippet: prefs?.target_paragraphs_snippet ?? DEFAULT_TARGET_PARAGRAPHS.snippet,
    };
    const targetParagraphs = Math.max(1, Math.round(paragraphPref[sourceKind]));

    // Scale the vocab budget with length so review/new density stays constant.
    const wordsBudget = WORDS_PER_PARAGRAPH * targetParagraphs;
    const targetReview = Math.max(1, Math.round(ratios.review * wordsBudget));
    const targetNew = Math.max(1, Math.round(ratios.new * wordsBudget));
    console.log(`[process-article] length: ${targetParagraphs} paragraphs (sourceKind=${sourceKind}), vocab budget ${wordsBudget} -> ${targetReview} review / ${targetNew} new`);

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
        // Fetch the richer per-user signals (numeric difficulty + times_seen), not just
        // the coarse mastery_level bucket, so the metric can rank by real familiarity (#25).
        type Progress = { mastery: WordSignal['mastery']; difficulty: number | null; timesSeen: number | null };
        let progressMap = new Map<string, Progress>();
        if (entryIds.length > 0) {
          const { data: progress } = await supabase
            .from('user_word_progress')
            .select('word_id, mastery_level, difficulty, times_seen')
            .eq('user_id', userId)
            .in('word_id', entryIds);
          progressMap = new Map((progress ?? []).map((p: any) => [p.word_id, {
            mastery: p.mastery_level,
            difficulty: p.difficulty ?? null,
            timesSeen: p.times_seen ?? null,
          }]));
        }

        // Map DB rows onto the shared Word Priority Metric (../_shared/wordPriority.ts),
        // the single source of "which word matters" across the palette, intake (#68),
        // and the deck (#70). It owns the known/review/new bucketing and the per-bucket
        // ordering: the KNOWN backbone by confirmed-familiarity then frequency (#25), and
        // REVIEW/NEW by JLPT proximity to the reader then frequency (#22).
        const display = new Map<string, string>();
        const buckets: Record<'known' | 'review' | 'new', WordSignal[]> = { known: [], review: [], new: [] };
        for (const c of (candidates ?? []) as any[]) {
          const text = c.kanji || c.kana;
          if (!text) continue;
          display.set(c.entry_id, text);
          const prog = progressMap.get(c.entry_id);
          const signal: WordSignal = {
            entryId: c.entry_id,
            jlptLevel: c.jlpt_level ?? null,
            freqRank: c.freq_rank ?? null,
            isCommon: !!c.is_common,
            mastery: prog?.mastery,
            difficulty: prog?.difficulty ?? null,
            timesSeen: prog?.timesSeen ?? null,
          };
          const bucket = classifyBucket(signal, jlptLevel);
          if (bucket) buckets[bucket].push(signal);
        }
        const byProximity = compareByProximity(jlptLevel);
        buckets.known.sort(compareKnown);
        buckets.review.sort(byProximity);
        buckets.new.sort(byProximity);
        knownPalette = buckets.known.map((s) => display.get(s.entryId)!);
        reviewPalette = buckets.review.map((s) => display.get(s.entryId)!);
        newPalette = buckets.new.map((s) => display.get(s.entryId)!);
        // De-dupe while preserving order
        knownPalette = Array.from(new Set(knownPalette)).slice(0, KNOWN_WORDS_PER_PARAGRAPH * targetParagraphs);
        reviewPalette = Array.from(new Set(reviewPalette)).slice(0, Math.max(5, targetReview + 2));
        newPalette = Array.from(new Set(newPalette)).slice(0, Math.max(3, targetNew + 2));
      }
      console.log(`[process-article] Palette: ${knownPalette.length} known, ${reviewPalette.length} review, ${newPalette.length} new (intensity=${readingIntensity})`);
    } catch (palErr) {
      console.error('[process-article] Palette pipeline error (continuing without palette):', palErr);
    }

    // #51: topic-INDEPENDENT review floor. The palette above only re-injects a review
    // word when the article's topic happens to match it, so words tied to a one-off
    // story orphan (seen once, topic never recurs) and never drift easier. Reserve a
    // couple of review slots for the user's most-stuck hard/medium words and blend them
    // in regardless of topic. Needs no SRS engine — it routes the existing review pool
    // by a staleness heuristic (compareStuck); #72 upgrades that ordering to real due_at.
    const stuckFloor = Math.min(STUCK_REVIEW_FLOOR, Math.max(1, targetReview));
    try {
      const { data: stuckRows } = await supabase
        .from('user_word_progress')
        .select('word_id, mastery_level, difficulty, times_seen, last_seen_at')
        .eq('user_id', userId)
        .in('mastery_level', ['hard', 'medium'])
        .limit(200);
      const stuckSignals: WordSignal[] = (stuckRows as any[] ?? []).map((r) => ({
        entryId: r.word_id,
        jlptLevel: null,
        freqRank: null,
        isCommon: false,
        mastery: r.mastery_level,
        difficulty: r.difficulty ?? null,
        timesSeen: r.times_seen ?? null,
        lastSeenAt: r.last_seen_at ?? null,
      }));
      stuckSignals.sort(compareStuck);
      const stuckIds = stuckSignals.slice(0, stuckFloor).map((s) => s.entryId);
      if (stuckIds.length > 0) {
        // Resolve surface forms (kanji preferred, kana fallback), preserving stuck order.
        const [{ data: kanjiRows }, { data: kanaRows }] = await Promise.all([
          supabase.from('jmdict_kanji').select('entry_id, text, common').in('entry_id', stuckIds).order('common', { ascending: false }),
          supabase.from('jmdict_kana').select('entry_id, text, common').in('entry_id', stuckIds).order('common', { ascending: false }),
        ]);
        const firstByEntry = (rows: any[] | null) => {
          const m = new Map<string, string>();
          for (const r of rows ?? []) if (!m.has(r.entry_id)) m.set(r.entry_id, r.text);
          return m;
        };
        const kanjiMap = firstByEntry(kanjiRows);
        const kanaMap = firstByEntry(kanaRows);
        const stuckReview = stuckIds
          .map((id) => kanjiMap.get(id) ?? kanaMap.get(id))
          .filter((t): t is string => !!t);
        // Floor first (guaranteed to survive the slice), then topic-relevant review; dedupe.
        reviewPalette = Array.from(new Set([...stuckReview, ...reviewPalette])).slice(0, Math.max(5, targetReview + 2));
        console.log(`[process-article] Review floor: blended ${stuckReview.length} stuck word(s) [${stuckReview.join(', ')}]`);
      }
    } catch (stuckErr) {
      console.error('[process-article] Review-floor blend failed (continuing):', stuckErr);
    }

    // vocab_mode "Study" prompt targets: drawn from the (now floor-blended) review palette.
    vocabTargets = reviewPalette.slice(0, 5);

    // 3. Build Gemini prompts (same logic as client-side rewriteArticleWithGemini)
    const jlptStr = `N${jlptLevel}`;

    // JLPT level controls COMPLEXITY only (grammar/vocab difficulty). Article
    // LENGTH comes from targetParagraphs (source fullness, user-configurable) above.
    const JLPT_LEVEL_CONFIG: Record<number, { description: string }> = {
      5: {
        description: 'N5: The reader understands some basic Japanese. Write simple sentences using hiragana, katakana, and basic kanji. Basic vocabulary and elementary grammar only.',
      },
      4: {
        description: 'N4: The reader understands basic Japanese. Write about familiar daily topics using basic vocabulary and kanji. Simple compound sentences are acceptable.',
      },
      3: {
        description: 'N3: The reader understands everyday Japanese. Write like a real newspaper article — use compound sentences, natural news phrasing, and intermediate grammar. The reader can handle newspaper headlines and slightly difficult text with context. Do NOT over-simplify to basic sentence patterns.',
      },
      2: {
        description: 'N2: The reader understands Japanese used in everyday situations and a variety of circumstances. Write like a real newspaper article or commentary — clear, natural prose on general topics at near-natural complexity.',
      },
      1: {
        description: 'N1: The reader understands Japanese used in a variety of circumstances. Write with full natural complexity — abstract reasoning, editorials, and nuanced prose are appropriate.',
      },
    };
    const levelConfig = JLPT_LEVEL_CONFIG[jlptLevel] ?? JLPT_LEVEL_CONFIG[3];

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
You are a factual Japanese news reporter writing a ${targetParagraphs}-paragraph news article for a JLPT ${jlptStr} learner.
LEVEL GUIDANCE: ${levelConfig.description}
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
      model: GEMINI_FLASH,
      contents: prompt1,
      config: { responseMimeType: 'application/json' },
    });
    const rawText1 = (result1.text ?? '').replace(/^```(json)?[\s\n]*/i, '').replace(/[\s\n]*```$/i, '').trim();
    const rawBlocks = JSON.parse(rawText1);

    // Store paragraphs as raw text ({type, text}); the client tokenizes, adds
    // furigana, and links JMDict entries with a real morphological analyzer
    // (kuromoji). Tokenization/furigana/linking used to be Gemini Pass 2 + a
    // server-side exact-surface Pass 3 — both removed: an LLM with no lexicon
    // split words at arbitrary boundaries (鎮める → 鎮 read ちん). yugen-box
    // blocks keep Gemini's keyword/reading/description (that path is reliable).
    const processedBlocks = rawBlocks;

    // 4. Save to processed_news
    const finalArticleId = articleId || `${Date.now()}-${userId.slice(0, 8)}`;
    const { error: saveError } = await supabase
      .from('processed_news')
      .upsert({
        id: finalArticleId,
        user_id: userId,
        title,
        // Producing content always lands the row in the consumable `ready` state.
        // When ensureBuffer pre-claimed a `pending` row, this upsert flips it to
        // `ready` (conflict target is the composite PK). On a fresh on-tap insert
        // it's `ready` from the start.
        status: 'ready',
        // Queryable fullness columns — let us aggregate "what % of articles got
        // full text vs a bare snippet" over time (see database/20_source_fullness.sql).
        source_kind: sourceKind,
        source_chars: sourceChars,
        content: {
          id: finalArticleId,
          title,
          originalUrl: '',
          blocks: processedBlocks,
          date: new Date().toISOString(),
          readTime: '5分で読める',
          category: 'Recent News',
          // Echoed into content so the Feed can badge full-text articles without
          // a second query (cache hydration only selects id + content).
          sourceKind,
          sourceChars,
        },
        metadata: { date: new Date().toISOString(), category: 'Recent News' },
      }, { onConflict: 'user_id,id' });

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
