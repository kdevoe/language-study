import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { GoogleGenAI } from 'https://esm.sh/@google/genai';
import { GEMINI_FLASH, GROQ_GENERAL as GROQ_MODEL } from '../_shared/models.ts';
import { classifyBucket, compareByProximity, compareKnown, selectPreDueFloor, type WordSignal } from '../_shared/wordPriority.ts';
import { buildRewritePrompt } from '../_shared/rewritePrompt.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// ── Transient LLM failure retry ──────────────────────────────────────────────
// Gemini flash intermittently returns 429 (rate limit) / 503 (model overloaded)
// and, less often, a truncated/empty body that fails JSON.parse. A single blip
// used to brick the whole article — the user just saw "the server may be busy."
// Retry the rewrite (generate + parse together, since a bad parse means we need
// a fresh generation) with exponential backoff before giving up.
const REWRITE_MAX_ATTEMPTS = 3;
const REWRITE_BACKOFF_MS = [500, 1000, 2000];

/** A generation that parsed as JSON but doesn't have the shape the client can
 *  render. Retried like truncated JSON — a fresh generation usually fixes it. */
class BlockValidationError extends Error {}

// Structural validation of a parsed generation, mirroring the eval harness's
// parseBlocks (scripts/eval-article-rewrite.mjs) — production used to persist
// blocks unvalidated, so one malformed generation wrote a broken article to
// processed_news that crashed the client tokenizer, and the JIT buffer served it.
// Contract (what Reader.tsx renders): a non-empty array with at least one
// paragraph; paragraphs carry non-empty string `text` (fed to kuromoji);
// yugen-box blocks carry keyword/description. Unknown block types pass —
// the client ignores them.
function validateBlocks(raw: unknown): void {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new BlockValidationError('generation is not a non-empty array of blocks');
  }
  let paragraphs = 0;
  for (const b of raw) {
    if (!b || typeof b !== 'object' || typeof (b as any).type !== 'string') {
      throw new BlockValidationError(`malformed block: ${JSON.stringify(b)?.slice(0, 120)}`);
    }
    const block = b as { type: string; text?: unknown; keyword?: unknown; description?: unknown };
    if (block.type === 'paragraph') {
      if (typeof block.text !== 'string' || block.text.trim().length === 0) {
        throw new BlockValidationError('paragraph block without non-empty string text');
      }
      paragraphs++;
    } else if (block.type === 'yugen-box') {
      if (typeof block.keyword !== 'string' && typeof block.description !== 'string') {
        throw new BlockValidationError('yugen-box block without keyword or description');
      }
    }
  }
  if (paragraphs === 0) throw new BlockValidationError('no paragraph blocks in generation');
}

/** True for the transient upstream failures worth retrying: LLM rate-limit /
 *  overload / 5xx, and malformed-JSON (empty or truncated) generations. */
function isTransientLlmError(err: unknown): boolean {
  if (err instanceof SyntaxError) return true; // truncated/empty JSON → regenerate
  if (err instanceof BlockValidationError) return true; // parsed but unrenderable → regenerate
  const status = (err as { status?: number; code?: number })?.status
    ?? (err as { code?: number })?.code;
  if (status === 429 || status === 500 || status === 503) return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /\b(429|500|503)\b|overload|unavailable|rate.?limit|resource.?exhausted|deadline|timeout/.test(msg);
}

// Token usage of the rewrite call, straight from Gemini's usageMetadata. The
// lexicon path injects up to 4000 words (~9k tokens) per article — logging the
// real numbers makes lexicon creep and cost regressions visible in production
// instead of theoretical. `attempts` counts generations actually paid for.
interface RewriteUsage {
  promptTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  attempts: number;
}

/** Run the Pass-1 rewrite (Gemini generate + JSON.parse + block validation)
 *  with backoff on transient failures. Non-transient errors throw immediately. */
