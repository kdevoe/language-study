// Song writing (聞く › 音楽, docs/music-design.md): Claude turns a style (a preset
// or the listener's own description) and a theme into a plan ElevenLabs Music
// can sing: a title, an artist-free style description, lyrics per section with
// durations and style tags, and a cover-art scene.
//
// The cover's look is NOT the songwriter's call: it writes only the scene, and
// the art direction comes from the listener (Settings › 聞く, user_preferences.
// song_cover_style) or DEFAULT_COVER_STYLE, so every cover shares the app's
// quiet, illustrated look whatever the music style.
export const DEFAULT_COVER_STYLE = 'Flat risograph-print illustration with a Japanese-Scandinavian calm: simple geometric shapes, soft grain and slight misregistration, a limited palette of warm off-white paper, pale mist blue, deep olive and charcoal, at most one small warm accent. Lots of empty space, one clear focal subject.';
export const COVER_STYLE_MAX_CHARS = 400;
//
// Vocabulary works the way it does for articles (_shared/readerVocab.ts): the
// reader's whole known lexicon goes in as the ALLOWED LIST, so the body of the
// song is words they already know, and a few review words are slipped in where
// they fit. But the song comes first: a learning song that sounds forced is one
// nobody replays, so review words are a soft ask (drop any that would sound
// wrong), lyrics follow real songwriting (hook, repetition, imagery, one mood),
// and a simpler image from the list beats a clever word outside it.
//
// No real artist or song names leave this module: the presets are written
// without them, and a listener's description that names one is rewritten into
// plain style words (request_clean) before it's stored or sent anywhere.
// Import-free so scripts/ tooling can bundle it.

export interface SongStyle {
  id: string;
  label: string;
  /** Artist-free English seed for the style description. */
  seed: string;
  /** Lowest JLPT level (5 = N5) it suits; children's songs only for beginners. */
  maxLevel?: number;
  minLevel?: number;
}

export const SONG_STYLES: SongStyle[] = [
  { id: 'anime', label: 'アニメ主題歌', seed: 'A fast, soaring Japanese pop-rock anthem for the emotional peak of an animated film: shimmering piano intro, galloping drums, bright chiming guitars, strings that surge at each chorus, a raw, urgent lead vocal with long held notes in the chorus.' },
  { id: 'citypop', label: 'シティポップ', seed: 'Smooth 1980s Japanese city pop: groovy slap bass, electric piano, clean funk guitar, lush synth pads and brass stabs, a warm, relaxed female vocal, the feeling of driving through a city at night.' },
  { id: 'ballad', label: 'バラード', seed: 'A slow, intimate Japanese piano ballad: soft piano that opens up into strings, a tender, close-miked vocal that builds to an emotional final chorus, bittersweet and warm.' },
  { id: 'acoustic', label: 'アコースティック', seed: 'Warm acoustic folk-pop: fingerpicked and strummed acoustic guitar, light percussion and handclaps, a gentle, friendly vocal, sunny and unhurried.' },
  { id: 'rock', label: 'ロック', seed: 'Driving Japanese guitar rock: crunchy rhythm guitars, punchy bass and drums, an energetic, confident vocal and a big shout-along chorus.' },
  { id: 'lofi', label: 'ローファイ', seed: 'Chill lo-fi pop: dusty boom-bap drums, mellow electric piano, soft bass, vinyl warmth, a soft, breathy sung vocal, calm and late-night.' },
  { id: 'electro', label: 'エレクトロ', seed: 'Bright Japanese electro-pop: sparkling synths, four-on-the-floor beat, a catchy synth hook, a clear, playful female vocal, upbeat and danceable.' },
  { id: 'kids', label: '童謡', seed: 'A simple, cheerful Japanese children\'s song: bouncy piano and glockenspiel, light percussion, a clear, slow, friendly vocal, short repeated phrases that are easy to sing along to.', minLevel: 4 },
];

export const styleById = (id: string) => SONG_STYLES.find((s) => s.id === id);

export interface SongWord {
  word: string;
  reading: string;
  meaning: string;
}

