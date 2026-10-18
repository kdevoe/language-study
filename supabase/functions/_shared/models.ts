// Centralized LLM model identifiers — the single bump point per model (issue #64).
//
// Every edge function imports its model strings from here so there is exactly one
// place to change when a model is bumped.
//
// Pinning notes:
// - GEMINI_FLASH was previously the floating `gemini-3-flash-preview` alias. The
//   gemini-3-flash line never shipped a stable/dated build, so we moved to the
//   stable `gemini-3.5-flash` — a reproducible, non-preview identifier. Bumped to
//   the stable `gemini-3.8-flash` in Oct 2026. The flash-vs-pro / per-task
//   comparison still belongs to the eval harness in issue #65; this is the
//   single line to change when that lands.

/** Gemini — article rewriting (process-article). */
export const GEMINI_FLASH = 'gemini-3.8-flash';

/** Claude — grammar insight, and (thinking off, via quickHaiku) translation, readings,
 *  disambiguation, definition fallback and article concept extraction. Anthropic IDs
 *  carry no date suffix. */
export const CLAUDE_HAIKU = 'claude-haiku-5-5';

/** Claude — the weekly deep dream (learner-dream mode 'weekly'). */
export const CLAUDE_SONNET = 'claude-sonnet-5-5';

/** Claude — ハルカ's chat turns (tutor-chat). One line to switch to Haiku after
 *  measuring on real transcripts (docs/tutor-agent-design.md §8). */
export const TUTOR_MODEL = CLAUDE_SONNET;

/** Claude — ハルカ's quarantined web research (_shared/research.ts): reads raw
 *  search results with no tools but web_search and its report. */
export const RESEARCH_MODEL = CLAUDE_HAIKU;

/** Claude — the news editor (fetch-raw-news) and the nightly dream. */
export const NEWS_EDITOR = CLAUDE_HAIKU;
export const DREAM_MODEL = CLAUDE_HAIKU;

/** $ per million tokens (prompts ≤100k), for the usage telemetry stored on rows.
 *  Cache reads bill at 0.1× input, cache writes at 1.25×. Oct 2026 pricing. */
export const CLAUDE_PRICES: Record<string, { in: number; out: number }> = {
  [CLAUDE_HAIKU]: { in: 0.10, out: 0.50 },
  [CLAUDE_SONNET]: { in: 2, out: 10 },
};

/** Claude web search: $10 per 1,000 searches, on top of tokens. */
export const WEB_SEARCH_USD = 0.01;

/** ElevenLabs — podcast dialogue TTS (generate-podcast). v4 won the P0 spike over
 *  v3: ~35% faster generation and a 7–20 dB lower noise floor on every voice
 *  (docs/podcast-design.md "Spike results"). */
export const ELEVEN_DIALOGUE_MODEL = 'eleven_v4';

/** Claude — song writing (generate-song): style description, lyrics, cover prompt. */
export const CLAUDE_OPUS = 'claude-opus-5-5';

/** ElevenLabs — song generation (generate-song). v2.5 takes chunked composition
 *  plans with lyrics and returns per-phrase timestamps. */
export const ELEVEN_MUSIC_MODEL = 'music_v2_5';

/** Gemini — song cover art (generate-song). */
export const GEMINI_IMAGE = 'gemini-3.1-flash-image';
