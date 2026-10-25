// Provider fallback between Gemini and Claude. Each job keeps its primary model;
// when that provider is out (credits depleted, key or billing refused, or still
// overloaded after the job's own retries) the same prompt goes to the other one.
// Gemini's prepaid credits ran out on 2026-10-24 and every article and podcast
// failed until the balance was topped up.
//
// Fallback calls run inside the same request, so they inherit the request's
// per-user caps (CLAUDE.md › Cost and abuse). Prompts are passed through as they
// are, untrusted text still fenced; outputs go through the job's usual checks.
import Anthropic from 'npm:@anthropic-ai/sdk@0.132.1';
import { CLAUDE_SONNET, GEMINI_FLASH } from './models.ts';

/** Claude model for Gemini jobs (article rewrite, podcast script) when Gemini is out. */
export const GEMINI_FALLBACK_MODEL = CLAUDE_SONNET;
/** Gemini model for Claude jobs (structured calls, quick lookups) when Claude is out. */
export const CLAUDE_FALLBACK_MODEL = GEMINI_FLASH;

/** The provider can't serve us right now: no credits, billing or key refused, or
 *  rate-limited / overloaded / down. A bad generation (unparseable, invalid) is
 *  not a reason to switch: the job regenerates those itself. */
export function providerDown(err: unknown): boolean {
  if (err instanceof SyntaxError) return false;
  const e = err as { status?: number; code?: number; name?: string };
  const status = e?.status ?? (typeof e?.code === 'number' ? e.code : undefined);
  if (status && [401, 402, 403, 429, 500, 502, 503, 504, 529].includes(status)) return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /credit|prepay|billing|quota|resource.?exhausted|insufficient|payment|api key|permission|overload|unavailable|rate.?limit|\b(401|402|403|429|5\d\d)\b/.test(msg);
}

/** Out, not busy: no credits, billing or the key refused. Retrying the same
 *  provider won't help, so switch at once. */
export function providerOut(err: unknown): boolean {
  const e = err as { status?: number; code?: number };
  const status = e?.status ?? (typeof e?.code === 'number' ? e.code : undefined);
  if (status === 401 || status === 402 || status === 403) return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /credit|prepay|billing|payment|insufficient.?(funds|balance)|api key|permission.?denied|\b40[123]\b/.test(msg);
}

// A provider found out stays skipped for a while in this instance, so each job
// doesn't pay a failed call first. Short for an overload, longer for credits.
const outUntil: Record<'gemini' | 'claude', number> = { gemini: 0, claude: 0 };
export const isOut = (p: 'gemini' | 'claude') => Date.now() < outUntil[p];
export function markOut(p: 'gemini' | 'claude', err: unknown) {
  const hard = providerOut(err);
  outUntil[p] = Date.now() + (hard ? 10 : 2) * 60_000;
  console.warn(`[llm] ${p} ${hard ? 'out' : 'down'}, falling back for ${hard ? 10 : 2} min:`, (err instanceof Error ? err.message : String(err)).slice(0, 200));
}

export interface FallbackUsage { model: string; inputTokens: number | null; outputTokens: number | null }

/**
 * A Gemini JSON job with Claude behind it. `gemini` makes the primary call; if
 * Gemini is out (or marked out), the same prompt goes to Claude. A transient
 * Gemini error is rethrown for the job's own retry loop, which calls
 * `markOut('gemini', err)` on its last attempt to get one more try on Claude.
 */
export async function geminiJsonOrClaude(
  gemini: () => Promise<{ text: string; usage: FallbackUsage }>, prompt: string, maxTokens: number,
): Promise<{ text: string; usage: FallbackUsage; fellBack: boolean }> {
  if (!isOut('gemini')) {
    try {
      return { ...(await gemini()), fellBack: false };
    } catch (err) {
      if (!providerOut(err)) throw err;
      markOut('gemini', err);
    }
  }
  const r = await claudeText(`${prompt}\n\nReply with only the JSON, no prose and no code fences.`, { maxTokens });
  return { ...r, text: jsonPart(r.text), fellBack: true };
}

/** The JSON in a reply: fences stripped, and any prose around the outermost [..] or {..} dropped. */
export function jsonPart(s: string): string {
  const t = unfence(s);
  if (/^[[{]/.test(t)) return t;
  const a = t.search(/[[{]/);
  const close = t[a] === '[' ? ']' : '}';
  const b = t.lastIndexOf(close);
  return a >= 0 && b > a ? t.slice(a, b + 1) : t;
}

let anthropicClient: Anthropic | null = null;

/** One Claude completion returning text. For Gemini-primary jobs. Called the way
 *  the rewrite eval calls Claude (scripts/eval-article-rewrite.mjs): the model's
 *  default thinking, streamed so a long answer can't trip the HTTP timeout. */
export async function claudeText(prompt: string, opts: { maxTokens: number; model?: string; system?: string }): Promise<{ text: string; usage: FallbackUsage }> {
  anthropicClient ??= new Anthropic();
  const model = opts.model ?? GEMINI_FALLBACK_MODEL;
  const msg = await anthropicClient.messages.stream({
    model,
    max_tokens: opts.maxTokens,
    ...(opts.system ? { system: opts.system } : {}),
    messages: [{ role: 'user', content: prompt }],
  }).finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error('claude fallback: declined');
  if (msg.stop_reason === 'max_tokens') throw new SyntaxError(`claude fallback cut off at max_tokens (${opts.maxTokens})`);
  const text = (msg.content ?? []).filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('').trim();
  if (!text) throw new Error('claude fallback: empty reply');
  return { text, usage: { model, inputTokens: msg.usage?.input_tokens ?? null, outputTokens: msg.usage?.output_tokens ?? null } };
}

/** One Gemini completion returning text (JSON mode when asked). For Claude-primary jobs. */
export async function geminiText(prompt: string, opts: { json?: boolean; maxTokens?: number; model?: string; system?: string } = {}): Promise<{ text: string; usage: FallbackUsage }> {
  const key = Deno.env.get('GEMINI_API_KEY');
  if (!key) throw new Error('gemini fallback: no GEMINI_API_KEY');
  const model = opts.model ?? CLAUDE_FALLBACK_MODEL;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        ...(opts.json ? { responseMimeType: 'application/json' } : {}),
        ...(opts.maxTokens ? { maxOutputTokens: opts.maxTokens } : {}),
      },
    }),
  });
  if (!res.ok) {
    const err = new Error(`gemini fallback ${res.status}: ${(await res.text()).slice(0, 300)}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const cand = data?.candidates?.[0];
  const text = ((cand?.content?.parts ?? []) as { text?: string; thought?: boolean }[])
    .filter((p) => !p.thought).map((p) => p.text ?? '').join('').trim();
  if (cand?.finishReason === 'MAX_TOKENS') throw new SyntaxError('gemini fallback cut off at max tokens');
  if (!text) throw new Error(`gemini fallback: empty reply (${cand?.finishReason ?? 'no candidate'})`);
  return {
    text,
    usage: { model, inputTokens: data?.usageMetadata?.promptTokenCount ?? null, outputTokens: data?.usageMetadata?.candidatesTokenCount ?? null },
  };
}

/** Strip code fences around a JSON reply. */
export const unfence = (s: string) => s.replace(/^```(json)?[\s\n]*/i, '').replace(/[\s\n]*```$/i, '').trim();
