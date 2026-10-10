// Podcast script prompt (docs/podcast-design.md §4) — turns source material into
// a two-host Japanese dialogue tuned for LISTENING. Kept separate from
// rewritePrompt.ts (whose news output is byte-frozen for the eval baseline) and
// import-free so scripts/ tooling can bundle it the way the eval harness bundles
// rewritePrompt.ts.
//
// Listening is harder than reading — you can't re-read and there's no kanji to
// lean on — so scripts target one JLPT level easier than the reader's level,
// reuse the source's own vocabulary, keep sentences short and repeat key terms.

export type PodcastSourceKind = 'article' | 'digest' | 'topic' | 'text' | 'url';

export interface PodcastSpeaker {
  name: string;
  gender: 'female' | 'male';
  dialect: string;
  persona: string;
}

export interface PodcastSourceItem {
  title: string;
  /** Japanese (an already-personalized article) or English (pasted text / URL). */
  text: string;
}

export interface PodcastPromptInput {
  kind: PodcastSourceKind;
  /** Reader's JLPT level, 5 (N5) … 1 (N1). Listening targets one level easier. */
  jlptLevel: number;
  host: PodcastSpeaker;
  guest: PodcastSpeaker;
  /** Topic phrase for kind 'topic'; ignored otherwise. */
  topic?: string;
  /** 1 item for article/text/url, 2–4 for digest, none for topic. */
  items: PodcastSourceItem[];
  /** Total Japanese characters to aim for (≈ 280 chars per minute of audio). */
  targetChars: number;
  /** Human date label for the digest intro, e.g. "10月9日". */
  dateLabel?: string;
}

export interface PodcastTurn {
  speaker: 'host' | 'guest';
  text: string;
}

export interface PodcastVocab {
  word: string;
  reading: string;
  meaning: string;
}

export interface PodcastScript {
  title: string;
  turns: PodcastTurn[];
  vocab: PodcastVocab[];
}

/** Characters per minute of v4 dialogue audio (spike: 350–405 chars/min; first
 *  production digest: 1,018 chars → 2:39, i.e. 385/min). Playback speed is the
 *  learner's lever — script length is sized to the real spoken rate. */
export const CHARS_PER_MINUTE = 370;

/** Per-source cap so a long article can't crowd out the instructions. */
const SOURCE_CHAR_CAP = 6000;

const levelLabel = (n: number) => `N${Math.min(5, Math.max(1, Math.round(n)))}`;

function speakerLine(role: 'host' | 'guest', s: PodcastSpeaker): string {
  return `- ${role}: ${s.name}（${s.gender === 'female' ? '女性' : '男性'}）— ${s.persona} 話し方: ${s.dialect}`;
}

function sourceBlock(input: PodcastPromptInput): string {
  if (input.kind === 'topic') {
    return `TOPIC: ${input.topic ?? ''}
There is no source article. Make an evergreen, explanatory episode about this topic.
Do NOT invent current events, dates, statistics, names of real people, or quotes — explain general, well-established facts only.`;
  }
  const items = input.items
    .map((it, i) => `${input.items.length > 1 ? `STORY ${i + 1}: ` : ''}${it.title}\n${it.text.slice(0, SOURCE_CHAR_CAP)}`)
    .join('\n\n---\n\n');
  const lead = input.kind === 'digest'
    ? `These are today's stories from the listener's news feed${input.dateLabel ? ` (${input.dateLabel})` : ''}. Cover each story in turn with a short natural transition between them; spend roughly equal time on each.`
    : input.kind === 'article'
      ? 'This is an article the listener has read (or will read) in Japanese. Talk about it so they hear its key words again.'
      : 'This is source material the listener chose (it may be English). Talk about it in Japanese.';
  return `${lead}\n\nSOURCE:\n${items}`;
}

