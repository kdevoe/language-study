// ElevenLabs text-to-dialogue with per-character timestamps (docs/podcast-design.md
// §2, validated by the P0 spike): one call voices a multi-speaker script and
// returns character-level alignment, which maps 1:1 onto the input text for
// Japanese — so the player highlights straight off the stored script.

import { ELEVEN_DIALOGUE_MODEL } from './models.ts';

const XI_URL = 'https://api.elevenlabs.io/v1/text-to-dialogue/with-timestamps';
/** Endpoint guidance: keep each request ≤ 2,000 chars or output may cut short. */
const MAX_REQUEST_CHARS = 1900;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 3000, 6000];

export interface DialogueLine {
  text: string;
  voiceId: string;
}

/** Per-turn timing: start/end seconds and each character's start (ms). */
export interface TurnAlignment {
  start: number;
  end: number;
  t: number[];
}

export interface DialogueRender {
  mp3: Uint8Array;
  alignment: TurnAlignment[];
  durationSec: number;
  chars: number;
  requests: number;
}

interface XiResponse {
  audio_base64: string;
  alignment: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } | null;
  voice_segments: {
    start_time_seconds: number;
    end_time_seconds: number;
    character_start_index: number;
    character_end_index: number;
    dialogue_input_index: number;
  }[];
}

/** Split lines into request-sized chunks at turn boundaries. */
function chunkLines(lines: DialogueLine[]): DialogueLine[][] {
  const chunks: DialogueLine[][] = [[]];
  let n = 0;
  for (const line of lines) {
    if (n + line.text.length > MAX_REQUEST_CHARS && chunks[chunks.length - 1].length) {
      chunks.push([]);
      n = 0;
    }
    chunks[chunks.length - 1].push(line);
    n += line.text.length;
  }
  return chunks;
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function callDialogue(apiKey: string, lines: DialogueLine[], previousRequestIds: string[]): Promise<{ body: XiResponse; requestId: string | null }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetch(`${XI_URL}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model_id: ELEVEN_DIALOGUE_MODEL,
        language_code: 'ja',
        inputs: lines.map((l) => ({ text: l.text, voice_id: l.voiceId })),
        ...(previousRequestIds.length ? { previous_request_ids: previousRequestIds.slice(-3) } : {}),
      }),
    });
    if (res.ok) return { body: await res.json(), requestId: res.headers.get('request-id') };
    const detail = (await res.text()).slice(0, 300);
    lastErr = new Error(`elevenlabs ${res.status}: ${detail}`);
    // 429 / 5xx are transient; anything else (bad voice, quota, validation) is not.
    if (res.status !== 429 && res.status < 500) throw lastErr;
    if (attempt < MAX_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
  }
  throw lastErr;
}

/** Voice a dialogue. Lines longer than one request are rendered in turn-boundary
 *  chunks, stitched with previous_request_ids for prosody continuity, and their
 *  MP3 frames concatenated (offsetting each chunk's timings). */
export async function renderDialogue(apiKey: string, lines: DialogueLine[]): Promise<DialogueRender> {
  const audio: Uint8Array[] = [];
  const alignment: TurnAlignment[] = [];
  const requestIds: string[] = [];
  let offset = 0;
  for (const chunk of chunkLines(lines)) {
    const { body, requestId } = await callDialogue(apiKey, chunk, requestIds);
    if (requestId) requestIds.push(requestId);
    audio.push(decodeBase64(body.audio_base64));
    const al = body.alignment;
    if (!al) throw new Error('elevenlabs returned no alignment');
    const turnTimes: TurnAlignment[] = chunk.map(() => ({ start: 0, end: 0, t: [] }));
    for (const vs of body.voice_segments) {
      const turn = turnTimes[vs.dialogue_input_index];
      if (!turn) continue;
      if (turn.t.length === 0) turn.start = +(vs.start_time_seconds + offset).toFixed(3);
      turn.end = +(vs.end_time_seconds + offset).toFixed(3);
      for (let k = vs.character_start_index; k < vs.character_end_index; k++) {
        turn.t.push(Math.round((al.character_start_times_seconds[k] + offset) * 1000));
      }
    }
    alignment.push(...turnTimes);
    const chunkEnd = Math.max(
      0,
      ...body.voice_segments.map((v) => v.end_time_seconds),
      ...al.character_end_times_seconds,
    );
    offset += chunkEnd;
  }
  const total = audio.reduce((n, a) => n + a.length, 0);
  const mp3 = new Uint8Array(total);
  let at = 0;
  for (const a of audio) {
    mp3.set(a, at);
    at += a.length;
  }
  return {
    mp3,
    alignment,
    durationSec: +offset.toFixed(2),
    chars: lines.reduce((n, l) => n + l.text.length, 0),
    requests: audio.length,
  };
}
