// Centralized LLM model identifiers — the single bump point per model (issue #64).
//
// Every edge function imports its model strings from here so there is exactly one
// place to change when a model is bumped.
//
// Pinning notes:
// - Groq IDs ARE the version identifier (Groq exposes no dated snapshots), so the
//   strings below are as reproducible as the provider allows.
// - GEMINI_FLASH was previously the floating `gemini-3-flash-preview` alias. The
//   gemini-3-flash line never shipped a stable/dated build, so we moved to the
//   stable `gemini-3.5-flash` — a reproducible, non-preview identifier. Bumped to
//   the stable `gemini-3.8-flash` in Oct 2026. The flash-vs-pro / per-task
//   comparison still belongs to the eval harness in issue #65; this is the
//   single line to change when that lands.

/** Gemini — article rewriting (process-article). */
export const GEMINI_FLASH = 'gemini-3.8-flash';

/** Claude — grammar insight (dictionary-lookup). Anthropic IDs carry no date suffix. */
export const CLAUDE_HAIKU = 'claude-haiku-5-5';

/** Groq — keyword extraction, heteronym readings, translation, definition fallback. */
export const GROQ_GENERAL = 'openai/gpt-oss-20b';

/** Groq — same-story news clustering/dedupe (fetch-raw-news). */
export const GROQ_CLUSTER = 'llama-3.3-70b-versatile';

/** ElevenLabs — podcast dialogue TTS (generate-podcast). v4 won the P0 spike over
 *  v3: ~35% faster generation and a 7–20 dB lower noise floor on every voice
 *  (docs/podcast-design.md "Spike results"). */
export const ELEVEN_DIALOGUE_MODEL = 'eleven_v4';
