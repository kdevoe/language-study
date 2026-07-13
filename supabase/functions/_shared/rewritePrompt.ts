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
    knownPalette, reviewPalette, newPalette, vocabTargets, clusters,
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
  // Two shapes: the concept-cluster block (new input-side difficulty control) when the
  // caller supplies `clusters`, else the legacy flat known/review/new palette. The legacy
  // branch is kept byte-for-byte so the eval harness's frozen fixtures stay a valid
  // regression baseline (scripts/eval-article-rewrite.mjs).
  let palettePrompt = '';
  if (clusters && clusters.length > 0) {
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
5. VOCABULARY PREFERENCE: ${vocabInstruction}
6. NO MARKUP: DO NOT use brackets [], parentheses (), or special formatting around Japanese words.

Output EXACTLY a JSON array:
[{"type":"paragraph"|"yugen-box","text":"...","keyword":"...","reading":"...","description":"..."}]
`;
}
