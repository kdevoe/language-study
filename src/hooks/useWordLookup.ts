import { useRef, useState } from 'react';
import type { WordDetails, GrammarView } from '../components/WordModal';
import { fetchWordDefinitionQuick, fetchWordGrammarInsight, fetchGrammarPointInsight, fetchSentenceTranslation, type InsightPoint } from '../services/api';
import { useAppStore } from '../services/store';
import { canonicalWordKey } from '../services/wordKey';
import { touchLock } from '../services/touchLock';
import { GRAMMAR_POINTS } from '../services/grammar/catalogue';
import type { GrammarHit } from '../services/grammar/reader';

// Word / sentence lookup shared by the Reader and the podcast player: tapping a
// token opens WordModal, records the lookup against SRS (a lookup means the word
// wasn't known), and lazily fetches the grammar insight; tapping a sentence end
// translates it. Extracted from Reader.tsx (docs/podcast-design.md §6.3).
//
// Grammar (#43): a grammar piece (ば, なりません, ので) opens the grammar panel
// instead, and a word that takes part in a point lists it under PATTERNS. Grammar
// opens never touch word SRS: no lookup is recorded, and opening the point from
// なりません doesn't count as looking up なる.

type TapEvent = React.MouseEvent<HTMLElement> | React.TouchEvent<HTMLElement>;

/** The word under a grammar piece, for the grammar panel's "As a word" link. */
export interface WordTarget {
  word: string;
  details?: WordDetails;
  jmdictEntryId?: string;
  sentText: string;
  patterns?: GrammarHit[];
}

const insightPoints = (hits?: GrammarHit[]): InsightPoint[] =>
  [...new Set((hits ?? []).map((h) => h.id))].flatMap((id) => {
    const p = GRAMMAR_POINTS[id];
    return p ? [{ pattern: p.pattern, meaning: p.meaning }] : [];
  });

export interface SelectedSentence {
  text: string;
  translation: string;
  id: string;
}