export interface SongPromptInput {
  /** Reader's JLPT level, 5 (N5) … 1 (N1). Lyrics are written one level easier. */
  jlptLevel: number;
  minutes: number;
  /** A preset, or null for the listener's own description. */
  style: SongStyle | null;
  /** The listener's description ('custom'); may name artists — never echoed. */
  request?: string;
  /** What the song is about (optional). */
  theme?: string;
  /** The reader's known lexicon (readerVocab.buildLexicon), the ALLOWED LIST. */
  lexicon?: string[];
  /** Struggling words to slip in where they fit (readerVocab.pickReviewWords). */
  reviewWords?: string[];
  /** Automatic songs: titles of recently read articles, for a theme idea. */
  recentTitles?: string[];
  /** The listener's recent songs, newest first, so this one differs. */
  history?: SongHistoryItem[];
}

export interface SongHistoryItem {
  title: string;
  style: string;
  theme: string | null;
  /** First sentence of the style description (tempo, mood). */
  mood: string;
  /** The chorus's first line. */
  hook: string;
}

/** Summarise a stored plan for the history block. */
export function historyItem(plan: SongPlan, styleLabel: string, theme: string | null): SongHistoryItem {
  const chorus = plan.sections.find((s) => /chorus/i.test(s.name) && s.lines.length) ?? plan.sections.find((s) => s.lines.length);
  return {
    title: plan.title,
    style: styleLabel,
    theme,
    mood: plan.description.split(/(?<=\.)\s/)[0]?.slice(0, 200) ?? '',
    hook: chorus?.lines[0] ?? '',
  };
}

export interface SongSection {
  name: string;
  lines: string[];
  duration_ms: number;
  styles: string[];
  negative_styles: string[];
}

export interface SongPlan {
  title: string;
  description: string;
  request_clean: string | null;
  global_styles: string[];
  negative_styles: string[];
  sections: SongSection[];
  vocab: SongWord[];
  cover_prompt: string;
}

export class PlanValidationError extends Error {}

const levelLabel = (n: number) => `N${Math.min(5, Math.max(1, Math.round(n)))}`;

