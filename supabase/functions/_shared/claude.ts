// Small Claude helpers shared by the memory jobs (learner-dream), the news editor
// (fetch-raw-news), the tutor (tutor-chat), and the quick lookups in
// dictionary-lookup and process-article.
import Anthropic from 'npm:@anthropic-ai/sdk@0.132.1';
import { CLAUDE_HAIKU, CLAUDE_PRICES, CLAUDE_SONNET, WEB_SEARCH_USD } from './models.ts';
import { geminiText, isOut, jsonPart, markOut, providerDown } from './llm.ts';

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

// Models that reject a forced tool_choice ("type tool and any are not supported
// for this model": Sonnet 5.5, 2026-10-18). They get tool_choice auto plus an
// instruction to answer only through the tool, and the reply is validated.
const NO_FORCED_TOOL = new Set<string>([CLAUDE_SONNET]);

// model:tool pairs whose strict tool mode failed here (a schema it can't take,
// or no support): they fall back to plain tool use plus our own checks.
const NO_STRICT = new Set<string>();

class BadToolOutput extends Error {}

// Strict tool use constrains decoding to the schema, so a reply can't put fields
// in the wrong place (the brief nested inside editor, 2026-10-18). It needs
// additionalProperties: false on every object and takes only part of JSON
// Schema, so size limits are dropped here (callers trim lengths themselves).
const STRICT_UNSUPPORTED = ['maxItems', 'minItems', 'maxLength', 'minLength', 'minimum', 'maximum', 'pattern', 'format'];
export function toStrictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toStrictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (STRICT_UNSUPPORTED.includes(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, toStrictSchema(pv)]));
    } else if (k === 'items' || k === 'anyOf') out[k] = toStrictSchema(v);
    else out[k] = v;
  }
  if (out.type === 'object') out.additionalProperties = false;
  return out;
}

/** Required fields missing anywhere in `value`, as paths ("brief.openers"):
 *  nested objects too, since a model once tucked the brief's top-level fields
 *  inside brief.editor and passed a top-level-only check (2026-10-18). */
function missingRequired(schema: Record<string, unknown>, value: unknown, path = ''): string[] {
  if (schema.type !== 'object' || !value || typeof value !== 'object' || Array.isArray(value)) return [];
  const obj = value as Record<string, unknown>;
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const out = required.filter((k) => obj[k] === undefined || obj[k] === null).map((k) => `${path}${k}`);
  for (const [k, sub] of Object.entries(props)) {
    if (obj[k] !== undefined && obj[k] !== null) out.push(...missingRequired(sub, obj[k], `${path}${k}.`));
  }
  return out;
}

/**
 * Structured output through a tool call: the model calls `name` with input
 * matching `schema`, and we return that input. Strict tool use holds the reply
 * to the schema where the API allows it; either way the reply is checked (a tool
 * call, not cut off at max_tokens, every required field present, nested ones too) and
 * regenerated once if it fails, as on a transient error (429/5xx/overloaded).
 */
interface ToolCall {
  model: string;
  system?: string;
  prompt: string | unknown[];   // a string, or content blocks (e.g. an image then text)
  name: string;
  description: string;
  schema: Record<string, unknown>;
  maxTokens: number;
  usage: Usage;
}

/**
 * callTool with Gemini behind it: when Claude is out (credits, key, or still
 * overloaded after a retry), a text prompt goes to Gemini in JSON mode with the
 * schema spelled out, and the reply gets the same required-field check. Prompts
 * with images stay on Claude.
 */
export async function callTool<T>(opts: ToolCall): Promise<T> {
  const textOnly = typeof opts.prompt === 'string';
  if (!textOnly || !isOut('claude')) {
    try {
      return await callToolClaude<T>(opts);
    } catch (e) {
      if (!textOnly || !providerDown(e)) throw e;
      markOut('claude', e);
    }
  }
  return await callToolGemini<T>(opts);
}