export function useWordLookup({ onWordTouched }: { onWordTouched?: (key: string) => void } = {}) {
  const [selectedWord, setSelectedWord] = useState<WordDetails | null>(null);
  const [selectedSentence, setSelectedSentence] = useState<SelectedSentence | null>(null);
  const [drawerAnchor, setDrawerAnchor] = useState<'top' | 'bottom'>('bottom');
  const [activeHighlightId, setActiveHighlightId] = useState<string | null>(null);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [isModalLoading, setIsModalLoading] = useState(false);
  // The selected word's grammar points (PATTERNS rows) and the 。 sentence's points.
  const [wordPatterns, setWordPatterns] = useState<GrammarHit[]>([]);
  const [sentencePoints, setSentencePoints] = useState<GrammarHit[]>([]);
  // Open grammar panels, newest last: ‹ pops back to the one before, then to the
  // word or sentence underneath (if any).
  const [grammarStack, setGrammarStack] = useState<GrammarView[]>([]);
  const grammarInsights = useRef(new Map<string, string>());
  // The sentence the open word was tapped in (ハルカに聞く passes it on).
  const [wordSentence, setWordSentence] = useState('');

  const wordDatabase = useAppStore((s) => s.wordDatabase);
  const saveWordDefinition = useAppStore((s) => s.saveWordDefinition);
  const recordWordSeen = useAppStore((s) => s.recordWordSeen);
  const setWordMastery = useAppStore((s) => s.setWordMastery);
  const setGrammarMastery = useAppStore((s) => s.setGrammarMastery);
  const applyDifficultyEvent = useAppStore((s) => s.applyDifficultyEvent);
  const mergeWordRecords = useAppStore((s) => s.mergeWordRecords);
  const insightSeq = useRef(0);

  // Grammar insights are contextual (they explain the word in *this* sentence), so
  // they're fetched fresh on every tap rather than served from wordDatabase — a
  // cached note from another article reads as wrong. The latest one is still saved
  // for the flashcard back. The sequence guard drops a slow response from an
  // earlier tap so it can't overwrite the current one.
  const loadGrammarInsight = (word: string, sentence: string, key: string, extra?: Partial<WordDetails> & { surface?: string }, patterns?: GrammarHit[]) => {
    const seq = ++insightSeq.current;
    fetchWordGrammarInsight(word, sentence, insightPoints(patterns)).then(insight => {
      if (seq !== insightSeq.current) return;
      setSelectedWord(prev => {
        if (!prev || prev.word !== word) return prev;
        return { ...prev, grammarNote: insight };
      });
      saveWordDefinition(key, { ...extra, grammarNote: insight });
    });
  };

  // The point's insight is about this sentence, so it's cached per sentence.
  const loadPointInsight = (view: GrammarView) => {
    const hit = view.hit;
    const point = GRAMMAR_POINTS[view.id];
    if (!hit || !point) return;
    const cacheKey = `${view.id}|${hit.sentence}`;
    const cached = grammarInsights.current.get(cacheKey);
    if (cached) { view.insight = cached; return; }
    fetchGrammarPointInsight(hit.sentence.slice(hit.start, hit.end), hit.sentence, { pattern: point.pattern, meaning: point.meaning })
      .then((insight) => {
        grammarInsights.current.set(cacheKey, insight);
        setGrammarStack((prev) => prev.map((v) => (v.hit === hit && v.id === view.id ? { ...v, insight } : v)));
      });
  };

  /** Where a tap was, for the panel's anchor and collision rule. Kept so a later
   *  open from inside the panel (As a word) can reuse it. */
  type Tap = { y: number; rect: DOMRect };
  const tapOf = (e: TapEvent): Tap => ({
    y: 'clientY' in e ? e.clientY : (e.touches?.[0]?.clientY || 0),
    rect: e.currentTarget.getBoundingClientRect(),
  });
  const lastTap = useRef<Tap | null>(null);

  const placeAt = (tap: Tap) => {
    lastTap.current = tap;
    // USER: "prefereably drop down from the top unless there is not enough space"
    // We favor Top anchor (Word at bottom half)
    // Threshold biased towards Top: if word is below 38vh, use Top.
    setDrawerAnchor(tap.y > window.innerHeight * 0.38 ? 'top' : 'bottom');
    setTargetRect(tap.rect);
  };

  /** A tap on the open piece closes the panel. */
  const toggledOff = (tokenId: string) => {
    if (activeHighlightId !== tokenId) return false;
    clearSelection();
    return true;
  };

  const openWord = (details: WordDetails, sentText: string, e: TapEvent, tokenId: string, patterns?: GrammarHit[]) => {
    if (touchLock.isLocked() || toggledOff(tokenId)) return;
    openWordAt(details, sentText, tapOf(e), tokenId, patterns);
  };

  const openWordAt = (details: WordDetails, sentText: string, tap: Tap, tokenId: string, patterns?: GrammarHit[]) => {
    // Enriched tokens can carry an empty meaning — an unlinkable proper noun
    // (enrich.ts keeps its furigana but leaves meaning blank), or a JMDict entry
    // that came through glossless during article enrichment. Trusting it here
    // renders a permanent skeleton because this handler never fetches. Route to
    // the real lookup path instead — it fetches (with timeout + error state) and
    // honors the "tap falls back to dictionary-lookup" the enricher intended.
    if (!details.meaning) {
      lookupWordAt(details.word, sentText, tap, tokenId, details.jmdictEntryId, patterns);
      return;
    }
    placeAt(tap);
    setWordSentence(sentText);
    // Track under the canonical key (entry_id when linked, else the surface/lemma),
    // so a click and a passive read of the same word land on one record (#39).
    const key = canonicalWordKey({ jmdictEntryId: details.jmdictEntryId, word: details.word });
    recordWordSeen(key);
    onWordTouched?.(key);

    setSelectedWord({ ...details, grammarNote: undefined });
    setSelectedSentence(null);
    setGrammarStack([]);
    setWordPatterns(patterns ?? []);
    setActiveHighlightId(tokenId);
    saveWordDefinition(key, { ...details, surface: details.word });
    // Looking a word up means it wasn't known: nudge its difficulty up.
    applyDifficultyEvent(key, 'click', details.jlptLevel);

    loadGrammarInsight(details.word, sentText, key, undefined, patterns);
  };

  const lookupWord = (word: string, contextSentence: string, e: TapEvent, tokenId: string, jmdictEntryId?: string, patterns?: GrammarHit[]) => {
    if (touchLock.isLocked() || toggledOff(tokenId)) return;
    lookupWordAt(word, contextSentence, tapOf(e), tokenId, jmdictEntryId, patterns);
  };

  const lookupWordAt = async (word: string, contextSentence: string, tap: Tap, tokenId: string, jmdictEntryId?: string, patterns?: GrammarHit[]) => {
    placeAt(tap);
    setWordSentence(contextSentence);
    // Canonical key: the entry_id when the token was already linked, else the surface
    // word (a lookup that discovers an id later re-keys onto it — see below) (#39).
    const key = canonicalWordKey({ jmdictEntryId, word });
    recordWordSeen(key);
    onWordTouched?.(key);
    setSelectedSentence(null);
    setGrammarStack([]);
    setWordPatterns(patterns ?? []);

    const localData = wordDatabase[key];
    // Self-healing: If we have local data but it's missing important metadata (JLPT or JMDict ID),
    // we allow the lookup to proceed to enrich the entry.
    if (localData && localData.meaning && localData.meaning !== 'Implicitly parsed context' && localData.jlptLevel && localData.jmdictEntryId) {
      applyDifficultyEvent(key, 'click', localData.jlptLevel);
      setSelectedWord({
        word,
        reading: localData.reading,
        meaning: localData.meaning,
        furiganaMap: localData.furiganaMap,
        jlptLevel: localData.jlptLevel,
        pos: localData.pos,
        jmdictEntryId: localData.jmdictEntryId
      });
      setActiveHighlightId(tokenId);

      loadGrammarInsight(word, contextSentence, key, undefined, patterns);
      return;
    }

    setSelectedWord({
      word,
      reading: '...',
      meaning: '',
      furiganaMap: Array.from(word).map(c => ({ kanji: c, kana: '' }))
    });
    setActiveHighlightId(tokenId);
    setIsModalLoading(true);

    try {
      // 1. QUICK PATH (JMDict Instant or Groq Fallback)
      const quickDef = await fetchWordDefinitionQuick(word, contextSentence, jmdictEntryId);
      const combinedInitial: WordDetails = {
        word,
        reading: quickDef.reading || '...',
        // Leave empty when the lookup genuinely returned no gloss — the modal
        // renders a terminal "no definition" state for that (a placeholder here
        // would masquerade as still-loading and never resolve).
        meaning: quickDef.meaning || '',
        furiganaMap: quickDef.furiganaMap,
        jlptLevel: quickDef.jlptLevel,
        pos: quickDef.pos,
        jmdictEntryId: quickDef.jmdictEntryId
      };
      setSelectedWord(combinedInitial);

      // The lookup may resolve an entry_id for a token that had none pre-linked. Its
      // canonical key is that id — migrate the surface-keyed record we just created
      // onto it so the word stays a single record (#39).
      const canonKey = canonicalWordKey({ jmdictEntryId: quickDef.jmdictEntryId || jmdictEntryId, word });
      if (canonKey !== key) {
        mergeWordRecords(key, canonKey);
        onWordTouched?.(canonKey); // keep grade-dedup aligned
      }

      // 2. SMART PATH (Claude Haiku) - contextual grammar insight, always fresh
      loadGrammarInsight(word, contextSentence, canonKey, { ...combinedInitial, surface: word }, patterns);

      // Cache initial quick data
      saveWordDefinition(canonKey, { ...combinedInitial, surface: word });
      // Now that the JLPT level is known, nudge difficulty up for this lookup.
      applyDifficultyEvent(canonKey, 'click', quickDef.jlptLevel);
      setIsModalLoading(false);
    } catch (err) {
      console.error("Word lookup failed:", err);
      const timedOut = /timed out/i.test(err instanceof Error ? err.message : String(err));
      const message = timedOut
        ? 'Lookup timed out — the server is busy. Try again in a moment.'
        : 'Lookup failed. Tap outside to dismiss.';
      setSelectedWord(prev => (prev && prev.word === word)
        ? { ...prev, reading: '—', meaning: message, grammarNote: '—' }
        : prev);
      setIsModalLoading(false);
    }
  };

  /** `context` is the surrounding text the translator gets for disambiguation;
   *  `points` the sentence's grammar, listed under the translation. */
  const translateSentence = async (sentence: string, sentenceId: string, e: TapEvent, context: string, points?: GrammarHit[]) => {
    if (touchLock.isLocked()) return;
    if (selectedSentence?.id === sentenceId && !grammarStack.length) {
      setSelectedSentence(null);
      return;
    }
    placeAt(tapOf(e));
    setSelectedWord(null);
    setGrammarStack([]);
    setSentencePoints(points ?? []);
    setSelectedSentence({ text: sentence, translation: '', id: sentenceId });
    setActiveHighlightId(sentenceId);
    setIsModalLoading(true);
    const translation = await fetchSentenceTranslation(sentence, context);
    setSelectedSentence({ text: sentence, translation, id: sentenceId });
    setIsModalLoading(false);
  };

  /** A tap on a grammar piece: the grammar panel leads. `asWord` is the word
   *  under the piece (なる under なりません), one tap away. */
  const openGrammar = (hit: GrammarHit, e: TapEvent, tokenId: string, asWord?: WordTarget) => {
    if (touchLock.isLocked() || toggledOff(tokenId)) return;
    placeAt(tapOf(e));
    setSelectedWord(null);
    setSelectedSentence(null);
    setActiveHighlightId(tokenId);
    const view: GrammarView = { id: hit.id, hit, asWord: asWord?.word };
    asWordRef.current = asWord ?? null;
    loadPointInsight(view);
    setGrammarStack([view]);
  };
  const asWordRef = useRef<WordTarget | null>(null);

  /** A PATTERNS row, a sentence's point, or a formal/casual partner: opens on top,
   *  with ‹ back to what was showing. */
  const pushGrammar = (id: string, hit?: GrammarHit) => {
    const view: GrammarView = { id, hit };
    loadPointInsight(view);
    setGrammarStack((prev) => [...prev, view]);
  };

  const popGrammar = () => setGrammarStack((prev) => prev.slice(0, -1));

  /** "As a word": the word under the grammar piece, opened (and counted) as a lookup. */
  const openAsWord = () => {
    const w = asWordRef.current;
    const tap = lastTap.current;
    if (!w || !tap || !activeHighlightId) return;
    if (w.details) openWordAt(w.details, w.sentText, tap, activeHighlightId, w.patterns);
    else lookupWordAt(w.word, w.sentText, tap, activeHighlightId, w.jmdictEntryId, w.patterns);
  };

  const topGrammar = grammarStack[grammarStack.length - 1];

  const setMastery = (level: 'hard' | 'medium' | 'easy') => {
    if (topGrammar) setGrammarMastery(topGrammar.id, level);
    else if (selectedWord) setWordMastery(canonicalWordKey({ jmdictEntryId: selectedWord.jmdictEntryId, word: selectedWord.word }), level);
  };

  const clearSelection = () => {
    setSelectedWord(null);
    setSelectedSentence(null);
    setGrammarStack([]);
    setActiveHighlightId(null);
  };

  // What ‹ goes back to: the panel underneath the open point.
  const backLabel = grammarStack.length > 1
    ? GRAMMAR_POINTS[grammarStack[grammarStack.length - 2].id]?.pattern
    : grammarStack.length === 1
      ? (selectedWord?.word ?? (selectedSentence ? '文' : undefined))
      : undefined;

  /** Props for <WordModal>, wired to this lookup state. */
  const modalProps = {
    isOpen: !!selectedWord || !!selectedSentence || !!topGrammar,
    onDismissStart: clearSelection,
    onClose: () => {
      clearSelection();
      touchLock.lock();
    },
    mode: (topGrammar ? 'grammar' : selectedSentence ? 'sentence' : 'word') as 'sentence' | 'word' | 'grammar',
    wordData: selectedWord,
    wordSentence,
    sentenceText: selectedSentence?.text,
    sentenceTranslation: selectedSentence?.translation,
    anchor: drawerAnchor,
    onSetMastery: setMastery,
    isLoading: isModalLoading,
    targetRect,
    grammar: topGrammar ? { ...topGrammar, backLabel } : null,
    patterns: wordPatterns,
    sentencePoints,
    onOpenPoint: pushGrammar,
    onGrammarBack: popGrammar,
    onAsWord: openAsWord,
  };

  return {
    activeHighlightId,
    /** The open point's span in the article, to light up. */
    litSpan: topGrammar?.hit?.lit ?? null,
    openGrammar,
    isOpen: modalProps.isOpen,
    openWord,
    lookupWord,
    translateSentence,
    clearSelection,
    modalProps,
  };
}
