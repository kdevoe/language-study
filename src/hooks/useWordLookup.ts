import { useState } from 'react';
import type { WordDetails } from '../components/WordModal';
import { fetchWordDefinitionQuick, fetchWordGrammarInsight, fetchSentenceTranslation } from '../services/api';
import { useAppStore } from '../services/store';
import { canonicalWordKey } from '../services/wordKey';
import { touchLock } from '../services/touchLock';

// Word / sentence lookup shared by the Reader and the podcast player: tapping a
// token opens WordModal, records the lookup against SRS (a lookup means the word
// wasn't known), and lazily fetches the grammar insight; tapping a sentence end
// translates it. Extracted from Reader.tsx (docs/podcast-design.md §6.3).

type TapEvent = React.MouseEvent<HTMLElement> | React.TouchEvent<HTMLElement>;

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

  const wordDatabase = useAppStore((s) => s.wordDatabase);
  const saveWordDefinition = useAppStore((s) => s.saveWordDefinition);
  const recordWordSeen = useAppStore((s) => s.recordWordSeen);
  const setWordMastery = useAppStore((s) => s.setWordMastery);
  const applyDifficultyEvent = useAppStore((s) => s.applyDifficultyEvent);
  const mergeWordRecords = useAppStore((s) => s.mergeWordRecords);

  const determineAnchor = (e: TapEvent) => {
    const y = 'clientY' in e ? e.clientY : (e.touches?.[0]?.clientY || 0);
    // USER: "prefereably drop down from the top unless there is not enough space"
    // We favor Top anchor (Word at bottom half)
    // Threshold biased towards Top: if word is below 38vh, use Top.
    setDrawerAnchor(y > window.innerHeight * 0.38 ? 'top' : 'bottom');
  };

  const openWord = (details: WordDetails, sentText: string, e: TapEvent, tokenId: string) => {
    if (touchLock.isLocked()) return;
    if (activeHighlightId === tokenId) {
      setActiveHighlightId(null);
      setSelectedWord(null);
      return;
    }
    // Enriched tokens can carry an empty meaning — an unlinkable proper noun
    // (enrich.ts keeps its furigana but leaves meaning blank), or a JMDict entry
    // that came through glossless during article enrichment. Trusting it here
    // renders a permanent skeleton because this handler never fetches. Route to
    // the real lookup path instead — it fetches (with timeout + error state) and
    // honors the "tap falls back to dictionary-lookup" the enricher intended.
    if (!details.meaning) {
      lookupWord(details.word, sentText, e, tokenId, details.jmdictEntryId);
      return;
    }
    determineAnchor(e);
    // Track under the canonical key (entry_id when linked, else the surface/lemma),
    // so a click and a passive read of the same word land on one record (#39).
    const key = canonicalWordKey({ jmdictEntryId: details.jmdictEntryId, word: details.word });
    recordWordSeen(key);
    onWordTouched?.(key);

    const cached = wordDatabase[key];
    const merged = { ...details, grammarNote: cached?.grammarNote || details.grammarNote };
    setSelectedWord(merged);
    setSelectedSentence(null);
    setActiveHighlightId(tokenId);
    setTargetRect(e.currentTarget.getBoundingClientRect());
    saveWordDefinition(key, { ...details, surface: details.word });
    // Looking a word up means it wasn't known: nudge its difficulty up.
    applyDifficultyEvent(key, 'click', details.jlptLevel);

    if (!merged.grammarNote) {
      fetchWordGrammarInsight(details.word, sentText).then(insight => {
        setSelectedWord(prev => {
          if (!prev || prev.word !== details.word) return prev;
          return { ...prev, grammarNote: insight };
        });
        saveWordDefinition(key, { grammarNote: insight });
      });
    }
  };

  const lookupWord = async (word: string, contextSentence: string, e: TapEvent, tokenId: string, jmdictEntryId?: string) => {
    if (touchLock.isLocked()) return;
    if (activeHighlightId === tokenId) {
      setActiveHighlightId(null);
      setSelectedWord(null);
      return;
    }
    determineAnchor(e);
    // Canonical key: the entry_id when the token was already linked, else the surface
    // word (a lookup that discovers an id later re-keys onto it — see below) (#39).
    const key = canonicalWordKey({ jmdictEntryId, word });
    recordWordSeen(key);
    onWordTouched?.(key);
    setSelectedSentence(null);
    const rect = e.currentTarget.getBoundingClientRect();

    const localData = wordDatabase[key];
    // Self-healing: If we have local data but it's missing important metadata (JLPT or JMDict ID),
    // we allow the lookup to proceed to enrich the entry.
    if (localData && localData.meaning && localData.meaning !== 'Implicitly parsed context' && localData.jlptLevel && localData.jmdictEntryId) {
      applyDifficultyEvent(key, 'click', localData.jlptLevel);
      setSelectedWord({
        word,
        reading: localData.reading,
        meaning: localData.meaning,
        grammarNote: localData.grammarNote,
        furiganaMap: localData.furiganaMap,
        jlptLevel: localData.jlptLevel,
        pos: localData.pos,
        jmdictEntryId: localData.jmdictEntryId
      });
      setActiveHighlightId(tokenId);
      setTargetRect(rect);

      if (!localData.grammarNote) {
        fetchWordGrammarInsight(word, contextSentence).then(insight => {
          setSelectedWord(prev => {
            if (!prev || prev.word !== word) return prev;
            return { ...prev, grammarNote: insight };
          });
          saveWordDefinition(key, { grammarNote: insight });
        });
      }
      return;
    }

    setSelectedWord({
      word,
      reading: '...',
      meaning: '',
      furiganaMap: Array.from(word).map(c => ({ kanji: c, kana: '' }))
    });
    setSelectedSentence(null);
    setTargetRect(rect);
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

      // 2. SMART PATH (Gemini 3 Flash) - Parallel Context Analysis
      fetchWordGrammarInsight(word, contextSentence).then((insight) => {
        setSelectedWord(prev => {
          if (!prev || prev.word !== word) return prev;
          return { ...prev, grammarNote: insight };
        });
        // Cache the full enriched result
        saveWordDefinition(canonKey, { ...combinedInitial, surface: word, grammarNote: insight });
      });

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

  /** `context` is the surrounding text the translator gets for disambiguation. */
  const translateSentence = async (sentence: string, sentenceId: string, e: TapEvent, context: string) => {
    if (touchLock.isLocked()) return;
    if (selectedSentence?.id === sentenceId) {
      setSelectedSentence(null);
      return;
    }
    determineAnchor(e);
    setSelectedWord(null);
    setSelectedSentence({ text: sentence, translation: '', id: sentenceId });
    setTargetRect(e.currentTarget.getBoundingClientRect());
    setActiveHighlightId(sentenceId);
    setIsModalLoading(true);
    const translation = await fetchSentenceTranslation(sentence, context);
    setSelectedSentence({ text: sentence, translation, id: sentenceId });
    setIsModalLoading(false);
  };

  const setMastery = (level: 'hard' | 'medium' | 'easy') => {
    if (selectedWord) setWordMastery(canonicalWordKey({ jmdictEntryId: selectedWord.jmdictEntryId, word: selectedWord.word }), level);
  };

  const clearSelection = () => {
    setSelectedWord(null);
    setSelectedSentence(null);
    setActiveHighlightId(null);
  };

  /** Props for <WordModal>, wired to this lookup state. */
  const modalProps = {
    isOpen: !!selectedWord || !!selectedSentence,
    onDismissStart: clearSelection,
    onClose: () => {
      clearSelection();
      touchLock.lock();
    },
    mode: (selectedSentence ? 'sentence' : 'word') as 'sentence' | 'word',
    wordData: selectedWord,
    sentenceText: selectedSentence?.text,
    sentenceTranslation: selectedSentence?.translation,
    anchor: drawerAnchor,
    onSetMastery: setMastery,
    isLoading: isModalLoading,
    targetRect,
  };

  return {
    activeHighlightId,
    isOpen: modalProps.isOpen,
    openWord,
    lookupWord,
    translateSentence,
    clearSelection,
    modalProps,
  };
}
