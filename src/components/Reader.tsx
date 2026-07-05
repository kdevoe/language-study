import React, { useState, useEffect } from 'react';
import { FuriganaText, HitWeight } from './FuriganaText';
import type { MasteryLevel } from '../services/store';
import { YugenBox } from './YugenBox';
import { WordModal, WordDetails } from './WordModal';
import {
  rewriteArticleWithGemini,
  fetchWordDefinitionQuick,
  fetchWordGrammarInsight,
  fetchSentenceTranslation
} from '../services/api';
import { enrichArticle, isEnriched } from '../services/enrich';
import { useAppStore } from '../services/store';
import { canonicalWordKey } from '../services/wordKey';
import { touchLock } from '../services/touchLock';
import { } from 'lucide-react'; // Empty block to show we're using icons elsewhere if needed, or just clear it.
// Actually, let's just remove the line if no icons are used.


interface ReaderProps {
  initialArticle?: any;
  onComplete?: () => void;
}

// Minimal shape needed to grade a word: definition details (for a never-seen word)
// and a jmdict id fallback. Article tokens carry more, but this is all grading reads.
type GradeToken = { details?: WordDetails; jmdict_entry_id?: string; lemma?: string; text?: string };

// Deterministic tap-target sizing. Kanji content words (furigana present) are
// the ones users actually look up, so they get the widest hit area; short kana
// tokens are almost always particles/grammatical glue, so they yield to their
// neighbors. Already-mastered words don't need a big target either.
function hitWeightFor(text: string, furigana?: string, mastery?: MasteryLevel): HitWeight {
  const hasKanji = !!furigana && furigana.trim() !== '';
  if (hasKanji) return mastery === 'easy' ? 'mid' : 'hi';
  return [...text].length <= 2 ? 'lo' : 'mid';
}

