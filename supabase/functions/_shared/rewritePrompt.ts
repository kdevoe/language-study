// Article-rewrite prompt builder (issue #65).
//
// The Pass-1 rewrite prompt used by process-article was previously constructed
// inline in that edge function. It is extracted here as a PURE function so that:
//   1. the edge function and the offline eval harness
//      (scripts/eval-article-rewrite.mjs) build the *exact same* prompt — the
//      harness is only a valid yardstick if it tests the shipped prompt; and
//   2. the prompt restructure (#66) has one isolated, testable surface to edit.
//
// This module has no side effects and makes no API calls — string in, string
// out. Palette construction, the Gemini call, and persistence stay in the edge
// function.

import { rtkKanjiList } from './rtkKanji.ts';

/** Everything the rewrite prompt needs, resolved by the caller (edge fn or harness). */
export interface RewriteInput {
  title: string;
  /** Merged English source block (teaser or Jina-extracted full text). */
  sourceText: string;
  /** Article length in paragraphs (source-fullness driven, user-configurable). */
  targetParagraphs: number;
  /** Reader JLPT level 1–5 (drives COMPLEXITY, not length). */
  jlptLevel: number;
  /** Reader RTK progression (0-based count of studied Heisig kanji). */
  rtkLevel: number;
  studyMode: string;
  vocabMode: string;
  /** Target known/review/new token-share for the reading intensity. */
  ratios: { known: number; review: number; new: number };
  targetReview: number;
  targetNew: number;
  knownPalette: string[];
  reviewPalette: string[];
  newPalette: string[];
  /** vocab_mode "Study" targets, drawn from the review palette. */
  vocabTargets: string[];
  /**
   * Concept clusters for input-side difficulty control (docs/vocab-palette-redesign.md).
   * Each concept lists reader-appropriate Japanese words, EASIEST-KNOWN FIRST, so the
   * model can say a hard idea with a word the reader already has. When present this
   * SUPERSEDES the flat known/new palette block and adds an explicit difficulty ceiling.
   * Absent (e.g. legacy eval fixtures) → the old flat-palette block renders byte-for-byte
   * unchanged, so the eval harness baseline is preserved.
   */
  clusters?: { concept: string; words: string[] }[];
  /**
   * Controlled vocabulary (docs/vocab-palette-redesign.md, phase 2): the reader's FULL
   * known lexicon (confirmed-easy SRS words + assumed-known JLPT levels), injected whole
   * so the allowed list IS the difficulty level — no JLPT self-assessment by the model.
   * Measured on a real N4 article: struggling-word share 39% → ~10% (net of glossed
   * topic words). Katakana loanwords are excluded upstream — they read for free and are
   * covered by a blanket exception. When present this supersedes BOTH `clusters` and the
   * flat palette; `clusters` remains the fallback when the lexicon can't be built.
   */
  lexicon?: {
    /** Allowed content words (surfaces), known-first. */
    words: string[];
    /** Pre-due SRS review words to weave in (~targetReview of them). */
    reviewWords: string[];
    /** Max out-of-list topic words the story may use, each force-glossed. Default 3. */
    maxTopicWords?: number;
  };
}

// JLPT level controls COMPLEXITY only (grammar/vocab difficulty). Article
// LENGTH comes from targetParagraphs (source fullness, user-configurable).
export const JLPT_LEVEL_CONFIG: Record<number, { description: string }> = {
  5: {
    description: 'N5: The reader understands some basic Japanese. Write simple sentences using hiragana, katakana, and basic kanji. Basic vocabulary and elementary grammar only.',
  },
  4: {
    description: 'N4: The reader understands basic Japanese. Write about familiar daily topics using basic vocabulary and kanji. Simple compound sentences are acceptable.',
  },
  3: {
    description: 'N3: The reader understands everyday Japanese. Write like a real newspaper article — use compound sentences, natural news phrasing, and intermediate grammar. The reader can handle newspaper headlines and slightly difficult text with context. Do NOT over-simplify to basic sentence patterns.',
  },
  2: {
    description: 'N2: The reader understands Japanese used in everyday situations and a variety of circumstances. Write like a real newspaper article or commentary — clear, natural prose on general topics at near-natural complexity.',
  },
  1: {
    description: 'N1: The reader understands Japanese used in a variety of circumstances. Write with full natural complexity — abstract reasoning, editorials, and nuanced prose are appropriate.',
  },
};

const HEISIG_RTK_RANGE_SIZE = 15;