/** The tool Claude must call: its input is the plan. */
export const SONG_PLAN_TOOL = {
  name: 'submit_song',
  description: 'Submit the finished song plan.',
  input_schema: {
    type: 'object',
    required: ['title', 'description', 'global_styles', 'negative_styles', 'sections', 'vocab', 'cover_prompt'],
    properties: {
      title: { type: 'string', description: 'Japanese song title, short (2–12 characters), evocative.' },
      description: { type: 'string', description: 'English, 3–5 sentences: genre, instrumentation, vocals, tempo, mood, arc. No real artist, band, song or film names.' },
      request_clean: { type: ['string', 'null'], description: "Only when the listener described their own style: their request rewritten in plain English style words with every artist, band, song or film name removed. Otherwise null." },
      global_styles: { type: 'array', items: { type: 'string' }, description: '6–8 short English style tags for the whole song: genre, vocal type, key instruments, mood, BPM.' },
      negative_styles: { type: 'array', items: { type: 'string' }, description: '2–5 English tags to avoid (always include "english vocals").' },
      sections: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name', 'lines', 'duration_ms', 'styles'],
          properties: {
            name: { type: 'string', description: 'English section name, e.g. Intro, Verse 1, Pre-Chorus, Chorus, Bridge, Final Chorus, Outro.' },
            lines: { type: 'array', items: { type: 'string' }, description: 'Japanese lyric lines, sung text only. Separate phrases with a single half-width space. Empty for an instrumental section.' },
            duration_ms: { type: 'integer', description: 'Section length in ms, 5000–60000.' },
            styles: { type: 'array', items: { type: 'string' }, description: '2–4 English tags for this section (energy, arrangement, who sings).' },
            negative_styles: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      vocab: {
        type: 'array',
        description: 'The 4–8 most useful words a learner meets in these lyrics, dictionary form.',
        items: { type: 'object', required: ['word', 'reading', 'meaning'], properties: { word: { type: 'string' }, reading: { type: 'string' }, meaning: { type: 'string' } } },
      },
      cover_prompt: { type: 'string', description: 'English description of ONE scene for the square album art: the subject, setting, composition and mood that fit the song. Describe only what is shown, never an art style, medium or palette (the listener sets those). No text, letters or logos; no real people.' },
    },
  },
} as const;

export function buildSongPrompt(input: SongPromptInput): string {
  const level = Math.min(5, Math.max(1, input.jlptLevel + 1)); // one level easier: N3 reader → N4 lyrics
  const totalMs = input.minutes * 60_000;

  const style = input.style
    ? `STYLE: ${input.style.label} — ${input.style.seed}`
    : `STYLE: the listener described it themselves:
"""
${(input.request ?? '').slice(0, 600)}
"""
If it mentions any real artist, band, song, album or film, translate that reference into plain musical terms (genre, era, instruments, vocal character, tempo, mood) and never write the name anywhere in your output. Put the rewritten request in request_clean.`;

  const theme = input.theme?.trim()
    ? `THEME: ${input.theme.trim()}`
    : input.recentTitles?.length
      ? `THEME: your choice. For a starting point, the listener recently read about:\n${input.recentTitles.map((t) => `- ${t}`).join('\n')}\nDon't retell the news. Find one human feeling or image in it (a place, a season, a small moment) and write about that.`
      : 'THEME: your choice — an everyday feeling or scene that suits the style.';

  const review = input.reviewWords?.length
    ? `REVIEW WORDS — slip ${Math.min(3, input.reviewWords.length) === 1 ? 'this one' : `about ${Math.min(3, input.reviewWords.length)} of these`} in where they sing naturally (a hook line is ideal; leave out any that would sound forced): ${input.reviewWords.join('、')}`
    : '';

  const vocabulary = input.lexicon?.length
    ? `VOCABULARY
The listener knows ONLY the words in the ALLOWED LIST below. Build the lyrics from it: every content word (nouns, verbs, adjectives, adverbs) should come from the list, with these exceptions:
1. Katakana loanwords (they read for free).
2. At most 2 words the theme truly needs that aren't on the list — keep them simple and common.
3. The review words below.
Particles, auxiliaries and conjugations are free. When an image needs a word that isn't on the list, change the image rather than reach outside it.
${review}

ALLOWED LIST:
${input.lexicon.join('、')}`
    : `VOCABULARY: about ${levelLabel(level)}, everyday words.
${review}`;

  // The past month: the newest few in full (their hooks and moods are what a
  // new song could echo), the rest as one line each.
  const DETAILED = 8;
  const hist = input.history ?? [];
  const history = hist.length
    ? `THE LISTENER'S SONGS FROM THE PAST MONTH (newest first) — make this one clearly different. Don't reuse a title, a hook line or a central image; pick a subject, setting, season or time of day and an emotional colour these haven't covered lately; within a style, vary tempo and arrangement from earlier songs in it:
${hist.slice(0, DETAILED).map((h) => `- 「${h.title}」 ${h.style}${h.theme ? ` · theme: ${h.theme}` : ''} · hook: ${h.hook} · ${h.mood}`).join('\n')}${hist.length > DETAILED ? `\nEarlier:\n${hist.slice(DETAILED).map((h) => `- 「${h.title}」 ${h.style}${h.theme ? ` · ${h.theme}` : ''}`).join('\n')}` : ''}`
    : '';

  return `You are a Japanese songwriter. Write an original song for a ${levelLabel(input.jlptLevel)} learner of Japanese who will listen to it on repeat.

THE SONG COMES FIRST. It must sound like a real song someone would choose to play again: a clear, memorable chorus hook that repeats, concrete images, one consistent mood and point of view, lines that scan and sing well. Never explain the vocabulary, never list words, never write a lesson.

LANGUAGE
- Grammar at about ${levelLabel(level)} (one level easier than the listener — it's heard, not read), with poetic licence where a song needs it (dropped particles, repetition, inversion are fine).
- Natural spoken Japanese a native songwriter would write. No English words or romaji in the lyrics.
- Short lines (about 6–16 characters). Separate phrases inside a line with one half-width space, as in "走れ 走れ 時を越えて"; the singer's timing is matched phrase by phrase.

${style}

${theme}

${history}

STRUCTURE
- Total length exactly ${totalMs} ms (${input.minutes} min) — the section durations must add up to it.
- A typical shape: short Intro (instrumental, 5000–10000 ms), Verse, Pre-Chorus (optional), Chorus, Verse 2, Chorus, Bridge (optional), Final Chorus, short Outro. Fewer sections for 1 min (e.g. Intro, Verse, Chorus, Outro).
- About one lyric line per 3–4 seconds of a sung section (a 16000 ms verse holds about 4 lines). Choruses repeat the same hook lines each time.
- The style tags are for a music model: plain English, no artist or song names, the first section's tone set by global_styles.

${vocabulary}

Call submit_song with the finished plan.`;
}

/** Validate and repair Claude's plan: exact total length, ElevenLabs' chunk limits. */
export function normalizePlan(raw: unknown, input: SongPromptInput): SongPlan {
  const p = raw as Partial<SongPlan> & { sections?: Partial<SongSection>[] };
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const strs = (v: unknown, max: number) => (Array.isArray(v) ? v.map(str).filter(Boolean).slice(0, max) : []);

  const title = str(p.title).slice(0, 40);
  if (!title) throw new PlanValidationError('plan has no title');
  const sections: SongSection[] = (p.sections ?? []).map((s, i) => ({
    name: str(s.name).slice(0, 60) || `Section ${i + 1}`,
    lines: strs(s.lines, 30).map((l) => l.replace(/[ \u3000]+/g, ' ').slice(0, 200)),
    duration_ms: Number(s.duration_ms) || 0,
    styles: strs(s.styles, 6),
    negative_styles: strs(s.negative_styles, 6),
  })).filter((s) => s.duration_ms > 0);
  if (sections.length < 2) throw new PlanValidationError('plan needs at least two sections');
  if (!sections.some((s) => s.lines.length)) throw new PlanValidationError('plan has no lyrics');

  // Scale to the exact length, then keep each chunk inside ElevenLabs' 3–120s window.
  const total = input.minutes * 60_000;
  const sum = sections.reduce((n, s) => n + s.duration_ms, 0);
  for (const s of sections) s.duration_ms = Math.min(120_000, Math.max(3000, Math.round((s.duration_ms * total) / sum / 100) * 100));
  sections[sections.length - 1].duration_ms += total - sections.reduce((n, s) => n + s.duration_ms, 0);
  const last = sections[sections.length - 1];
  last.duration_ms = Math.min(120_000, Math.max(3000, last.duration_ms));

  const negative = strs(p.negative_styles, 6);
  if (!negative.some((n) => /english/i.test(n))) negative.push('english vocals');

  return {
    title,
    description: str(p.description).slice(0, 1200),
    request_clean: input.style ? null : str(p.request_clean).slice(0, 600) || null,
    global_styles: strs(p.global_styles, 8),
    negative_styles: negative,
    sections,
    vocab: (Array.isArray(p.vocab) ? p.vocab : [])
      .map((v) => ({ word: str(v?.word), reading: str(v?.reading), meaning: str(v?.meaning) }))
      .filter((v) => v.word)
      .slice(0, 10),
    cover_prompt: str(p.cover_prompt).slice(0, 1000),
  };
}

/** ElevenLabs composition plan (music_v2 / v2.5 chunks). The first chunk carries
 *  the global styles, which set the song's tone. */
export function toCompositionPlan(plan: SongPlan) {
  return {
    chunks: plan.sections.map((s, i) => ({
      text: [`[${s.name}]`, ...s.lines].join('\n'),
      duration_ms: s.duration_ms,
      positive_styles: (i === 0 ? [...plan.global_styles, ...s.styles] : s.styles).slice(0, 10),
      negative_styles: [...plan.negative_styles, ...s.negative_styles].slice(0, 8),
      context_adherence: 'high',
    })),
  };
}

export interface LineTiming { start: number; end: number }

/** Map ElevenLabs' phrase timestamps onto the plan's lines, in order. A phrase
 *  that doesn't match its line's next phrase is searched for a few ahead, so one
 *  dropped or merged phrase doesn't shift every line after it. Lines with no
 *  match get null (the player keeps the previous line lit). */
export function lineTimings(plan: SongPlan, words: { word: string; start_ms: number; end_ms: number }[]): (LineTiming | null)[][] {
  const norm = (s: string) => s.replace(/[\s\u3000、。！？!?「」『』…・〜~]/g, '');
  let p = 0;
  return plan.sections.map((s) => s.lines.map((line) => {
    let start: number | null = null;
    let end: number | null = null;
    for (const phrase of line.split(' ').filter(Boolean)) {
      const want = norm(phrase);
      let hit = -1;
      for (let j = p; j < Math.min(words.length, p + 4); j++) {
        if (norm(words[j].word) === want) { hit = j; break; }
      }
      if (hit < 0) continue;
      start ??= words[hit].start_ms;
      end = words[hit].end_ms;
      p = hit + 1;
    }
    return start != null && end != null ? { start, end } : null;
  }));
}