export function Reader({ initialArticle, onComplete }: ReaderProps) {
  const [selectedWord, setSelectedWord] = useState<WordDetails | null>(null);
  const [selectedSentence, setSelectedSentence] = useState<{ text: string, translation: string, id: string } | null>(null);
  const [drawerAnchor, setDrawerAnchor] = useState<'top' | 'bottom'>('bottom');
  const [activeHighlightId, setActiveHighlightId] = useState<string | null>(null);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState<string>("Initializing feed...");
  const [loadingArticleTitle, setLoadingArticleTitle] = useState<string>("");
  const [isModalLoading, setIsModalLoading] = useState(false);
  
  const [clickedWords, setClickedWords] = useState<Set<string>>(new Set());

  // ── Grade-on-visible ──────────────────────────────────────────────────────
  // A word is graded ('skip') once it has been FULLY on screen (no partial clip)
  // for a short dwell, so reading is tracked wherever the reader leaves off — not
  // only on reaching the end. Replaces the old end-of-article sweep, which graded
  // every word whether or not it was ever scrolled into view.
  const DWELL_MS = 500; // must stay fully visible this long to count as "read"
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const visObserverRef = React.useRef<IntersectionObserver | null>(null);
  const dwellTimersRef = React.useRef<Map<string, number>>(new Map());
  const gradedRef = React.useRef<Set<string>>(new Set());
  const gradedArticleIdRef = React.useRef<string | null>(null);
  // Richest token per gradeable lemma in the current article (carries details /
  // jmdict id so a never-seen word can be stored and JLPT-seeded).
  const wordPayloadsRef = React.useRef<Map<string, GradeToken>>(new Map());
  // Latest clickedWords / grader for the observer callbacks, mirrored into refs so
  // the observer never has to re-subscribe.
  const clickedWordsRef = React.useRef(clickedWords);
  const gradeRef = React.useRef<(key: string) => void>(() => {});

  const segmenter = React.useMemo(() => {
    try {
      return new (Intl as any).Segmenter('ja-JP', { granularity: 'word' });
    } catch { return null; }
  }, []);
  
  // Narrow, per-field subscriptions so the Reader re-renders ONLY when something it
  // actually renders changes. The old selector-less `useAppStore()` subscribed to the
  // whole store, so any background `articlesCache` write (the server buffer surfacing a
  // freshly-produced article mid-session) re-rendered the open Reader for nothing.
  // `articlesCache` is read imperatively in `loadArticle` (once, at open) — it needs no
  // reactive subscription. Actions are stable references in Zustand, so subscribing to
  // them never triggers a re-render.
  const currentArticle = useAppStore(s => s.currentArticle);
  const wordDatabase = useAppStore(s => s.wordDatabase);
  const readerFontSize = useAppStore(s => s.readerFontSize);
  const readerFontWeight = useAppStore(s => s.readerFontWeight);
  const saveWordDefinition = useAppStore(s => s.saveWordDefinition);
  const recordWordSeen = useAppStore(s => s.recordWordSeen);
  const setWordMastery = useAppStore(s => s.setWordMastery);
  const applyDifficultyEvent = useAppStore(s => s.applyDifficultyEvent);
  const mergeWordRecords = useAppStore(s => s.mergeWordRecords);
  const setCurrentArticle = useAppStore(s => s.setCurrentArticle);
  const saveProcessedArticle = useAppStore(s => s.saveProcessedArticle);

  // Keep the observer's view of mutable state fresh without re-creating it.
  clickedWordsRef.current = clickedWords;

  // Grade one word as a 'skip' (read past without a lookup). Idempotent per article
  // session, and a no-op for words the reader tapped (those go through the click path).
  const gradeWordByKey = (key: string) => {
    if (gradedRef.current.has(key)) return;
    if (clickedWordsRef.current.has(key)) return;
    const token = wordPayloadsRef.current.get(key);
    if (!token) return;
    const details = token.details;
    const entryId = details?.jmdictEntryId || token.jmdict_entry_id;
    // Don't grade off a raw, un-enriched token: with no dictionary link the JLPT
    // is unknown, so seeding difficulty here would assume the word is hard (and it
    // can't sync without an entry id). If the article hasn't been dictionary-linked
    // yet, defer — leave the word un-marked so it grades correctly once enrichment
    // swaps in linked tokens and it scrolls into view again.
    if (!details && !entryId) {
      const blocks = useAppStore.getState().currentArticle?.blocks;
      if (blocks && !isEnriched(blocks)) return;
    }
    gradedRef.current.add(key);
    const jlptLevel = details?.jlptLevel;
    // Make sure a never-seen word exists before grading it (read latest store state).
    const existing = useAppStore.getState().wordDatabase[key];
    const surface = details?.word ?? token.lemma ?? token.text ?? key;
    if (!existing) {
      saveWordDefinition(key, details
        ? { reading: details.reading, meaning: details.meaning, surface, jlptLevel: details.jlptLevel, jlptDerived: details.jlptDerived, furiganaMap: details.furiganaMap, pos: details.pos, jmdictEntryId: details.jmdictEntryId || token.jmdict_entry_id }
        : { reading: '...', meaning: 'Implicitly parsed context', surface, jmdictEntryId: token.jmdict_entry_id });
    } else if (details && existing.jlptLevel == null && details.jlptLevel != null) {
      // Self-heal: the word was first stored before enrichment linked it (so it had
      // no JLPT and sat in Progress's "Other"). Now that we have dictionary details,
      // patch in the level and full definition.
      saveWordDefinition(key, { reading: details.reading, meaning: details.meaning, surface, jlptLevel: details.jlptLevel, jlptDerived: details.jlptDerived, furiganaMap: details.furiganaMap, pos: details.pos, jmdictEntryId: details.jmdictEntryId || token.jmdict_entry_id });
    }
    recordWordSeen(key, true);
    // Count the read either way, but only seed a difficulty when the word is
    // dictionary-linked (official or freq-derived JLPT). A wholly unlinkable word
    // stays ungraded rather than being guessed as hard.
    if (details || entryId) applyDifficultyEvent(key, 'skip', jlptLevel);
  };
  gradeRef.current = gradeWordByKey;

  // Stable ref callback so re-renders don't churn observation. Reads each word's key
  // from data-grade-key, so one shared function serves every word element.
  const observeWord = React.useCallback((el: HTMLElement | null) => {
    if (el) visObserverRef.current?.observe(el);
  }, []);

  // Tracks the article currently being loaded so a slow background enrichment
  // from a previous article can't clobber a newer one the reader switched to.
  const loadIdRef = React.useRef<string | null>(null);

  // Tokenize + dictionary-link the article on the client, then swap in the
  // enriched blocks and cache them. Runs in the background so the raw text shows
  // immediately (sub-second flash on the very first session, then dict-cached).
  const enrichInBackground = (article: any) => {
    if (!article || isEnriched(article.blocks)) return;
    const loadId = article.id ?? null;
    enrichArticle(article.blocks)
      .then((blocks) => {
        if (loadIdRef.current !== loadId) return; // reader moved on
        const enriched = { ...article, blocks };
        setCurrentArticle(enriched);
        if (article.id) saveProcessedArticle(article.id, enriched);
      })
      .catch((e) => console.warn('[Reader] enrichment failed:', e));
  };

  const loadArticle = async () => {
    loadIdRef.current = initialArticle?.id ?? null;

    // 1. Check Cache first for instant return. Read imperatively — the Reader has no
    // reactive subscription to articlesCache (see the store hooks above).
    const articlesCache = useAppStore.getState().articlesCache;
    if (initialArticle?.id && articlesCache[initialArticle.id]) {
      const cached = articlesCache[initialArticle.id];
      setCurrentArticle(cached);
      setLoading(false);
      enrichInBackground(cached);
      return;
    }

    // 2. Atomic state clearing
    setCurrentArticle(null);
    setLoading(true);
    setLoadingStep("Initializing reader...");
    setLoadingArticleTitle(initialArticle?.title || "読書家");
    setClickedWords(new Set());
    setSelectedWord(null);
    setSelectedSentence(null);
    setActiveHighlightId(null);
    

      
      
    // Use the specific article passed from the Hub
    const selectedRaw = initialArticle;

    if (selectedRaw) {
      setLoadingArticleTitle(selectedRaw.title);
      // Snippet for rewriting (limit to first block for speed)
      const snippet = selectedRaw.blocks?.[0]?.content?.[0]?.text || '';
      const rewrittenBlocks = await rewriteArticleWithGemini(
        selectedRaw.title, snippet, (step) => setLoadingStep(step)
      );
      const processed = { ...selectedRaw, blocks: rewrittenBlocks };
      setCurrentArticle(processed);
      // 3. Save to cache for next time
      if (selectedRaw.id) saveProcessedArticle(selectedRaw.id, processed);
      // 4. Tokenize + dictionary-link on the client, then swap in enriched blocks.
      enrichInBackground(processed);
    } else {
      // Emergency Fallback
      setLoading(false);
    }
    setLoading(false);
  };

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  // Each Reader instance is keyed to one article (App keys <Reader> by id), so load
  // THIS article on mount. Keying the load off `initialArticle.id` — rather than the
  // global `currentArticle` being null — means the feed no longer has to blank the
  // shared currentArticle to trigger a load, which used to flash the article you were
  // reading down to a spinner the instant you tapped a different one.
  useEffect(() => {
    if (currentArticle?.id !== initialArticle?.id) loadArticle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialArticle?.id]);

  // Build the gradeable-word payload map for the article: the richest token per
  // lemma (details/jmdict id win), so a word can be stored and JLPT-seeded on grade.
  // Rebuilds when enrichment swaps in linked blocks.
  useEffect(() => {
    const map = new Map<string, GradeToken>();
    currentArticle?.blocks.forEach(b => {
      if (b.content) b.content.forEach(w => {
        if (!w.isInteractive && !w.furigana) return;
        // Canonical key: entry_id when linked (collapses conjugations/variants of one
        // entry), else lemma/surface. Matches the grade-key and clickedWords sets.
        const key = canonicalWordKey({ jmdictEntryId: w.details?.jmdictEntryId || w.jmdict_entry_id, lemma: w.lemma, word: w.details?.word, text: w.text });
        const existing = map.get(key);
        if (!existing || (!existing.details && (w.details || w.jmdict_entry_id))) map.set(key, w);
      });
    });
    wordPayloadsRef.current = map;
  }, [currentArticle]);

  // Watch every fully-visible word; grade it once it has dwelled on screen. This is
  // the sole grading path — words never scrolled into view stay ungraded by design.
  useEffect(() => {
    if (!currentArticle) return;

    // Reset session state only when the article itself changes, so a mid-read
    // enrichment swap (same id, new object) doesn't re-grade what's already done.
    const id = currentArticle.id ?? null;
    if (gradedArticleIdRef.current !== id) {
      gradedArticleIdRef.current = id;
      gradedRef.current = new Set();
    }
    const timers = dwellTimersRef.current; // stable across this effect's lifetime
    timers.forEach((t) => clearTimeout(t));
    timers.clear();

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        const key = el.dataset.gradeKey;
        if (!key) continue;
        // threshold 1.0 => the whole word box is inside the viewport (no partial clip).
        const fullyVisible = entry.isIntersecting && entry.intersectionRatio >= 0.999;
        if (fullyVisible) {
          if (gradedRef.current.has(key)) { observer.unobserve(el); continue; }
          if (!timers.has(key)) {
            const timer = window.setTimeout(() => {
              timers.delete(key);
              gradeRef.current(key);
              observer.unobserve(el); // graded — stop watching this word
            }, DWELL_MS);
            timers.set(key, timer);
          }
        } else {
          // Scrolled away before the dwell completed — didn't actually read it.
          const timer = timers.get(key);
          if (timer) { clearTimeout(timer); timers.delete(key); }
        }
      }
    }, { threshold: [1.0] });

    visObserverRef.current = observer;
    // Observe words already in the DOM; observeWord handles ones mounted later.
    contentRef.current?.querySelectorAll<HTMLElement>('[data-grade-key]').forEach((el) => observer.observe(el));

    return () => {
      observer.disconnect();
      visObserverRef.current = null;
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, [currentArticle]);

  const determineAnchor = (e: any) => {
    const y = 'clientY' in e ? e.clientY : (e.touches?.[0]?.clientY || 0);
    // USER: "prefereably drop down from the top unless there is not enough space"
    // We favor Top anchor (Word at bottom half)
    // Threshold biased towards Top: if word is below 38vh, use Top.
    setDrawerAnchor(y > window.innerHeight * 0.38 ? 'top' : 'bottom');
  };

  const handleWordClick = (details: WordDetails, sentText: string, e: any, tokenId: string) => {
    if (touchLock.isLocked()) return;
    if (activeHighlightId === tokenId) {
      setActiveHighlightId(null);
      setSelectedWord(null);
      return;
    }
    determineAnchor(e);
    // Track under the canonical key (entry_id when linked, else the surface/lemma),
    // so a click and a passive read of the same word land on one record (#39).
    const key = canonicalWordKey({ jmdictEntryId: details.jmdictEntryId, word: details.word });
    recordWordSeen(key);
    setClickedWords(prev => new Set(prev).add(key));

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

  const handleDictionaryLookup = async (word: string, contextSentence: string, e: any, tokenId: string, jmdictEntryId?: string) => {
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
    setClickedWords(prev => new Set(prev).add(key));
    setSelectedSentence(null);

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
      setTargetRect(e.currentTarget.getBoundingClientRect());

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
    setTargetRect(e.currentTarget.getBoundingClientRect());
    setActiveHighlightId(tokenId);
    setIsModalLoading(true);

    try {
      // 1. QUICK PATH (JMDict Instant or Groq Fallback)
      const quickDef = await fetchWordDefinitionQuick(word, contextSentence, jmdictEntryId);
      const combinedInitial: WordDetails = {
        word,
        reading: quickDef.reading || '...',
        meaning: quickDef.meaning || 'Looking up...',
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
        setClickedWords(prev => new Set(prev).add(canonKey)); // keep grade-dedup aligned
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

  const handleSentenceTranslate = async (sentence: string, sentenceId: string, e: any) => {
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
    const translation = await fetchSentenceTranslation(sentence, currentArticle?.blocks.map(b => b.content?.map(c => c.text).join('')).join('\n') || '');
    setSelectedSentence({ text: sentence, translation, id: sentenceId });
    setIsModalLoading(false);
  };

  const handleSetMastery = (level: 'hard' | 'medium' | 'easy') => {
    if (selectedWord) setWordMastery(canonicalWordKey({ jmdictEntryId: selectedWord.jmdictEntryId, word: selectedWord.word }), level);
  };

  const renderParagraph = (block: any, blockIdx: number) => {
    // Before client enrichment finishes, a block may carry only raw text — render
    // it as one segment so the text (and sentence-tap) work during the brief flash.
    const content: any[] = block.content ?? (block.text ? [{ text: block.text }] : []);

    // 1. Group tokens into sentences
    const sentences: any[][] = [];
    let currentSent: any[] = [];
    content.forEach((seg: any) => {
      currentSent.push(seg);
      if (seg.text.match(/[。！？\n]/)) {
        sentences.push(currentSent);
        currentSent = [];
      }
    });
    if (currentSent.length > 0) sentences.push(currentSent);

    return sentences.map((sentTokens, sIdx) => {
      const sentText = sentTokens.map(t => t.text).join('');
      const sentenceId = `${blockIdx}-${sIdx}`;

      // Render a run of non-interactive text, turning sentence-ending marks
      // (。！？) into tap targets that translate the whole sentence. Single-tap on
      // a word stays word-lookup; tapping the period is the non-conflicting way to
      // pull up the sentence (the double-tap gesture loses to the word's onClick).
      const renderText = (text: string, keyBase: string) =>
        text.split(/([。！？])/).filter(s => s !== '').map((part, idx) =>
          /[。！？]/.test(part) ? (
            <span
              key={`${keyBase}-p${idx}`}
              onClick={(e) => handleSentenceTranslate(sentText, sentenceId, e)}
              style={{ cursor: 'pointer', padding: '0 0.25em', margin: '0 -0.1em' }}
            >
              {part}
            </span>
          ) : (
            <span key={`${keyBase}-t${idx}`}>{part}</span>
          ),
        );

      return (
        <span 
          key={sentenceId} 
          className={activeHighlightId === sentenceId ? 'sentence-highlight' : ''}
          onDoubleClick={(e) => handleSentenceTranslate(sentText, sentenceId, e)}
        >
          {sentTokens.map((segment, j) => {
            if (segment.furigana || segment.isInteractive) {
              // Canonical key (entry_id when linked, else lemma/surface) — must match
              // the payload map and clickedWords so grading dedups correctly.
              const gradeKey = canonicalWordKey({ jmdictEntryId: segment.details?.jmdictEntryId || segment.jmdict_entry_id, lemma: segment.lemma, word: segment.details?.word, text: segment.text });
              return (
                // Inline wrapper carries the grade key and is the intersection target,
                // so "fully visible for a dwell" grades this word (see grade-on-visible).
                <span key={`${sentenceId}-${j}`} ref={observeWord} data-grade-key={gradeKey} style={{ display: 'inline' }}>
                  <FuriganaText
                    word={segment.text}
                    furigana={segment.furigana}
                    hitWeight={hitWeightFor(segment.text, segment.furigana, wordDatabase[gradeKey]?.mastery)}
                    isSelected={activeHighlightId === `${sentenceId}-${j}`}
                    onClick={(e) => {
                      const tid = `${sentenceId}-${j}`;
                      if (segment.details) handleWordClick(segment.details as WordDetails, sentText, e, tid);
                      // Look up by lemma (鎮める) when we have it, not the surface form (鎮めて).
                      else handleDictionaryLookup(segment.lemma ?? segment.text, sentText, e, tid, segment.jmdict_entry_id);
                    }}
                  />
                </span>
              );
            }
            if (segmenter) {
              const words = Array.from((segmenter as any).segment(segment.text));
              return words.map((w: any, index: number) => {
                if (!w.isWordLike) return <span key={`${sentenceId}-${j}-${index}`}>{renderText(w.segment, `${sentenceId}-${j}-${index}`)}</span>;
                const isWide = [...w.segment].length > 2;
                return (
                  <span
                    key={`${sentenceId}-${j}-${index}`}
                    className={activeHighlightId === `${sentenceId}-${j}-${index}` ? 'word-highlight' : ''}
                    onClick={(e) => handleDictionaryLookup(w.segment, sentText, e, `${sentenceId}-${j}-${index}`)}
                    style={{
                      cursor: 'pointer',
                      position: 'relative',
                      ...(isWide
                        ? { paddingLeft: '0.15em', paddingRight: '0.15em', marginLeft: '-0.15em', marginRight: '-0.15em', zIndex: 2 }
                        : { zIndex: 1 }),
                    }}
                  >
                    {w.segment}
                  </span>
                );
              });
            }
            return <span key={`${sentenceId}-${j}`}>{renderText(segment.text, `${sentenceId}-${j}`)}</span>;
          })}
        </span>
      );
    });
  };

  // Render content only when the loaded article IS this Reader's article. On mount the
  // shared `currentArticle` may still hold the PREVIOUS article for a frame (until the
  // load effect runs) — gating on identity shows this article's loading state instead
  // of briefly flashing the old article's text under the new one.
  if (loading || !currentArticle || currentArticle.id !== initialArticle?.id) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', minHeight: '60vh', textAlign: 'center', padding: '0 2rem' }}>
        <div className="lucide-spin" style={{ color: 'var(--text-main)', marginBottom: '1.5rem', width: '32px', height: '32px', border: '3px solid var(--border-light)', borderTopColor: 'var(--text-main)', borderRadius: '50%' }} />
        <h2 className="serif fade-in" style={{ fontSize: '1.25rem', color: 'var(--text-main)', marginBottom: '1rem' }}>{loadingArticleTitle || '読書家'}</h2>
        <div className="fade-in" style={{ padding: '1rem 1.5rem', backgroundColor: 'var(--bg-card)', borderRadius: '16px', width: '100%', maxWidth: '400px' }}>
          <p style={{ color: 'var(--text-main)', fontSize: '0.9rem', fontWeight: 600, fontFamily: 'monospace' }}>{loadingStep}</p>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* key pins the fade-in to the article identity: `enrichInBackground` swaps in a
          NEW currentArticle object (same id) once readings are linked, mid-read. Keying
          by id lets React reconcile in place across that swap — the furigana appears
          without remounting, so the `fade-in` animation never replays as a flash. The
          animation plays only on a genuine open (the loading → loaded branch flip). */}
      <div key={currentArticle.id} ref={contentRef} className="reading-content fade-in" style={{ paddingBottom: 0, fontSize: `${readerFontSize || 18}px`, fontWeight: readerFontWeight || 500 }}>
        <div style={{ marginBottom: '3rem' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '1rem', display: 'flex', gap: '1rem' }}>
            <span style={{ backgroundColor: 'var(--bg-card)', padding: '0.2rem 0.6rem', borderRadius: '4px' }}>{currentArticle.category}</span>
            <span>{currentArticle.readTime}</span>
          </div>
          <h1 className="serif" style={{ fontSize: '2.5rem', lineHeight: 1.3, marginBottom: '2rem', color: 'var(--text-main)' }}>
            {currentArticle.title}
          </h1>
          <div style={{ width: '40px', height: '1px', backgroundColor: 'var(--text-muted)', marginBottom: '2rem' }} />
        </div>

        {currentArticle.blocks.map((block, i) => {
          if (block.type === 'paragraph') return <p key={i} style={{ lineHeight: 2.2 }}>{renderParagraph(block, i)}</p>;
          if (block.type === 'yugen-box') return <YugenBox key={i} keyword={block.keyword!} reading={block.reading} description={block.description!} />;
          return null;
        })}

        {/* Finish capsule: marks the article done and removes it from the feed. */}
        <div style={{ textAlign: 'center', marginTop: '4rem', marginBottom: 'calc(2rem + env(safe-area-inset-bottom))' }}>
           <button
             onClick={() => onComplete?.()}
             style={{
               backgroundColor: 'transparent',
               color: 'var(--text-muted)',
               padding: '0.75rem 2.5rem',
               borderRadius: '100px',
               fontWeight: 600,
               border: '1px solid var(--border-light)',
               cursor: 'pointer'
             }}
           >
             <span className="serif" style={{ fontSize: '1.25rem', verticalAlign: 'middle' }}>完了</span>
           </button>
        </div>
      </div>

      <WordModal 
        isOpen={!!selectedWord || !!selectedSentence} 
        onDismissStart={() => {
          setSelectedWord(null);
          setSelectedSentence(null);
          setActiveHighlightId(null);
        }}
        onClose={() => { 
          setSelectedWord(null); 
          setSelectedSentence(null); 
          setActiveHighlightId(null);
          touchLock.lock();
        }} 
        mode={selectedSentence ? 'sentence' : 'word'}
        wordData={selectedWord}
        sentenceText={selectedSentence?.text}
        sentenceTranslation={selectedSentence?.translation}
        anchor={drawerAnchor}
        onSetMastery={handleSetMastery}
        isLoading={isModalLoading}
        targetRect={targetRect}
      />
    </>
  );
}
