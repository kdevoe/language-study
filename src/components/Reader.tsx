import React, { useState, useEffect } from 'react';
import { FuriganaText, HitWeight } from './FuriganaText';
import type { MasteryLevel } from '../services/store';
import { YugenBox } from './YugenBox';
import { WordModal, WordDetails } from './WordModal';
import {
  rewriteArticleWithGemini,
  fetchWordDefinitionQuick,
  fetchWordGrammarInsight,
  fetchSentenceTranslation,
  requestWorkPart,
  isPartInProgressError,
  saveWorkReadingPosition,
  NewsArticle
} from '../services/api';
import { supabase } from '../services/supabase';
import { enrichArticle, isEnriched } from '../services/enrich';
import { useAppStore } from '../services/store';
import { canonicalWordKey } from '../services/wordKey';
import { touchLock } from '../services/touchLock';
import { } from 'lucide-react'; // Empty block to show we're using icons elsewhere if needed, or just clear it.
// Actually, let's just remove the line if no icons are used.


interface ReaderProps {
  initialArticle?: any;
  onComplete?: () => void;
  /** Long-form: swap the Reader to the next part (App re-keys by article id). */
  onNextPart?: (article: NewsArticle) => void;
  /** Long-form invisible resume: pre-scroll so this block sits mid-screen. */
  resumeBlockIndex?: number;
}

const DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true';

