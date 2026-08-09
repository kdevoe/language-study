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
// richer. We pull it from the source URL via Jina Reader for any source that
// didn't already ship a real body (full-text feeds like Ars do), and always
// fall back to the teaser when extraction fails. The extraction bar is
// FULL_SOURCE_CHARS: the old 600-char threshold skipped extraction for
// description-style teasers in the 600–1500 band (Guardian et al., capped at
// 800 by fetch-raw-news), which stranded ~65% of production articles at
// `partial` — the audit showed every partial row sat in exactly that band.
const JINA_READER_URL = 'https://r.jina.ai/';
const EXTRACT_TIMEOUT_MS = 8000;
const MAX_EXTRACT_SOURCES = 4;
// The LEAD source (index 0 — the story the article is actually about) keeps
// more of its body than corroborating sources: truncating the lead genuinely
// costs facts, while extras past ~2500 chars are mostly redundant color. The
// 7000 total ceiling is unchanged; chunking beyond it is the Magazines (#58)
// design question, not this path's.
const LEAD_SOURCE_CHAR_CAP = 4500;
const PER_SOURCE_CHAR_CAP = 2500;
const TOTAL_SOURCE_CHAR_CAP = 7000;

interface SourceRef { title?: string; url?: string; teaser?: string }

// ── Long-form import (docs/long-form-content-design.md, Phases A+B) ──────────
// A pasted text or URL becomes a WORK (long_form_works row) whose parts are
// regular processed_news rows. Phase B: the source is chunked at paragraph
// boundaries into parts of up to ~10k chars (§3); part 1 is processed eagerly
// on import, later parts JIT via { workId, partIndex } while the user reads.
// The personalization engine below is shared unchanged — long-form is a
// different input path plus a fidelity-leaning prompt variant (rewritePrompt's
// `longform`), not an engine change.
const IMPORT_MIN_CHARS = 300;     // under this it's a dictionary lookup, not an article
const IMPORT_MAX_CHARS = 40_000;  // hard cap per import (~4 parts, design §2)
const IMPORT_DAILY_CAP = 3;       // imports per user per rolling 24h (design §7)
const PARTS_DAILY_CAP = 15;       // part generations per user per rolling 24h (design §7)
// Parts target 8–10k source chars (§3) — deliberately above the news path's
// TOTAL_SOURCE_CHAR_CAP: long parts keep section breaks rare. Balanced split:
// ceil(total/10k) parts of ~equal size, so a 12k import is 2×6k, not 10k+2k.
const PART_TARGET_CHARS = 10_000;
// Long-form output length: ~1 paragraph per ~900 source chars (a full 8–10k
// part ≈ the design's "about 10 output paragraphs"), clamped so a short import
// isn't padded and a max part doesn't run away.
const LONGFORM_CHARS_PER_PARAGRAPH = 900;
const LONGFORM_MIN_PARAGRAPHS = 3;
const LONGFORM_MAX_PARAGRAPHS = 12;
const IMPORT_URL_TIMEOUT_MS = 12_000; // user is actively waiting (vs 8s opportunistic news extraction)
const PART_PENDING_FRESH_MS = 5 * 60_000; // younger pending part = a generation is in flight

/** Work title for a pasted import: caller-provided, else the first non-empty
 *  line of the text (blog posts usually open with their title). */
function deriveImportTitle(text: string, provided?: string): string {
  const fromCaller = (provided ?? '').trim();
  if (fromCaller) return fromCaller.slice(0, 120);
  const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? 'Imported text';
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
}

/** Deterministic part id: JIT re-derivation, the client, and the import path
 *  must all agree on it (the client constructs it to resume mid-work). */
const partArticleId = (workId: string, partIndex: number) => `lf-${workId}-p${partIndex}`;

/** A short line without terminal punctuation reads as a heading — a natural
 *  place to start a part when one falls near a target boundary. */