async function runRewriteWithRetry(
  ai: GoogleGenAI, prompt: string,
): Promise<{ blocks: any; usage: RewriteUsage }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < REWRITE_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await ai.models.generateContent({
        model: GEMINI_FLASH,
        contents: prompt,
        config: { responseMimeType: 'application/json' },
      });
      const rawText = (result.text ?? '')
        .replace(/^```(json)?[\s\n]*/i, '')
        .replace(/[\s\n]*```$/i, '')
        .trim();
      const parsed = JSON.parse(rawText);
      validateBlocks(parsed);
      const meta = result.usageMetadata;
      return {
        blocks: parsed,
        usage: {
          promptTokens: meta?.promptTokenCount ?? null,
          outputTokens: meta?.candidatesTokenCount ?? null,
          totalTokens: meta?.totalTokenCount ?? null,
          attempts: attempt + 1,
        },
      };
    } catch (err) {
      lastErr = err;
      const transient = isTransientLlmError(err);
      console.warn(
        `[process-article] rewrite attempt ${attempt + 1}/${REWRITE_MAX_ATTEMPTS} failed (transient=${transient}):`,
        err instanceof Error ? err.message : err,
      );
      if (!transient || attempt === REWRITE_MAX_ATTEMPTS - 1) throw err;
      await new Promise((r) => setTimeout(r, REWRITE_BACKOFF_MS[attempt]));
    }
  }
  throw lastErr;
}

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

// A story concept plus sense-appropriate English synonyms. Expanding on the English
// side is a recall booster on the JMDict gloss match: 監視's gloss is "surveillance"
// but 見張り's is "watch / lookout" — same idea, no string overlap — so pulling
// {monitoring, watching, oversight} surfaces the whole synonym cluster at varying
// difficulty, from which we later pick the easiest word the reader knows.
// See docs/vocab-palette-redesign.md.
interface Concept { concept: string; synonyms: string[] }

// Max concepts per net and synonyms per concept (docs decision #1). Bounds both the
// per-concept candidate fan-out and the eventual prompt length.
const MAX_CONCEPTS_PER_NET = 8;
const MAX_SYNONYMS_PER_CONCEPT = 3;
// Words offered per concept cluster — enough to give the model an easiest-first choice
// (and rotate for variety) without bloating the prompt.
const CLUSTER_WORDS_MAX = 4;

// ── Controlled-vocabulary lexicon (docs/vocab-palette-redesign.md, phase 2) ──
// The reader's full known lexicon is injected whole so the allowed list IS the level.
// Katakana-only surfaces are excluded: loanwords read for free (they're English), the
// prompt's blanket exception covers them, and keeping them out both saves tokens and
// stops them cluttering the known-vocabulary list (user feedback).
const KATAKANA_ONLY_RE = /^[ァ-ヶヽヾー・゠]+$/;
// Prompt-size safety cap (~4k surfaces ≈ ~9k tokens) — known-first order means the
// cap drops assumed-known tail words, never confirmed-easy ones.
const LEXICON_MAX_WORDS = 4000;
// Below this the list can't carry an article — fall back to the cluster pipeline.
const LEXICON_MIN_WORDS = 300;

// Page past supabase's 1000-row response cap (unranged .select() silently truncates).
async function fetchAllRows<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  const SIZE = 1000;
  for (let from = 0; ; from += SIZE) {
    const { data, error } = await page(from, from + SIZE - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if ((data ?? []).length < SIZE) break;
  }
  return out;
}

type EmbeddedEntry = { id: string; jmdict_kanji: { text: string; common: boolean }[]; jmdict_kana: { text: string; common: boolean }[] };

// Preferred display surface for an entry: common kanji > common kana > any kanji
// > any kana. Preferring a common KANA reading over a non-common kanji form keeps
// words whose only kanji spelling is rare (その's 其の, とても's 迚も) in kana,
// instead of feeding an unnatural surface into the vocab palette.
function pickSurface(e: EmbeddedEntry): string | null {
  const commonOf = (rows: { text: string; common: boolean }[]) =>
    rows.find((r) => r.common)?.text ?? null;
  const anyOf = (rows: { text: string; common: boolean }[]) => rows[0]?.text ?? null;
  return (
    commonOf(e.jmdict_kanji ?? []) ??
    commonOf(e.jmdict_kana ?? []) ??
    anyOf(e.jmdict_kanji ?? []) ??
    anyOf(e.jmdict_kana ?? [])
  );
}