/**
 * Build the Pass-1 article-rewrite prompt. Deterministic: the same input always
 * produces the same string. Kept byte-for-byte identical to the previous inline
 * construction in process-article/index.ts.
 */
export function buildRewritePrompt(input: RewriteInput): string {
  const {
    title, sourceText, targetParagraphs, jlptLevel, rtkLevel,
    studyMode, vocabMode, ratios, targetReview, targetNew,
    knownPalette, reviewPalette, newPalette, vocabTargets, clusters, lexicon,
  } = input;

  const jlptStr = `N${jlptLevel}`;
  const levelConfig = JLPT_LEVEL_CONFIG[jlptLevel] ?? JLPT_LEVEL_CONFIG[3];

  const knownKanjiCount = Math.max(0, rtkLevel - HEISIG_RTK_RANGE_SIZE);
  const studyKanji = rtkKanjiList.slice(knownKanjiCount, rtkLevel);

  let biasInstruction = 'NATURAL KANJI READING: Prioritize fluid, authentic, natural Japanese text.';
  if (studyMode === 'study') {
    biasInstruction = `STRICT KANJI PREFERENCE: The student is studying these Kanji: [${studyKanji.join(', ')}]. Prefer vocabulary using these Kanji ONLY IF the word accurately describes the actual facts of the news. CRITICAL: DO NOT invent poetic metaphors or unrelated events just to use a Kanji.`;
  } else if (studyMode === 'balanced') {
    biasInstruction = `BALANCED KANJI BIAS: Target Kanji for this student: [${studyKanji.join(', ')}]. Prefer these Kanji when multiple natural word choices exist.`;
  }

  let vocabInstruction = 'NATURAL VOCABULARY: Use the most fitting authentic Japanese syntax.';
  if (vocabTargets.length > 0) {
    if (vocabMode === 'study') {
      vocabInstruction = `STRICT VOCABULARY BIAS: Target vocabulary: [${vocabTargets.join(', ')}]. Use these words ONLY if they perfectly fit the factual events in the headline. DO NOT hallucinate facts, use heavy metaphors, or warp the news story just to fit a word.`;
    } else if (vocabMode === 'balanced') {
      vocabInstruction = `BALANCED VOCABULARY: Target vocabulary: [${vocabTargets.join(', ')}]. Prefer these words when adjacent synonyms exist. Ensure the prose remains completely natural.`;
    }
  }

  // Build targeted vocab palette block (empty string if pipeline produced nothing).
  // Three shapes by precedence: controlled-vocabulary lexicon (phase 2) > concept
  // clusters > the legacy flat known/review/new palette. The legacy branch is kept
  // byte-for-byte so the eval harness's frozen fixtures stay a valid regression
  // baseline (scripts/eval-article-rewrite.mjs).
  let palettePrompt = '';
  if (lexicon && lexicon.words.length > 0) {
    const maxTopic = lexicon.maxTopicWords ?? 3;
    palettePrompt = `
CONTROLLED VOCABULARY — THE MOST IMPORTANT RULE OF THIS TASK:
The reader knows ONLY the words in the ALLOWED LIST below. Every content word you write (nouns, verbs, adjectives, adverbs) MUST come from the ALLOWED LIST, with exactly these exceptions:
1. Proper nouns and katakana loanwords — always fine.
2. TOPIC WORDS: if the story cannot be told without a specific word that is not in the list, you may use up to ${maxTopic} such words TOTAL — and you MUST explain each one in a yugen-box.
3. REVIEW WORDS — work about ${targetReview} of these in where they fit the facts naturally: ${lexicon.reviewWords.join('、') || '(none)'}
When an idea's precise word is not allowed, REPHRASE the idea with allowed words (e.g. 費用→お金を払う, 民間の→普通の, 幼い→小さい). Simpler, longer phrasing built from allowed words ALWAYS beats one precise disallowed word. Grammar particles and auxiliaries are unrestricted; keep grammar at ${jlptStr}.

ALLOWED LIST:
${lexicon.words.join('、')}`;
  } else if (clusters && clusters.length > 0) {
    const clusterLines = clusters
      .map((c) => `- «${c.concept}»: ${c.words.join(' / ')}`)
      .join('\n');
    // The review floor (topic-independent SRS words the reader is due to reinforce) still
    // rides along as a flat list — it's a scheduling concern, not a difficulty one.
    const reviewLine = reviewPalette.length > 0
      ? `\nREVIEW — the reader is due to practise these; work about ${targetReview} of them in where they fit the facts naturally: ${reviewPalette.join('、')}`
      : '';
    palettePrompt = `
DIFFICULTY CEILING: Write at or below ${jlptStr}. When the precise term for something is above ${jlptStr}, express the idea with the simpler wording listed below, or gloss it once in a yugen-box. SIMPLER WORDING BEATS PRECISE WORDING — a reader who understands every word learns more than one reaching for the dictionary. (This never overrides the GOLDEN RULE: never distort the facts to hit or avoid a word.)

VOCABULARY GUIDANCE — to express each concept, PREFER the reader-appropriate words below (calibrated to this reader's level and known vocabulary, easiest first):
${clusterLines}
Vary your choice across the article — do not reuse the same word every time a concept recurs.${reviewLine}`;
  } else if (knownPalette.length + reviewPalette.length + newPalette.length > 0) {
    const pctKnown = Math.round(ratios.known * 100);
    const pctReview = Math.round(ratios.review * 100);
    const pctNew = Math.round(ratios.new * 100);
    palettePrompt = `
VOCABULARY PALETTE (aim for ~${pctKnown}% known / ~${pctReview}% review / ~${pctNew}% new by token count):
- KNOWN words — draw freely from this list; these form the backbone of the article: ${knownPalette.join('、') || '(rely on natural ' + jlptStr + ' and easier vocabulary)'}
- REVIEW words — work about ${targetReview} of these in where they fit the facts naturally: ${reviewPalette.join('、') || '(none)'}
- NEW words — introduce about ${targetNew} of these if the topic allows, and gloss any you use in a yugen-box: ${newPalette.join('、') || '(none)'}
Treat this palette as a GUIDE, not a quota. Never distort the facts or insert unnatural phrasing just to hit a word.`;
  }

  // Pass 1: Rewrite article
  return `
You are a factual Japanese news reporter writing a ${targetParagraphs}-paragraph news article for a JLPT ${jlptStr} learner.
LEVEL GUIDANCE: ${levelConfig.description}
Topic: ${title}
Sources (real English news text; the FIRST source is the primary story):
${sourceText}

SOURCE HANDLING: Build ONE coherent article around the first source as the main story. Where the other sources genuinely concern the same story, combine their overlapping facts and add their detail without repeating points. If a source is about a clearly different or unrelated story, IGNORE it — never stitch unrelated events together into one article.

GOLDEN RULE — FACTUAL FIDELITY OVERRIDES EVERYTHING ELSE (length, palette, style):
- Report ONLY the events, statements, and details present in the Sources above. DO NOT invent facts, quotes, statistics, reactions, sentiment, or motivations that are not in the Sources.
- DO NOT add an editorial or concluding sentence (speculation about significance, what it means, or what happens next) unless it is stated in the Sources.
- DO NOT pad to reach the paragraph target by fabricating filler. Reach the target by clearly explaining the facts that ARE in the Sources — not by adding new ones. If the Sources are too thin to fill ${targetParagraphs} paragraphs faithfully, write FEWER paragraphs; a shorter accurate article is always better than a padded one.
- DO NOT use abstract, poetic, or metaphorical language. Stick to facts.
${palettePrompt}

Rules:
1. Tone must be like a factual Japanese news broadcast.
2. Pick 1 or 2 important vocabulary words and explain them in English as a "yugen-box".
3. Provide the full Japanese text strings. DO NOT tokenize the text yet.
4. KANJI PREFERENCE: ${biasInstruction}
5. NATURAL ORTHOGRAPHY — OVERRIDES ALL KANJI PREFERENCE ABOVE: Spell every word the way a modern Japanese newspaper spells it. Words normally written in kana MUST stay in kana: その (never 其の), それ／それから (never 其れ／其れから), とても (never 迚も), いつも (never 何時も), また (never 亦／又), もの・こと・ため・とき when grammatical, できる, ある, いる, など, ください, よう. NEVER use rare, archaic, literary, or irregular kanji forms (the forms JMDict tags rK/oK/iK). NEVER use ateji for foreign words: write country names and loanwords in KATAKANA — カナダ (never 加奈陀), アメリカ (never 亜米利加), イギリス (never 英吉利). When unsure whether a kanji form is in common everyday use, choose kana. This rule is absolute even in study/balanced kanji-bias mode.
6. VOCABULARY PREFERENCE: ${vocabInstruction}
7. NO MARKUP: DO NOT use brackets [], parentheses (), or special formatting around Japanese words.

Output EXACTLY a JSON array:
[{"type":"paragraph"|"yugen-box","text":"...","keyword":"...","reading":"...","description":"..."}]
`;
}