function looksLikeHeading(p: string): boolean {
  const line = p.trim();
  if (line.length === 0 || line.length > 80) return false;
  if (/^#{1,6}\s/.test(line)) return true;
  return !/[.。!?！？:：,、;]$/.test(line) && !line.includes('\n');
}

/** Last resort for a single paragraph bigger than a whole part (pasted text
 *  with its line breaks stripped): split at sentence boundaries. */
function splitAtSentences(p: string): string[] {
  const sentences = p.split(/(?<=[.!?。！？])\s+/);
  const out: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && cur.length + s.length + 1 > PART_TARGET_CHARS) { out.push(cur); cur = ''; }
    cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Split a raw source into part chunks (design §3). Deterministic string work —
 * the SAME function runs at import time (to fix part_count) and at JIT time
 * (re-chunking raw_text), so boundaries always agree. Splits only at paragraph
 * boundaries, preferring headings when one falls near a boundary; balanced so
 * every part lands near total/ceil(total/10k) chars instead of leaving a stub
 * tail part.
 */
function chunkSourceText(text: string): string[] {
  if (text.length <= PART_TARGET_CHARS) return [text];
  // Paragraph units: blank-line separated; fall back to single newlines when
  // the paste carries none (e.g. copied from a reader view).
  let paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paras.length <= 1) paras = text.split(/\n/).map((p) => p.trim()).filter(Boolean);
  paras = paras.flatMap((p) => (p.length > PART_TARGET_CHARS ? splitAtSentences(p) : [p]));

  const numParts = Math.min(Math.ceil(text.length / PART_TARGET_CHARS), paras.length);
  const target = text.length / numParts;
  const parts: string[] = [];
  let current: string[] = [];
  let len = 0;
  for (let i = 0; i < paras.length; i++) {
    current.push(paras[i]);
    len += paras[i].length;
    if (parts.length >= numParts - 1) continue; // final part takes the remainder
    const next = paras[i + 1];
    if (len >= target || (next !== undefined && len >= target * 0.8 && looksLikeHeading(next))) {
      parts.push(current.join('\n\n'));
      current = [];
      len = 0;
    }
  }
  if (current.length > 0) parts.push(current.join('\n\n'));
  return parts;
}

/** Fetch an import URL's full text via Jina Reader, keeping the page title the
 *  header carries (separate from the news path's extractFullText: longer
 *  timeout — the user is actively waiting — and the title matters here). */
async function extractImportUrl(url: string, jinaKey: string | undefined): Promise<{ text: string; title: string }> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), IMPORT_URL_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'User-Agent': 'YugenStudy/1.0', 'Accept': 'text/plain' };
    if (jinaKey) headers['Authorization'] = `Bearer ${jinaKey}`;
    const res = await fetch(JINA_READER_URL + url, { headers, signal: ctrl.signal });
    if (!res.ok) return { text: '', title: '' };
    const raw = await res.text();
    const title = raw.match(/^Title:\s*(.+)$/m)?.[1]?.trim() ?? '';
    const text = (raw.split(/Markdown Content:\s*/i).pop() || raw).trim();
    return { text, title };
  } catch {
    return { text: '', title: '' };
  } finally {
    clearTimeout(to);
  }
}

// ── Continuity across parts (design §4) ──────────────────────────────────────
// Independently-generated parts drift (a name rendered three ways, tone
// shifting). Each work carries a rolling `continuity` object; at JIT time the
// PREVIOUS part's generated Japanese is distilled into it, and the result is
// injected into this part's prompt (rewritePrompt `longform.continuity`).
interface Continuity {
  summaryJa?: string;
  properNouns?: Record<string, string>;
  styleNote?: string;
}