async function resolveUserId(): Promise<string | null> {
  if (DEV_MODE) return 'dev-user';
  const { data: { session } } = await supabase.auth.getSession();
  return session?.user?.id ?? null;
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

export function Reader({ initialArticle, onComplete, onNextPart, resumeBlockIndex }: ReaderProps) {
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

  // ── Long-form parts (docs/long-form-content-design.md §3, §5) ─────────────
  // A part is a regular article whose content carries workId/partIndex/partCount.
  // Everything below is inert for news articles (workId absent).
  const workId: string | undefined = currentArticle?.workId;
  const partIndex: number = currentArticle?.partIndex ?? 1;
  const partCount: number = currentArticle?.partCount ?? 1;
  const hasNextPart = !!workId && partIndex < partCount;

  const [nextPartState, setNextPartState] = useState<'idle' | 'preparing' | 'ready' | 'failed'>('idle');
  const nextPartArticleRef = React.useRef<NewsArticle | null>(null);
  const jitFiredRef = React.useRef<string | null>(null); // article id JIT already fired for
  const posSaveTimerRef = React.useRef<number | null>(null);

  // JIT-prepare part N+1 (design §3: fired at ~60% of this part). Idempotent
  // per open part; polls through a server 409 (another invocation generating).
  const prepareNextPart = React.useCallback(async () => {
    if (!workId || !hasNextPart || !currentArticle?.id) return;
    if (jitFiredRef.current === currentArticle.id) return;
    jitFiredRef.current = currentArticle.id;
    const nextId = `lf-${workId}-p${partIndex + 1}`;
    const cached = useAppStore.getState().articlesCache[nextId];
    if (cached) {
      nextPartArticleRef.current = cached;
      setNextPartState('ready');
      return;
    }
    const userId = await resolveUserId();
    if (!userId) return;
    setNextPartState('preparing');
    const attempt = async (triesLeft: number): Promise<void> => {
      try {
        const article = await requestWorkPart(userId, workId, partIndex + 1);
        nextPartArticleRef.current = article;
        useAppStore.getState().saveProcessedArticle(article.id, article);
        setNextPartState('ready');
      } catch (e) {
        if (isPartInProgressError(e) && triesLeft > 0) {
          setTimeout(() => attempt(triesLeft - 1), 6000);
          return;
        }
        console.warn('[Reader] next-part preparation failed:', e);
        setNextPartState('failed');
      }
    };
    attempt(20);
  }, [workId, hasNextPart, partIndex, currentArticle?.id]);

  const retryNextPart = () => {
    jitFiredRef.current = null;
    setNextPartState('idle');
    prepareNextPart();
  };

  // Scroll: fire the JIT trigger past ~60%, and persist the reading position
  // (debounced) so reopening the work resumes invisibly (design §5).
  useEffect(() => {
    if (!workId || !currentArticle) return;
    const totalBlocks: number = currentArticle.blocks?.length ?? 0;
    const checkJit = () => {
      const progress = (window.scrollY + window.innerHeight) / Math.max(1, document.documentElement.scrollHeight);
      if (progress > 0.6 && hasNextPart) prepareNextPart();
    };
    const onScroll = () => {
      checkJit();
      if (posSaveTimerRef.current) clearTimeout(posSaveTimerRef.current);
      posSaveTimerRef.current = window.setTimeout(async () => {
        // First block still (partly) on screen = the reader's spot.
        const els = Array.from(contentRef.current?.querySelectorAll<HTMLElement>('[data-block-idx]') ?? []);
        if (els.length === 0) return;
        const at = els.find((el) => el.getBoundingClientRect().bottom > 120) ?? els[els.length - 1];
        const blockIndex = Number(at.dataset.blockIdx) || 0;
        const percent = Math.min(1, ((partIndex - 1) + (totalBlocks > 0 ? blockIndex / totalBlocks : 0)) / partCount);
        const userId = await resolveUserId();
        if (userId) saveWorkReadingPosition(workId, userId, { partIndex, blockIndex, percent });
      }, 1500);
    };
    // A part shorter than ~1.7 viewports never scrolls — check once on mount so
    // the next part still prepares. (Position saves stay scroll-driven so a
    // quick open/close can't overwrite a saved spot with block 0.)
    checkJit();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (posSaveTimerRef.current) clearTimeout(posSaveTimerRef.current);
    };
  }, [workId, currentArticle, hasNextPart, partIndex, partCount, prepareNextPart]);

  // Invisible resume (design §5): once this part's content is up, pre-scroll so
  // the first unread block sits mid-screen — a little read text above for
  // context, no marker. Runs once per article id (enrichment swaps keep the spot).
  const resumedForIdRef = React.useRef<string | null>(null);
  useEffect(() => {
    if (!currentArticle || currentArticle.id !== initialArticle?.id) return;
    if (!resumeBlockIndex || resumeBlockIndex <= 0) return;
    if (resumedForIdRef.current === currentArticle.id) return;
    resumedForIdRef.current = currentArticle.id;
    requestAnimationFrame(() => {
      const els = Array.from(contentRef.current?.querySelectorAll<HTMLElement>('[data-block-idx]') ?? []);
      if (els.length === 0) return;
      const el = els.find((e) => Number(e.dataset.blockIdx) >= resumeBlockIndex) ?? els[els.length - 1];
      const y = el.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.35;
      window.scrollTo({ top: Math.max(0, y) });
    });
  }, [currentArticle, initialArticle?.id, resumeBlockIndex]);

  // Grade one word as a 'skip' (read past without a lookup). Idempotent per article
  // session, and a no-op for words the reader tapped (those go through the click path).
  const gradeWordByKey = (key: string) => {
    if (gradedRef.current.has(key)) return;
    if (clickedWordsRef.current.has(key)) return;
    const token = wordPayloadsRef.current.get(key);
    if (!token) return;
    const details = token.details;
    const entryId = details?.jmdictEntryId || token.jmdict_entry_id;
    // Only an entry id makes a token dictionary-linked. Fallback details from a
    // partially-failed enrichment (reading-only, empty meaning, no entry id) must
    // not be trusted here: grading off them stored degraded records — conjugated
    // reading, blank meaning, no JLPT (→ stuck in Progress's "Other") — that can
    // never sync. While the article isn't fully enriched the link may still
    // arrive, so defer: leave the word un-marked and it grades correctly once
    // enrichment swaps in linked tokens and it scrolls into view again.
    const linked = !!entryId;
    if (!linked) {
      const blocks = useAppStore.getState().currentArticle?.blocks;
      if (blocks && !isEnriched(blocks)) return;
    }
    gradedRef.current.add(key);
    const jlptLevel = details?.jlptLevel;
    // Make sure a never-seen word exists before grading it (read latest store state).
    const existing = useAppStore.getState().wordDatabase[key];
    const surface = details?.word ?? token.lemma ?? token.text ?? key;
    if (!existing) {
      saveWordDefinition(key, linked && details
        ? { reading: details.reading, meaning: details.meaning, surface, jlptLevel: details.jlptLevel, jlptDerived: details.jlptDerived, freqRank: details.freqRank, furiganaMap: details.furiganaMap, pos: details.pos, jmdictEntryId: entryId }
        : { reading: details?.reading || '...', meaning: 'Implicitly parsed context', surface, furiganaMap: details?.furiganaMap, jmdictEntryId: entryId });
    } else if (linked && details && existing.jlptLevel == null && details.jlptLevel != null) {
      // Self-heal: the word was first stored before enrichment linked it (so it had
      // no JLPT and sat in Progress's "Other"). Now that we have dictionary details,
      // patch in the level and full definition.
      saveWordDefinition(key, { reading: details.reading, meaning: details.meaning, surface, jlptLevel: details.jlptLevel, jlptDerived: details.jlptDerived, freqRank: details.freqRank, furiganaMap: details.furiganaMap, pos: details.pos, jmdictEntryId: entryId });
    }
    recordWordSeen(key, true);
    // Count the read either way, but only seed a difficulty when the word is
    // dictionary-linked (entry id present). A wholly unlinkable word stays
    // ungraded rather than being guessed as hard.
    if (linked) applyDifficultyEvent(key, 'skip', jlptLevel);
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
    // Enriched tokens can carry an empty meaning — an unlinkable proper noun
    // (enrich.ts keeps its furigana but leaves meaning blank), or a JMDict entry
    // that came through glossless during article enrichment. Trusting it here
    // renders a permanent skeleton because this handler never fetches. Route to
    // the real lookup path instead — it fetches (with timeout + error state) and
    // honors the "tap falls back to dictionary-lookup" the enricher intended.
    if (!details.meaning) {
      handleDictionaryLookup(details.word, sentText, e, tokenId, details.jmdictEntryId);
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
            {partCount > 1 && <span>第{partIndex}部 / 全{partCount}部</span>}
            <span>{currentArticle.readTime}</span>
          </div>
          <h1 className="serif" style={{ fontSize: '2.5rem', lineHeight: 1.3, marginBottom: '2rem', color: 'var(--text-main)' }}>
            {currentArticle.title}
          </h1>
          <div style={{ width: '40px', height: '1px', backgroundColor: 'var(--text-muted)', marginBottom: '2rem' }} />
        </div>

        {currentArticle.blocks.map((block, i) => {
          // data-block-idx anchors long-form resume (invisible pre-scroll) and
          // the debounced reading-position save.
          if (block.type === 'paragraph') return <p key={i} data-block-idx={i} style={{ lineHeight: 2.2 }}>{renderParagraph(block, i)}</p>;
          if (block.type === 'yugen-box') return <YugenBox key={i} keyword={block.keyword!} reading={block.reading} description={block.description!} />;
          return null;
        })}

        {hasNextPart ? (
          /* Section break (design §5): replaces the 完了 capsule between parts —
             a quiet 部・完 line, overall percent, words-met recap, then the next
             part in the finish-button style (spinner while it JIT-prepares). */
          <div style={{ textAlign: 'center', marginTop: '4rem', marginBottom: 'calc(2rem + env(safe-area-inset-bottom))' }}>
            <div className="serif" style={{ fontSize: '1.25rem', color: 'var(--text-main)', marginBottom: '0.7rem' }}>第{partIndex}部・完</div>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.8 }}>
              作品全体の約{Math.round((partIndex / partCount) * 100)}%を読みました
              {(gradedRef.current.size + clickedWords.size) > 0 && (
                <><br />この部で出会った言葉 {gradedRef.current.size + clickedWords.size}語</>
              )}
            </div>
            <div style={{ width: '40px', height: '1px', backgroundColor: 'var(--text-muted)', margin: '1.8rem auto' }} />
            {nextPartState === 'ready' && nextPartArticleRef.current ? (
              <button
                onClick={() => onNextPart?.(nextPartArticleRef.current!)}
                style={{
                  backgroundColor: 'transparent',
                  color: 'var(--text-main)',
                  padding: '0.75rem 2.5rem',
                  borderRadius: '100px',
                  fontWeight: 600,
                  border: '1px solid var(--border-light)',
                  cursor: 'pointer'
                }}
              >
                <span className="serif" style={{ fontSize: '1.1rem', verticalAlign: 'middle' }}>続きを読む</span>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginLeft: '0.7rem', verticalAlign: 'middle' }}>第{partIndex + 1}部へ</span>
              </button>
            ) : nextPartState === 'failed' ? (
              <button
                onClick={retryNextPart}
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
                <span className="serif" style={{ fontSize: '1.1rem', verticalAlign: 'middle' }}>もう一度準備する</span>
              </button>
            ) : (
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.6rem', color: 'var(--text-muted)', fontSize: '0.85rem', padding: '0.75rem 1.5rem' }}>
                <span className="lucide-spin" style={{ width: '14px', height: '14px', border: '2px solid var(--border-light)', borderTopColor: 'var(--text-muted)', borderRadius: '50%', display: 'inline-block' }} />
                第{partIndex + 1}部を準備中…
              </div>
            )}
          </div>
        ) : (
          /* Finish capsule: marks the article/work done. */
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
        )}
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