export function buildPodcastPrompt(input: PodcastPromptInput): string {
  const listen = levelLabel(Math.min(5, input.jlptLevel + 1));
  const read = levelLabel(input.jlptLevel);
  const minTurns = Math.max(10, Math.round(input.targetChars / 100));
  const maxTurns = Math.max(minTurns + 6, Math.round(input.targetChars / 45));
  return `You are writing the script for a Japanese-language podcast episode for a learner.
The learner reads at JLPT ${read}. Listening is harder than reading, so write the dialogue at ${listen} or easier.

Speakers:
${speakerLine('host', input.host)}
${speakerLine('guest', input.guest)}

Write a natural two-person conversation (対談).
Listening rules:
- Reuse the source's own key words; never introduce harder vocabulary than the source uses.
- Short sentences, mostly under 40 characters. Spoken register (です/ます for 標準語 speakers).
- Repeat each key term 2–3 times naturally across the conversation; the host sometimes rephrases ("つまり…ということですね").
- Open with a short greeting where the speakers name themselves and the topic; close with a one-line recap and sign-off.
- A dialect speaker keeps the dialect mild and consistent so a learner can follow (関西弁: 〜やん、〜へん、ほんま、〜やで / 博多弁: 〜ばい、〜けん、〜と？).
- Keep each speaker in character (personality above) for the whole episode.
- LENGTH MATTERS: write at least ${input.targetChars} Japanese characters of dialogue in total (aim for ${Math.round(input.targetChars * 1.1)}), ${minTurns}–${maxTurns} turns, speakers alternate. This is a ${Math.round(input.targetChars / CHARS_PER_MINUTE)}-minute episode — keep the conversation going with examples, questions and follow-ups rather than wrapping up early.

Also pick 3–5 key words from the episode for a "words in this episode" list (dictionary form, with kana reading and a short English meaning).

Output JSON only:
{"title": "<short Japanese episode title>", "turns": [{"speaker": "host" | "guest", "text": "<Japanese>"}], "vocab": [{"word": "<word>", "reading": "<kana>", "meaning": "<English>"}]}
Turn text is plain spoken Japanese only — no furigana, romaji, stage directions, sound effects, speaker names, or markdown.

${sourceBlock(input)}`;
}

export class ScriptValidationError extends Error {}

/** Validate + normalize a parsed generation. Throws ScriptValidationError
 *  (treated as transient → regenerate) when it can't be voiced. */
export function normalizeScript(raw: unknown, input: Pick<PodcastPromptInput, 'host' | 'guest' | 'targetChars'>): PodcastScript {
  const r = raw as { title?: unknown; turns?: unknown; vocab?: unknown };
  if (!r || typeof r !== 'object' || !Array.isArray(r.turns)) throw new ScriptValidationError('no turns array');
  // Models sometimes prefix a turn with the speaker's name ("ケンジ：…") — strip it.
  const namePrefix = new RegExp(`^\\s*(?:${[input.host.name, input.guest.name].join('|')})\\s*[：:]\\s*`);
  const turns: PodcastTurn[] = [];
  for (const t of r.turns as { speaker?: unknown; text?: unknown }[]) {
    if (!t || (t.speaker !== 'host' && t.speaker !== 'guest') || typeof t.text !== 'string') {
      throw new ScriptValidationError(`malformed turn: ${JSON.stringify(t)?.slice(0, 120)}`);
    }
    const text = t.text.replace(namePrefix, '').replace(/\s+/g, ' ').trim();
    if (text) turns.push({ speaker: t.speaker, text });
  }
  if (turns.length < 4) throw new ScriptValidationError(`only ${turns.length} turns`);
  const chars = turns.reduce((n, t) => n + t.text.length, 0);
  if (chars < input.targetChars * 0.7) throw new ScriptValidationError(`script too short: ${chars} chars for target ${input.targetChars}`);
  const vocab = Array.isArray(r.vocab)
    ? (r.vocab as Record<string, unknown>[])
        .filter((v) => v && typeof v.word === 'string' && typeof v.meaning === 'string')
        .slice(0, 5)
        .map((v) => ({ word: String(v.word), reading: typeof v.reading === 'string' ? v.reading : '', meaning: String(v.meaning) }))
    : [];
  const title = typeof r.title === 'string' && r.title.trim() ? r.title.trim() : 'ポッドキャスト';
  return { title, turns, vocab };
}