function normalizeConcepts(raw: unknown): Concept[] {
  if (!Array.isArray(raw)) return [];
  const out: Concept[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    // Tolerate both {concept, synonyms:[...]} and a bare "word" string.
    const concept = String((item && typeof item === 'object' ? (item as any).concept : item) ?? '')
      .toLowerCase().trim();
    if (concept.length < 2 || concept.length > 30 || seen.has(concept)) continue;
    seen.add(concept);
    const synRaw = (item && typeof item === 'object' ? (item as any).synonyms : []) ?? [];
    const synonyms = (Array.isArray(synRaw) ? synRaw : [])
      .map((s: unknown) => String(s).toLowerCase().trim())
      .filter((s: string) => s.length >= 2 && s.length <= 30 && s !== concept)
      .slice(0, MAX_SYNONYMS_PER_CONCEPT);
    out.push({ concept, synonyms });
    if (out.length >= MAX_CONCEPTS_PER_NET) break;
  }
  return out;
}

// Extract the article's concepts in two nets (docs/vocab-palette-redesign.md):
//   topics  — concrete nouns/entities the story is ABOUT
//   actions — verbs/adjectives/abstract ideas describing what HAPPENS (the news-register
//             vocabulary that makes articles hard and that the old noun-only extractor
//             threw away). Each concept carries sense-appropriate English synonyms.
async function extractConceptsWithGroq(
  title: string, snippet: string, apiKey: string,
): Promise<{ topics: Concept[]; actions: Concept[] }> {
  const prompt = `You are preparing vocabulary for a Japanese news rewrite. From this English news article, extract its key CONCEPTS in two groups. For each concept give up to ${MAX_SYNONYMS_PER_CONCEPT} common English synonyms, chosen for THIS article's sense (e.g. "fine" meaning a monetary penalty → "penalty, forfeit"; NOT "healthy, delicate").

- "topics": concrete nouns / entities the story is about (people, things, places, organizations).
- "actions": verbs, adjectives, and abstract ideas describing what HAPPENS (e.g. introduce, monitor, identify, warn, spread, illegal, damage). Prefer these over filler like "said" or "people".

Give up to ${MAX_CONCEPTS_PER_NET} concepts per group. Return ONLY JSON of this exact shape:
{"topics":[{"concept":"surveillance","synonyms":["monitoring","watching","oversight"]}],"actions":[{"concept":"identify","synonyms":["locate","pinpoint"]}]}

Title: ${title}
Snippet: ${snippet}`;

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
    throw new Error(`Groq concept extraction failed: ${err.error?.message || response.statusText}`);
  }
  const data = await response.json();
  const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '{}');
  return {
    topics: normalizeConcepts(parsed.topics),
    actions: normalizeConcepts(parsed.actions),
  };
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

    // 2a. Controlled-vocabulary lexicon — PRIMARY difficulty mechanism (phase 2).
    // Diagnosis on a real N4 article: the model already wrote 92% inside the reader's
    // ENCOUNTERED vocabulary, but 39% of content words sat in the medium/hard/unknown
    // tiers (target ~5%) — it couldn't see the mastery boundary, and clusters exposed
    // only ~40 of ~2,270 known words. Injecting the full known lexicon (confirmed-easy
    // SRS + assumed-known N5/N4, minus words the reader graded medium/hard) makes the
    // allowed list itself the level: measured 39% → ~10% struggling share net of
    // glossed topic words. See docs/vocab-palette-redesign.md (live-check + phase 2).
    let lexicon: { words: string[] } | undefined;
    try {
      const [srsRows, n54Entries] = await Promise.all([
        fetchAllRows<{ word_id: string; mastery_level: string }>((from, to) =>
          supabase.from('user_word_progress').select('word_id, mastery_level').eq('user_id', userId).range(from, to)),
        fetchAllRows<EmbeddedEntry>((from, to) =>
          supabase.from('jmdict_entries').select('id, jmdict_kanji(text, common), jmdict_kana(text, common)').gte('jlpt_level', 4).range(from, to)),
      ]);
      const struggling = new Set(srsRows.filter((r) => r.mastery_level === 'medium' || r.mastery_level === 'hard').map((r) => r.word_id));
      const easyIds = srsRows.filter((r) => r.mastery_level === 'easy').map((r) => r.word_id);
      // Surfaces for confirmed-easy words above N4 (not covered by the N5/N4 fetch).
      const n54ById = new Map(n54Entries.map((e) => [e.id, e]));
      const missingEasy = easyIds.filter((id) => !n54ById.has(id));
      const easyById = new Map<string, EmbeddedEntry>();
      for (let i = 0; i < missingEasy.length; i += 200) {
        const { data } = await supabase
          .from('jmdict_entries')
          .select('id, jmdict_kanji(text, common), jmdict_kana(text, common)')
          .in('id', missingEasy.slice(i, i + 200));
        for (const e of (data ?? []) as EmbeddedEntry[]) easyById.set(e.id, e);
      }
      // Known-first order: confirmed-easy leads, then assumed-known N5/N4 — minus words
      // the reader actually graded medium/hard (their own evidence beats the JLPT tag).
      const ordered = [
        ...easyIds.map((id) => easyById.get(id) ?? n54ById.get(id)),
        ...n54Entries.filter((e) => !struggling.has(e.id)),
      ];
      const words: string[] = [];
      const seen = new Set<string>();
      for (const e of ordered) {
        if (!e) continue;
        const s = pickSurface(e);
        if (!s || seen.has(s) || KATAKANA_ONLY_RE.test(s)) continue;
        seen.add(s);
        words.push(s);
        if (words.length >= LEXICON_MAX_WORDS) break;
      }
      if (words.length >= LEXICON_MIN_WORDS) lexicon = { words };
      console.log(`[process-article] Lexicon: ${words.length} allowed word(s)${lexicon ? '' : ` — below floor ${LEXICON_MIN_WORDS}, falling back to clusters`}`);
    } catch (lexErr) {
      console.error('[process-article] Lexicon build failed (falling back to clusters):', lexErr);
    }

    // 2b. Concept-cluster pipeline — FALLBACK when the lexicon can't be built.
    //    a) Extract the story's concepts in two nets — topics + actions (Groq)
    //    b) For each concept, gloss-match its English synonyms in JMDict, ONE RPC per
    //       concept (parallel) so each synonym cluster stays grouped, not flattened
    //    c) Within a cluster keep only words the reader can USE (known backbone or
    //       at/below-level "new"), easiest first — so the model can say a hard idea with
    //       a word the reader already knows.
    // knownPalette/newPalette stay empty: the flat palette is superseded by clusters, but
    // the fields remain for the shared prompt builder's legacy (eval-harness) back-compat.
    const knownPalette: string[] = [];
    let reviewPalette: string[] = [];
    const newPalette: string[] = [];
    let vocabTargets: string[] = []; // legacy: kept for vocab_mode prompt back-compat
    const clusters: { concept: string; words: string[] }[] = [];
    if (!lexicon) try {
      const { topics, actions } = await extractConceptsWithGroq(title, sourceText.slice(0, 2000), groqKey);
      const concepts = [...topics, ...actions];
      if (concepts.length > 0) {
        // One RPC per concept (parallel) reusing the existing candidate function unchanged
        // (no migration). Modest per-concept cap — we only surface a few words per cluster.
        const perConcept = await Promise.all(concepts.map(async (c) => {
          const patterns = [c.concept, ...c.synonyms].map((k) => `%${k}%`);
          const { data, error } = await supabase.rpc('jmdict_vocab_candidates', {
            keywords: patterns,
            user_jlpt: jlptLevel,
            max_results: 40,
          });
          if (error) {
            console.warn(`[process-article] cluster query failed for «${c.concept}»:`, error.message);
            return { concept: c.concept, candidates: [] as any[] };
          }
          return { concept: c.concept, candidates: (data ?? []) as any[] };
        }));

        // One progress lookup across ALL clusters' candidates (avoids N round-trips).
        const allEntryIds = Array.from(new Set(perConcept.flatMap((p) => p.candidates.map((c) => c.entry_id))));
        type Progress = { mastery: WordSignal['mastery']; difficulty: number | null; timesSeen: number | null };
        let progressMap = new Map<string, Progress>();
        if (allEntryIds.length > 0) {
          const { data: progress } = await supabase
            .from('user_word_progress')
            .select('word_id, mastery_level, difficulty, times_seen')
            .eq('user_id', userId)
            .in('word_id', allEntryIds);
          progressMap = new Map((progress ?? []).map((p: any) => [p.word_id, {
            mastery: p.mastery_level,
            difficulty: p.difficulty ?? null,
            timesSeen: p.times_seen ?? null,
          }]));
        }

        // Build one cluster per concept via the shared Word Priority Metric
        // (../_shared/wordPriority.ts). Keep only USABLE words: known backbone
        // (compareKnown, confirmed/assumed-known easiest first) then at/below-level "new"
        // (compareByProximity). Hard/medium (review) words are excluded — struggling words
        // are reinforced through the SRS floor below, not offered as the "easy way to say it".
        const byProximity = compareByProximity(jlptLevel);
        const usedSurfaces = new Set<string>(); // a surface leads at most one cluster
        for (const { concept, candidates } of perConcept) {
          const known: { s: WordSignal; text: string }[] = [];
          const fresh: { s: WordSignal; text: string }[] = [];
          for (const c of candidates) {
            const text = c.kanji || c.kana;
            if (!text) continue;
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
            if (bucket === 'known') known.push({ s: signal, text });
            else if (bucket === 'new') fresh.push({ s: signal, text });
          }
          known.sort((a, b) => compareKnown(a.s, b.s));
          fresh.sort((a, b) => byProximity(a.s, b.s));
          const words: string[] = [];
          for (const { text } of [...known, ...fresh]) {
            if (usedSurfaces.has(text) || words.includes(text)) continue;
            words.push(text);
            if (words.length >= CLUSTER_WORDS_MAX) break;
          }
          if (words.length > 0) {
            words.forEach((w) => usedSurfaces.add(w));
            clusters.push({ concept, words });
          }
        }
      }
      console.log(`[process-article] Clusters: ${clusters.length} concept(s) [${clusters.map((c) => c.concept).join(', ')}]`);
    } catch (palErr) {
      console.error('[process-article] Palette pipeline error (continuing without clusters):', palErr);
    }

    // #51: topic-INDEPENDENT review floor. The palette above only re-injects a review
    // word when the article's topic happens to match it, so words tied to a one-off
    // story orphan (seen once, topic never recurs) and never drift easier. Reserve a
    // couple of review slots for the user's most-stuck hard/medium words and blend them
    // in regardless of topic. Post-#67 the FSRS engine gives every active word a real
    // `due_at` + `interval_days`, so these slots route by the PRE-DUE window
    // (selectPreDueFloor): words entering their proportional window before due surface
    // first (most urgent first), giving reading a chance to reinforce them before they
    // reach the flashcard deck. Words not yet in-window are skipped.
    const stuckFloor = Math.min(STUCK_REVIEW_FLOOR, Math.max(1, targetReview));
    try {
      const { data: stuckRows } = await supabase
        .from('user_word_progress')
        .select('word_id, mastery_level, difficulty, times_seen, last_seen_at, due_at, stability, interval_days')
        .eq('user_id', userId)
        .in('mastery_level', ['hard', 'medium'])
        // Intake gate (#68): never surface a word that's still queued (waiting for daily
        // promotion) as a review target. `is null` keeps pre-migration rows eligible, so
        // this is safe to deploy before database/24 is applied by hand.
        .or('intake_status.is.null,intake_status.eq.active')
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
        // #72: real FSRS schedule so the review floor can rank by true due-date.
        dueAt: r.due_at ?? null,
        stability: r.stability ?? null,
        intervalDays: r.interval_days ?? null,
      }));
      // Pre-due surfacing window: reinforce words approaching due (proportional to their
      // interval) so reading can push them out before they hit the flashcard deck. Only
      // in-window / overdue words qualify, most-urgent first — spending the reader's few
      // review slots on cards actually at risk, not ones due months out.
      // Over-pick so katakana loanwords can be dropped after surface resolution without
      // costing floor slots — reading a loanword is free (it's English in katakana), so
      // it shouldn't consume one of the few review slots (user feedback).
      const stuckIds = selectPreDueFloor(stuckSignals, Date.now(), stuckFloor + 4).map((s) => s.entryId);
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
          .filter((t): t is string => !!t)
          .filter((t) => !KATAKANA_ONLY_RE.test(t))
          .slice(0, stuckFloor);
        // Floor first (guaranteed to survive the slice), then topic-relevant review; dedupe.
        reviewPalette = Array.from(new Set([...stuckReview, ...reviewPalette])).slice(0, Math.max(5, targetReview + 2));
        console.log(`[process-article] Review floor: blended ${stuckReview.length} stuck word(s) [${stuckReview.join(', ')}]`);
      }
    } catch (stuckErr) {
      console.error('[process-article] Review-floor blend failed (continuing):', stuckErr);
    }

    // vocab_mode "Study" prompt targets: drawn from the (now floor-blended) review palette.
    vocabTargets = reviewPalette.slice(0, 5);

    // 3. Build the Pass-1 rewrite prompt via the shared builder
    //    (../_shared/rewritePrompt.ts) so the offline eval harness
    //    (scripts/eval-article-rewrite.mjs) tests the exact prompt we ship (#65).
    const ai = new GoogleGenAI({ apiKey: geminiKey, httpOptions: { apiVersion: 'v1beta' } });

    // Pass 1: Rewrite article
    const prompt1 = buildRewritePrompt({
      title,
      sourceText,
      targetParagraphs,
      jlptLevel,
      rtkLevel,
      studyMode,
      vocabMode,
      ratios,
      targetReview,
      targetNew,
      knownPalette,
      reviewPalette,
      newPalette,
      vocabTargets,
      clusters,
      // Review words ride the lexicon block: the (katakana-filtered) pre-due floor.
      lexicon: lexicon ? { words: lexicon.words, reviewWords: reviewPalette } : undefined,
    });

    console.log(`[process-article] Pass 1 for user ${userId}`);
    // Retries transient Gemini overload/rate-limit and malformed-JSON blips with
    // backoff (see runRewriteWithRetry) so one upstream hiccup no longer surfaces
    // as "the server may be busy."
    const { blocks: rawBlocks, usage } = await runRewriteWithRetry(ai, prompt1);

    // 1.3 (path-forward): real prompt size + token counts, per article. One
    // greppable line for the function logs, and persisted into metadata below
    // so cost can be aggregated with SQL instead of log spelunking.
    console.log(
      `[process-article] usage: prompt=${usage.promptTokens} output=${usage.outputTokens} total=${usage.totalTokens} tokens, ` +
      `attempts=${usage.attempts}, promptChars=${prompt1.length}, lexiconWords=${lexicon?.words.length ?? 0}, sourceKind=${sourceKind}`,
    );

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
        metadata: {
          date: new Date().toISOString(),
          category: 'Recent News',
          // Queryable per-article cost telemetry (metadata is jsonb):
          //   select metadata->'usage' from processed_news order by created_at desc;
          usage: {
            model: GEMINI_FLASH,
            promptTokens: usage.promptTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
            attempts: usage.attempts,
            promptChars: prompt1.length,
            lexiconWords: lexicon?.words.length ?? 0,
          },
        },
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
    // Distinguish a genuinely-busy upstream (LLM overloaded/rate-limited even
    // after retries) from a real server bug, so the client can show accurate
    // copy instead of always blaming a busy server. `errorKind: 'llm_busy'` +
    // HTTP 503 → "try again in a moment"; anything else → generic failure.
    const busy = isTransientLlmError(err);
    console.error(`[process-article] Error (busy=${busy}):`, err);
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
        errorKind: busy ? 'llm_busy' : 'server_error',
      }),
      {
        status: busy ? 503 : 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }
});