async function callToolGemini<T>(opts: ToolCall): Promise<T> {
  const prompt = `${opts.prompt}

Answer with only a JSON object: the input for "${opts.name}" (${opts.description}). It must match this JSON Schema, with every required field:
${JSON.stringify(opts.schema)}`;
  let retried = false;
  for (;;) {
    const { text } = await geminiText(prompt, { json: true, system: opts.system, maxTokens: Math.max(opts.maxTokens, 8000) });
    try {
      const input = JSON.parse(jsonPart(text)) as Record<string, unknown>;
      const missing = missingRequired(opts.schema, input);
      if (missing.length) throw new BadToolOutput(`${opts.name} (gemini): missing ${missing.join(', ')}`);
      return input as T;
    } catch (e) {
      if (retried) throw e;
      retried = true;
      console.warn(`[claude] ${opts.name} gemini fallback: retrying after: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  }
}

async function callToolClaude<T>(opts: ToolCall): Promise<T> {
  let retried = false;
  for (;;) {
    const forced = !NO_FORCED_TOOL.has(opts.model);
    const strict = !NO_STRICT.has(`${opts.model}:${opts.name}`);
    const system = forced ? opts.system : `${opts.system ? `${opts.system}\n\n` : ''}Answer only by calling the ${opts.name} tool, once, with every required field.`;
    const req = {
      model: opts.model,
      max_tokens: opts.maxTokens,
      ...(system ? { system } : {}),
      tools: [{
        name: opts.name, description: opts.description,
        input_schema: strict ? toStrictSchema(opts.schema) : opts.schema,
        ...(strict ? { strict: true } : {}),
      }],
      tool_choice: forced ? { type: 'tool' as const, name: opts.name } : { type: 'auto' as const },
      messages: [{ role: 'user' as const, content: opts.prompt }],
    };
    try {
      // deno-lint-ignore no-explicit-any
      const msg = await anthropic.messages.create(req as any);
      addUsage(opts.usage, msg.usage);
      const tool = msg.content.find((b) => b.type === 'tool_use');
      if (!tool || tool.type !== 'tool_use') throw new BadToolOutput(`${opts.name}: no tool call (stop_reason ${msg.stop_reason})`);
      if (msg.stop_reason === 'max_tokens') throw new BadToolOutput(`${opts.name}: cut off at max_tokens (${opts.maxTokens})`);
      const input = (tool.input ?? {}) as Record<string, unknown>;
      const missing = missingRequired(opts.schema, input);
      if (missing.length) throw new BadToolOutput(`${opts.name}: missing ${missing.join(', ')}`);
      return input as T;
    } catch (e) {
      const status = (e as { status?: number })?.status;
      const message = String((e as Error)?.message ?? '');
      // Free retry: switch this model to tool_choice auto for the life of the instance.
      if (status === 400 && forced && /tool_choice/.test(message) && /not supported/.test(message)) {
        NO_FORCED_TOOL.add(opts.model);
        console.warn(`[claude] ${opts.model} rejects forced tool_choice; using auto`);
        continue;
      }
      // Strict mode refused (the schema or the model): plain tool use, checked by us.
      if (status === 400 && strict && /strict|schema|additionalProperties/i.test(message)) {
        NO_STRICT.add(`${opts.model}:${opts.name}`);
        console.warn(`[claude] ${opts.model} strict tool use refused (${message.slice(0, 200)}); using plain tool use`);
        continue;
      }
      const retryable = e instanceof BadToolOutput || status === 429 || status === 529 || (status ?? 0) >= 500;
      if (retried || !retryable) throw e;
      retried = true;
      console.warn(`[claude] ${opts.name}: retrying after: ${message.slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, e instanceof BadToolOutput ? 0 : 2000));
    }
  }
}

/**
 * A Claude text call with Gemini behind it: when Claude is out (or marked out),
 * the same prompt goes to Gemini. `claude` makes the call and returns the text.
 */
export async function withGeminiFallback(claude: () => Promise<string>, prompt: string, opts: { json?: boolean; maxTokens?: number } = {}): Promise<string> {
  if (!isOut('claude')) {
    try {
      return await claude();
    } catch (e) {
      if (!providerDown(e)) throw e;
      markOut('claude', e);
    }
  }
  return (await geminiText(prompt, { json: opts.json, maxTokens: opts.maxTokens ? Math.max(opts.maxTokens, 2048) : undefined })).text;
}

/** Plain text completion (the editor's writer step). */
export function complete(opts: { model: string; prompt: string; maxTokens: number; usage: Usage }): Promise<string> {
  return withGeminiFallback(() => completeClaude(opts), opts.prompt, { maxTokens: opts.maxTokens });
}

async function completeClaude(opts: { model: string; prompt: string; maxTokens: number; usage: Usage }): Promise<string> {
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
export function quickHaiku(prompt: string, maxTokens = 1024): Promise<string> {
  // Gemini thinks too, so its fallback gets room for that beside the answer.
  return withGeminiFallback(() => quickHaikuClaude(prompt, maxTokens), prompt, { maxTokens: Math.max(maxTokens, 2048) });
}

async function quickHaikuClaude(prompt: string, maxTokens: number): Promise<string> {
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
