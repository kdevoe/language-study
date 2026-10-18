// Small Claude helpers shared by the memory jobs (learner-dream), the news editor
// (fetch-raw-news), the tutor (tutor-chat), and the quick lookups in
// dictionary-lookup and process-article.
import Anthropic from 'npm:@anthropic-ai/sdk@0.132.1';
import { CLAUDE_HAIKU, CLAUDE_PRICES, WEB_SEARCH_USD } from './models.ts';

export const anthropic = new Anthropic();

export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webFetches: number;
  webSearches: number;
  costUsd: number;
}

export function emptyUsage(model: string): Usage {
  return { model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webFetches: 0, webSearches: 0, costUsd: 0 };
}

/** Fold one response's usage into a running total (cost in USD). */
// deno-lint-ignore no-explicit-any
export function addUsage(total: Usage, u: any): Usage {
  const p = CLAUDE_PRICES[total.model] ?? { in: 0, out: 0 };
  const input = u?.input_tokens ?? 0;
  const output = u?.output_tokens ?? 0;
  const read = u?.cache_read_input_tokens ?? 0;
  const write = u?.cache_creation_input_tokens ?? 0;
  total.inputTokens += input;
  total.outputTokens += output;
  total.cacheReadTokens += read;
  total.cacheWriteTokens += write;
  const searches = u?.server_tool_use?.web_search_requests ?? 0;
  total.webFetches += u?.server_tool_use?.web_fetch_requests ?? 0;
  total.webSearches += searches;
  total.costUsd += (input * p.in + output * p.out + read * p.in * 0.1 + write * p.in * 1.25) / 1e6 + searches * WEB_SEARCH_USD;
  return total;
}

/** Text of a response's text blocks. */
// deno-lint-ignore no-explicit-any
export const textOf = (msg: any): string =>
  (msg?.content ?? []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('').trim();

/** First JSON object in a model reply (tolerates prose or fences around it). */
export function parseJsonObject<T>(text: string): T {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in reply');
  return JSON.parse(text.slice(start, end + 1)) as T;
}

/**
 * Structured output through a forced tool call: the model must call `name` with
 * input matching `schema`, and we return that input. Retries once on a transient
 * error (429/5xx/overloaded).
 */
export async function callTool<T>(opts: {
  model: string;
  system?: string;
  prompt: string | unknown[];   // a string, or content blocks (e.g. an image then text)
  name: string;
  description: string;
  schema: Record<string, unknown>;
  maxTokens: number;
  usage: Usage;
}): Promise<T> {
  const req = {
    model: opts.model,
    max_tokens: opts.maxTokens,
    ...(opts.system ? { system: opts.system } : {}),
    tools: [{ name: opts.name, description: opts.description, input_schema: opts.schema }],
    tool_choice: { type: 'tool' as const, name: opts.name },
    messages: [{ role: 'user' as const, content: opts.prompt }],
  };
  for (let attempt = 0; ; attempt++) {
    try {
      // deno-lint-ignore no-explicit-any
      const msg = await anthropic.messages.create(req as any);
      addUsage(opts.usage, msg.usage);
      const tool = msg.content.find((b) => b.type === 'tool_use');
      if (!tool || tool.type !== 'tool_use') throw new Error(`${opts.name}: no tool call (stop_reason ${msg.stop_reason})`);
      return tool.input as T;
    } catch (e) {
      const status = (e as { status?: number })?.status;
      const transient = status === 429 || status === 529 || (status ?? 0) >= 500;
      if (attempt >= 1 || !transient) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/** Plain text completion (the editor's writer step). */
export async function complete(opts: { model: string; prompt: string; maxTokens: number; usage: Usage }): Promise<string> {
  const msg = await anthropic.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens,
    messages: [{ role: 'user', content: opts.prompt }],
  });
  addUsage(opts.usage, msg.usage);
  return textOf(msg);
}

/**
 * One short Haiku call with thinking off, for the quick, latency-sensitive jobs
 * Groq used to do (index picks, readings, translation, small JSON). Haiku 5.5
 * thinks at medium effort by default; disabling it is allowed at effort high or
 * below. Returns the reply text; throws on a refusal or an empty reply.
 */
export async function quickHaiku(prompt: string, maxTokens = 1024): Promise<string> {
  const msg = await anthropic.messages.create({
    model: CLAUDE_HAIKU,
    max_tokens: maxTokens,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: prompt }],
  // deno-lint-ignore no-explicit-any
  } as any);
  if (msg.stop_reason === 'refusal') throw new Error('declined by model');
  const text = textOf(msg);
  if (!text) throw new Error('empty reply');
  return text;
}