async function extractContinuity(
  ai: GoogleGenAI, prevPartText: string, existing: Continuity,
): Promise<Continuity | null> {
  const prompt = `You maintain continuity for a serialized Japanese adaptation of an English work. Below is the Japanese text of the part the reader just finished, plus the proper-noun map accumulated so far. Return ONLY JSON of this exact shape:
{"summary_ja":"前の部の内容の2〜3文の日本語要約","proper_nouns":{"English name":"日本語表記"},"style_note":"one short line: register/tone (e.g. です/ます調、エッセイ調)"}

Rules: summary_ja summarizes THIS part (it opens the next part's context). proper_nouns = the accumulated map below MERGED with any new people/organizations/places in this part, using exactly the renderings this part used. Keep it under 15 entries (drop the least important).

ACCUMULATED PROPER NOUNS: ${JSON.stringify(existing.properNouns ?? {})}

PREVIOUS PART (Japanese):
${prevPartText.slice(0, 8000)}`;
  try {
    const result = await ai.models.generateContent({
      model: GEMINI_FLASH,
      contents: prompt,
      config: { responseMimeType: 'application/json' },
    });
    const parsed = JSON.parse((result.text ?? '').replace(/^```(json)?[\s\n]*/i, '').replace(/[\s\n]*```$/i, '').trim());
    return {
      summaryJa: typeof parsed.summary_ja === 'string' ? parsed.summary_ja : undefined,
      properNouns: parsed.proper_nouns && typeof parsed.proper_nouns === 'object' ? parsed.proper_nouns : undefined,
      styleNote: typeof parsed.style_note === 'string' ? parsed.style_note : undefined,
    };
  } catch (e) {
    console.warn('[process-article] continuity extraction failed (continuing without):', e instanceof Error ? e.message : e);
    return null;
  }
}

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
    if (body.length >= FULL_SOURCE_CHARS) {
      fullBody = true;                 // full-text feed shipped a real body — no Jina needed
    } else if (s.url) {
      const full = await extractFullText(s.url, jinaKey);
      if (full && full.length > body.length) {
        body = full;
        // Only a substantial extraction counts as a real body; a short Jina
        // result (error page, stub) just improves the teaser a little.
        if (full.length >= FULL_SOURCE_CHARS) fullBody = true;
      }
    }
    body = body.slice(0, n === 0 ? LEAD_SOURCE_CHAR_CAP : PER_SOURCE_CHAR_CAP);
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

  // Set by the JIT-part path so the outer catch can flip its claimed `pending`
  // part row to `failed` (freeing the retry affordance) on any thrown error.
  let failClaim: (() => Promise<unknown>) | null = null;

  try {
    const body = await req.json();
    const { userId, articleId, snippet, sources } = body;
    let title: string = body.title;
    // Import mode (BYOC): a pasted text arrives as `importText` (a URL as
    // `importUrl`) and becomes a new work; part 1 processes eagerly.
    let importText: string = typeof body.importText === 'string'
      ? body.importText.replace(/\r\n?/g, '\n').trim()
      : '';
    const importUrl: string = typeof body.importUrl === 'string' ? body.importUrl.trim() : '';
    // JIT part mode (Phase B §3): { workId, partIndex } processes one later
    // part of an existing work while the user reads the previous one.
    const jitWorkId: string = typeof body.workId === 'string' ? body.workId : '';
    const jitPartIndex: number = Number.isInteger(body.partIndex) ? body.partIndex : 0;
    const isPartJit = jitWorkId.length > 0 && jitPartIndex > 0;
    const isImport = importText.length > 0 || importUrl.length > 0;
    if (!userId || (!isImport && !isPartJit && (!title || !(snippet || (Array.isArray(sources) && sources.length))))) {
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
    // Hoisted (was created at the prompt step): the JIT-part path also needs
    // Gemini for continuity extraction before the main rewrite.
    const ai = new GoogleGenAI({ apiKey: geminiKey, httpOptions: { apiVersion: 'v1beta' } });

    const jsonError = (status: number, error: string, errorKind: string) =>
      new Response(JSON.stringify({ error, errorKind }), {
        status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });

    // ── Long-form state, resolved by the import / JIT branches below ─────────
    let partIndexNum = 1;
    let partCountNum = 1;
    let importChunks: string[] | null = null;
    let continuity: Continuity | undefined;
    // The work a JIT part belongs to (raw_text stripped — never echo 40k back).
    let jitWork: { id: string; title: string; source_type: string } | null = null;

    const dayCutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
    // Parts guard (design §7): every part generation in the rolling 24h —
    // import part 1s and JIT parts alike — regardless of final status.
    const countParts24h = async (): Promise<number> => {
      const { count } = await supabase
        .from('processed_news')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .not('work_id', 'is', null)
        .gt('created_at', dayCutoff);
      return count ?? 0;
    };

    if (isImport) {
      // URL import (Phase B §2): the existing Jina path fetches the page text,
      // then everything below treats it exactly like a paste.
      if (!importText && importUrl) {
        if (!/^https?:\/\/\S+$/i.test(importUrl)) {
          return jsonError(400, 'importUrl must be an http(s) URL', 'import_invalid');
        }
        const fetched = await extractImportUrl(importUrl, jinaKey);
        importText = fetched.text.replace(/\r\n?/g, '\n').trim();
        if ((!title || !String(title).trim()) && fetched.title) title = fetched.title;
        // A page's length isn't the user's choice — truncate an over-cap page
        // at a paragraph boundary instead of rejecting it.
        if (importText.length > IMPORT_MAX_CHARS) {
          const cut = importText.lastIndexOf('\n', IMPORT_MAX_CHARS);
          importText = importText.slice(0, cut > IMPORT_MAX_CHARS / 2 ? cut : IMPORT_MAX_CHARS).trim();
        }
        if (importText.length < IMPORT_MIN_CHARS) {
          return jsonError(422, 'Could not extract a readable article from that URL', 'import_fetch_failed');
        }
      }
      // Input guards (design §2): too short is a dictionary lookup, not an
      // article; the hard cap bounds a max import at ~4 parts.
      if (importText.length < IMPORT_MIN_CHARS || importText.length > IMPORT_MAX_CHARS) {
        return jsonError(400,
          importText.length < IMPORT_MIN_CHARS
            ? `Import must be at least ${IMPORT_MIN_CHARS} characters`
            : `Import is capped at ${IMPORT_MAX_CHARS.toLocaleString()} characters`,
          'import_invalid');
      }
      // Server-side daily guards (design §7): imports counted on the works
      // table, parts on processed_news — both independent of the news buffer.
      const [{ count: imports24h }, parts24h] = await Promise.all([
        supabase
          .from('long_form_works')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', userId)
          .gt('created_at', dayCutoff),
        countParts24h(),
      ]);
      if ((imports24h ?? 0) >= IMPORT_DAILY_CAP || parts24h >= PARTS_DAILY_CAP) {
        return jsonError(429, `Daily import limit reached (${IMPORT_DAILY_CAP}/day). Try again tomorrow.`, 'import_limit');
      }
      title = deriveImportTitle(importText, title);
      importChunks = chunkSourceText(importText);
      partCountNum = importChunks.length;
    }

    if (isPartJit) {
      const { data: workRow } = await supabase
        .from('long_form_works')
        .select('id, title, source_type, raw_text, part_count, continuity')
        .eq('id', jitWorkId)
        .eq('user_id', userId)
        .maybeSingle();
      if (!workRow) return jsonError(404, 'Work not found', 'work_not_found');
      // Re-chunk raw_text — chunkSourceText is deterministic, so boundaries
      // match the ones part_count was computed from at import time.
      const chunks = chunkSourceText(workRow.raw_text ?? '');
      if (jitPartIndex < 2 || jitPartIndex > chunks.length) {
        return jsonError(400, `partIndex must be 2–${chunks.length} for this work`, 'part_out_of_range');
      }
      const partId = partArticleId(workRow.id, jitPartIndex);
      const { data: existing } = await supabase
        .from('processed_news')
        .select('status, content, created_at')
        .eq('user_id', userId)
        .eq('id', partId)
        .maybeSingle();
      // Idempotent: an already-generated part returns instantly (the JIT
      // trigger and an explicit 続きを読む tap can race harmlessly).
      if (existing?.status === 'ready' && existing.content) {
        const content = existing.content as { blocks: unknown };
        return new Response(JSON.stringify({ success: true, articleId: partId, blocks: content.blocks, article: content, cached: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      // A fresh pending row means another invocation is mid-generation; a stale
      // one (producer died) falls through and regenerates.
      if (existing?.status === 'pending'
        && Date.now() - new Date(existing.created_at).getTime() < PART_PENDING_FRESH_MS) {
        return jsonError(409, 'This part is already being prepared', 'part_in_progress');
      }
      if (await countParts24h() >= PARTS_DAILY_CAP) {
        return jsonError(429, `Daily part limit reached (${PARTS_DAILY_CAP}/day). Try again tomorrow.`, 'import_limit');
      }
      // Claim the slot (mirrors the news buffer's pending model) so the Library
      // shows 準備中 and duplicate triggers back off via the check above.
      await supabase.from('processed_news').upsert({
        id: partId,
        user_id: userId,
        title: workRow.title,
        status: 'pending',
        source_type: workRow.source_type,
        work_id: workRow.id,
        part_index: jitPartIndex,
      }, { onConflict: 'user_id,id' });
      failClaim = () => supabase.from('processed_news')
        .update({ status: 'failed' }).eq('user_id', userId).eq('id', partId);

      jitWork = { id: workRow.id, title: workRow.title, source_type: workRow.source_type };
      title = workRow.title;
      partIndexNum = jitPartIndex;
      partCountNum = chunks.length;
      importChunks = chunks;

      // Continuity (§4): distill the PREVIOUS part's generated Japanese into
      // the rolling continuity object (stored camelCase on the work row), and
      // inject it into this part's prompt. Failure degrades to the stored one.
      const stored: Continuity = (workRow.continuity ?? {}) as Continuity;
      const { data: prevRow } = await supabase
        .from('processed_news')
        .select('content')
        .eq('user_id', userId)
        .eq('id', partArticleId(workRow.id, jitPartIndex - 1))
        .maybeSingle();
      const prevText = (((prevRow?.content as { blocks?: { type: string; text?: string }[] })?.blocks) ?? [])
        .filter((b) => b.type === 'paragraph' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
      continuity = (prevText ? await extractContinuity(ai, prevText, stored) : null) ?? stored;
    }

    const isLongform = isImport || isPartJit;

    // Opportunistically upgrade thin teasers to full article text. Falls back
    // to the merged teaser block (snippet) when no sources / extraction fails.
    // Long-form mode: this part's source chunk IS the source — a real full body.
    let sourceText = isLongform ? importChunks![partIndexNum - 1] : (snippet ?? '');
    let sourceChars = sourceText.length;
    let fullBody = isLongform;
    if (!isLongform && Array.isArray(sources) && sources.length > 0) {
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
    // Long-form parts scale output with the chunk (§3's "about 10 paragraphs"
    // for a full 8–10k part) instead of the news-length preference — the whole
    // point of the fidelity variant is that a part reads long.
    const targetParagraphs = isLongform
      ? Math.max(LONGFORM_MIN_PARAGRAPHS, Math.min(LONGFORM_MAX_PARAGRAPHS, Math.round(sourceChars / LONGFORM_CHARS_PER_PARAGRAPH)))
      : Math.max(1, Math.round(paragraphPref[sourceKind]));

    // Scale the vocab budget with length so review/new density stays constant.
    const wordsBudget = WORDS_PER_PARAGRAPH * targetParagraphs;
    const targetReview = Math.max(1, Math.round(ratios.review * wordsBudget));
    const targetNew = Math.max(1, Math.round(ratios.new * wordsBudget));
    console.log(`[process-article] length: ${targetParagraphs} paragraphs (sourceKind=${sourceKind}), vocab budget ${wordsBudget} -> ${targetReview} review / ${targetNew} new`);

    // Kick off concept extraction (Groq) in parallel with the lexicon build —
    // neither depends on the other, and #103's concept↔SRS matching needs the
    // concepts on EVERY article (lexicon path included), not just the cluster
    // fallback. Never rejects: failure degrades to concept-less behavior
    // (topic-independent floor, no clusters).
    const conceptsPromise: Promise<{ topics: Concept[]; actions: Concept[] } | null> =
      extractConceptsWithGroq(title, sourceText.slice(0, 2000), groqKey)
        .catch((e) => {
          console.warn('[process-article] concept extraction failed (continuing without):', e instanceof Error ? e.message : e);
          return null;
        });

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

    // 2b. Story concepts — topics + actions with sense-appropriate synonyms.
    const conceptsResult = await conceptsPromise;
    const concepts: Concept[] = conceptsResult ? [...conceptsResult.topics, ...conceptsResult.actions] : [];

    // #51: how many review slots the topic floor may spend (computed here because
    // the #103 matching phase below sizes its candidate window from it).
    const stuckFloor = Math.min(STUCK_REVIEW_FLOOR, Math.max(1, targetReview));

    // 2c. Concept↔SRS strong matching (#103): before asking JMDict globally, ask
    // "does the reader have a STUDIED word that means this concept?" — a reverse
    // user_word_progress ⋈ jmdict_senses join, matching each concept's synonym-
    // expanded set against the studied words' English glosses. This bypasses the
    // JLPT-tag gate (the reader's SRS outranks JLPT tagging as the authority on
    // "known"), lets actively-studied hard/medium words enter clusters where a
    // concept actually calls for them, and upgrades the stuck floor from
    // topic-independent to concept-aligned when possible. A due word met in a
    // RELEVANT sentence is the best reinforcement the app can offer — and
    // reading it advances FSRS (#72), so it may never need a flashcard.
    //
    // Pool A (floor + clusters): struggling hard/medium actives.
    // Pool B (clusters only): any-mastery words due within a week — reinforced
    //   in relevant context without spending a floor slot reserved for stuck
    //   words. The gloss match runs client-side over the ≤~45 words currently
    //   in their pre-due window — no RPC or migration needed.
    let stuckSignals: WordSignal[] = [];
    let inWindowStuck: WordSignal[] = [];
    const surfaceById = new Map<string, string>();
    const conceptMatchIds = new Map<string, string[]>(); // concept -> entry ids, urgency-ordered
    const matchedIds = new Set<string>();
    try {
      const PROGRESS_COLS = 'word_id, mastery_level, difficulty, times_seen, last_seen_at, due_at, stability, interval_days';
      // Intake gate (#68): never surface a still-queued word as a review target.
      // `is null` keeps pre-migration rows eligible.
      const intakeGate = 'intake_status.is.null,intake_status.eq.active';
      type ProgressRow = {
        word_id: string; mastery_level: string; difficulty: number | null; times_seen: number | null;
        last_seen_at: string | null; due_at: string | null; stability: number | null; interval_days: number | null;
      };
      const weekOut = new Date(Date.now() + 7 * 86_400_000).toISOString();
      const [{ data: stuckRows }, { data: dueRows }] = await Promise.all([
        supabase.from('user_word_progress').select(PROGRESS_COLS)
          .eq('user_id', userId).in('mastery_level', ['hard', 'medium']).or(intakeGate).limit(200),
        supabase.from('user_word_progress').select(PROGRESS_COLS)
          .eq('user_id', userId).not('due_at', 'is', null).lt('due_at', weekOut).or(intakeGate).limit(100),
      ]);
      const toSignal = (r: ProgressRow): WordSignal => ({
        entryId: r.word_id,
        jlptLevel: null,
        freqRank: null,
        isCommon: false,
        mastery: r.mastery_level as WordSignal['mastery'],
        difficulty: r.difficulty ?? null,
        timesSeen: r.times_seen ?? null,
        lastSeenAt: r.last_seen_at ?? null,
        // #72: real FSRS schedule so the floor can rank by true due-date.
        dueAt: r.due_at ?? null,
        stability: r.stability ?? null,
        intervalDays: r.interval_days ?? null,
      });
      stuckSignals = ((stuckRows ?? []) as ProgressRow[]).map(toSignal);
      const stuckIdSet = new Set(stuckSignals.map((s) => s.entryId));
      const dueSignals = ((dueRows ?? []) as ProgressRow[])
        .filter((r) => !stuckIdSet.has(r.word_id)).map(toSignal);

      // In-window (or overdue) words, most-urgent first. Over-pick the floor list
      // (katakana drops + alignment need options); cap the cluster pool at 30.
      inWindowStuck = selectPreDueFloor(stuckSignals, Date.now(), stuckFloor + 12);
      const inWindowAll = selectPreDueFloor([...stuckSignals, ...dueSignals], Date.now(), 30);
      const poolIds = Array.from(new Set([...inWindowAll, ...inWindowStuck].map((s) => s.entryId)));

      if (poolIds.length > 0) {
        const [{ data: senseRows }, { data: kanjiRows }, { data: kanaRows }] = await Promise.all([
          supabase.from('jmdict_senses').select('entry_id, gloss').in('entry_id', poolIds),
          supabase.from('jmdict_kanji').select('entry_id, text, common').in('entry_id', poolIds).order('common', { ascending: false }),
          supabase.from('jmdict_kana').select('entry_id, text, common').in('entry_id', poolIds).order('common', { ascending: false }),
        ]);
        // Surface forms (kanji preferred, kana fallback) for every pool word —
        // shared by the floor and the cluster injection below.
        const firstByEntry = (rows: { entry_id: string; text: string }[] | null) => {
          const m = new Map<string, string>();
          for (const r of rows ?? []) if (!m.has(r.entry_id)) m.set(r.entry_id, r.text);
          return m;
        };
        const kanjiMap = firstByEntry(kanjiRows as { entry_id: string; text: string }[]);
        const kanaMap = firstByEntry(kanaRows as { entry_id: string; text: string }[]);
        for (const id of poolIds) {
          const s = kanjiMap.get(id) ?? kanaMap.get(id);
          if (s) surfaceById.set(id, s);
        }

        if (concepts.length > 0) {
          const glossById = new Map<string, string>();
          for (const r of (senseRows ?? []) as { entry_id: string; gloss: string[] }[]) {
            const prev = glossById.get(r.entry_id) ?? '';
            glossById.set(r.entry_id, (prev + ' ; ' + (r.gloss ?? []).join(' ; ')).toLowerCase());
          }
          // Substring match, same heuristic the cluster RPC uses (%kw%). 見張り
          // glosses "watch / lookout" and only reaches «surveillance» through its
          // synonyms — the synonym net widens the bridge, this match crosses it.
          const inWindowOrder = inWindowAll.map((s) => s.entryId);
          for (const c of concepts) {
            const keys = [c.concept, ...c.synonyms];
            const hits = inWindowOrder.filter((id) => {
              const g = glossById.get(id);
              return !!g && keys.some((k) => g.includes(k));
            });
            if (hits.length > 0) {
              conceptMatchIds.set(c.concept, hits);
              hits.forEach((id) => matchedIds.add(id));
            }
          }
          if (matchedIds.size > 0) {
            const detail = [...conceptMatchIds.entries()]
              .map(([c, ids]) => `${c}: ${ids.map((i) => surfaceById.get(i) ?? i).join('/')}`).join(', ');
            console.log(`[process-article] #103 concept↔SRS: ${matchedIds.size} studied word(s) matched [${detail}]`);
          }
        }
      }
    } catch (matchErr) {
      console.error('[process-article] concept↔SRS matching failed (continuing):', matchErr);
    }

    // 2d. Concept-cluster pipeline — FALLBACK when the lexicon can't be built.
    //    a) For each concept, gloss-match its English synonyms in JMDict, ONE RPC per
    //       concept (parallel) so each synonym cluster stays grouped, not flattened
    //    b) Within a cluster keep only words the reader can USE (the reader's own
    //       studied concept-matches first (#103), then known backbone, then
    //       at/below-level "new"), easiest first — so the model can say a hard idea
    //       with a word the reader already knows.
    // knownPalette/newPalette stay empty: the flat palette is superseded by clusters, but
    // the fields remain for the shared prompt builder's legacy (eval-harness) back-compat.
    const knownPalette: string[] = [];
    let reviewPalette: string[] = [];
    const newPalette: string[] = [];
    let vocabTargets: string[] = []; // legacy: kept for vocab_mode prompt back-compat
    const clusters: { concept: string; words: string[] }[] = [];
    if (!lexicon) try {
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
        // (compareByProximity). Hard/medium words from the GLOBAL candidate pool are
        // excluded — a struggling word is not the "easy way to say it" — but the
        // reader's own concept-matched studied words (#103, in their pre-due window)
        // are injected ahead of both buckets below: meeting them where a concept
        // calls for them is reinforcement, not difficulty.
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
          // #103: the reader's own studied words that mean this concept lead the
          // cluster — regardless of JLPT tagging (SRS presence IS eligibility;
          // the tag-gated RPC above can't see untagged words). They arrive
          // urgency-ordered (due/pre-due first); cap so the cluster still offers
          // known-backbone alternatives.
          const studied = (conceptMatchIds.get(concept) ?? [])
            .map((id) => surfaceById.get(id))
            .filter((t): t is string => !!t && !KATAKANA_ONLY_RE.test(t))
            .slice(0, 2);
          const words: string[] = [];
          for (const text of studied) {
            if (usedSurfaces.has(text) || words.includes(text)) continue;
            words.push(text);
          }
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

    // #51 review floor, upgraded by #103 from topic-INDEPENDENT to concept-ALIGNED
    // when possible. The floor still reserves a couple of review slots for the
    // user's most-stuck hard/medium words routed by the PRE-DUE window
    // (selectPreDueFloor — proportional to interval, most-urgent first, not-yet-
    // in-window words skipped), but concept-matching in-window words now take the
    // slots first: a stuck word met where a concept actually calls for it beats
    // the same word wedged into an off-topic article. Falls back to the plain
    // topic-independent pick when nothing matches. Pool + surfaces + matches were
    // computed in 2c; each group below stays urgency-ordered.
    // Over-pick so katakana loanwords can be dropped after surface resolution
    // without costing floor slots — reading a loanword is free (it's English in
    // katakana), so it shouldn't consume one of the few review slots.
    {
      const aligned = inWindowStuck.filter((s) => matchedIds.has(s.entryId));
      const rest = inWindowStuck.filter((s) => !matchedIds.has(s.entryId));
      const stuckReview = [...aligned, ...rest]
        .map((s) => surfaceById.get(s.entryId))
        .filter((t): t is string => !!t)
        .filter((t) => !KATAKANA_ONLY_RE.test(t))
        .slice(0, stuckFloor);
      if (stuckReview.length > 0) {
        // Floor first (guaranteed to survive the slice), then topic-relevant review; dedupe.
        reviewPalette = Array.from(new Set([...stuckReview, ...reviewPalette])).slice(0, Math.max(5, targetReview + 2));
        console.log(`[process-article] Review floor: blended ${stuckReview.length} stuck word(s), ${aligned.length} concept-aligned [${stuckReview.join(', ')}]`);
      }
    }

    // vocab_mode "Study" prompt targets: drawn from the (now floor-blended) review palette.
    vocabTargets = reviewPalette.slice(0, 5);

    // 3. Build the Pass-1 rewrite prompt via the shared builder
    //    (../_shared/rewritePrompt.ts) so the offline eval harness
    //    (scripts/eval-article-rewrite.mjs) tests the exact prompt we ship (#65).
    // (Gemini client `ai` was created above, before the JIT continuity step.)

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
      // Long-form (§3–4): fidelity-leaning adapt-don't-summarize variant, with
      // continuity injected for parts after the first.
      longform: isLongform
        ? { partIndex: partIndexNum, partCount: partCountNum, continuity }
        : undefined,
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

    // 4. Save. Import mode first creates the work row (generation succeeded, so
    // no orphan works from failed imports), then saves part 1 as a regular
    // processed_news row grouped under it — a part IS an article (design §1).
    // JIT mode already claimed its part row; the upsert below flips it ready.
    let work: { id: string } | null = null;
    let finalArticleId = articleId || `${Date.now()}-${userId.slice(0, 8)}`;
    if (isImport) {
      const { data: workRow, error: workErr } = await supabase
        .from('long_form_works')
        .insert({
          user_id: userId,
          title,
          source_type: 'import',
          origin_url: importUrl || null,
          // The FULL unchunked original — JIT part processing re-chunks it.
          raw_text: importText,
          char_count: importText.length,
          part_count: partCountNum,
        })
        // No raw_text in the echo: don't send up to 40k chars back down.
        .select('id, user_id, title, source_type, origin_url, char_count, part_count, status, created_at')
        .single();
      if (workErr || !workRow) {
        console.error('[process-article] Work insert error:', workErr);
        return new Response(JSON.stringify({ error: workErr?.message ?? 'work insert failed' }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      work = workRow;
      finalArticleId = partArticleId(workRow.id, 1);
    }
    if (isPartJit && jitWork) finalArticleId = partArticleId(jitWork.id, partIndexNum);

    const workRef = work ?? jitWork;
    const category = isLongform
      ? (jitWork?.source_type === 'magazine' ? '雑誌' : 'インポート')
      : 'Recent News';
    const content = {
      id: finalArticleId,
      title,
      originalUrl: '',
      blocks: processedBlocks,
      date: new Date().toISOString(),
      readTime: isLongform ? `${Math.max(2, targetParagraphs)}分で読める` : '5分で読める',
      category,
      // Echoed into content so the Feed can badge full-text articles without
      // a second query (cache hydration only selects id + content).
      sourceKind,
      sourceChars,
      // Work grouping, echoed for the Reader/Library (part chrome, resume).
      ...(workRef ? { workId: workRef.id, partIndex: partIndexNum, partCount: partCountNum } : {}),
    };

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
        ...(workRef ? { source_type: jitWork?.source_type ?? 'import', work_id: workRef.id, part_index: partIndexNum } : {}),
        content,
        metadata: {
          date: new Date().toISOString(),
          category,
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
      // Don't strand a partless work: the Library would show it stuck "preparing"
      // forever. Removing it lets the user simply re-import.
      if (work) await supabase.from('long_form_works').delete().eq('id', work.id);
      // A JIT part's pending claim flips to failed so the retry affordance works.
      if (failClaim) await failClaim().catch(() => {});
      return new Response(JSON.stringify({ error: saveError.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Persist the continuity this part was generated FROM (camelCase, matching
    // the Continuity interface) so the next part's JIT merges onto it.
    if (isPartJit && jitWork && continuity && Object.keys(continuity).length > 0) {
      await supabase
        .from('long_form_works')
        .update({ continuity })
        .eq('id', jitWork.id)
        .eq('user_id', userId);
    }

    console.log(`[process-article] ✅ Saved ${isLongform ? `work part ${partIndexNum}/${partCountNum}` : 'article'} ${finalArticleId}`);
    return new Response(JSON.stringify({
      success: true,
      articleId: finalArticleId,
      blocks: processedBlocks,
      ...(workRef ? { work: workRef, article: content } : {}),
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    // Distinguish a genuinely-busy upstream (LLM overloaded/rate-limited even
    // after retries) from a real server bug, so the client can show accurate
    // copy instead of always blaming a busy server. `errorKind: 'llm_busy'` +
    // HTTP 503 → "try again in a moment"; anything else → generic failure.
    const busy = isTransientLlmError(err);
    console.error(`[process-article] Error (busy=${busy}):`, err);
    // A JIT part that died mid-generation must not strand its pending claim —
    // failed frees the slot for the reader's retry affordance.
    if (failClaim) await failClaim().catch(() => {});
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
