import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { rtkKanjiList } from '../data/rtkKanji';
import { captureError } from './monitoring';
import { NewsArticle } from './api';
import { supabase } from './supabase';
import { schedule, ratingForReaderEvent, readerEventMayAdvance, seedSrsFromDifficulty, type SrsState, type SrsStatus, type Rating, type AdjustReason } from './srs';
import { decidePacing, isActiveForPacing } from './pacing';
import { alignReading, hasKanji, loadReadingData } from './furigana';
import { selectPromotions, type IntakeItem, type IntakeCandidate } from './intake';
import { TOMBSTONED_WORD_IDS, RECOVERABLE_WORD_IDS } from './vocabCleanup';

export type MasteryLevel = 'unseen' | 'hard' | 'medium' | 'easy';

// Internal difficulty is the source of truth: 1 = easiest for this user, 10 = hardest.
// The three user-facing buckets (easy/medium/hard) are derived from it so the UI and
// the article-generation pipeline (which reads mastery_level) stay simple.
export const DIFFICULTY_MIN = 1;
export const DIFFICULTY_MAX = 10;

const clampDifficulty = (n: number) =>
  Math.max(DIFFICULTY_MIN, Math.min(DIFFICULTY_MAX, Math.round(n)));

export function bucketForDifficulty(difficulty: number): Exclude<MasteryLevel, 'unseen'> {
  if (difficulty <= 3) return 'easy';
  if (difficulty <= 7) return 'medium';
  return 'hard';
}

// Manual selection snaps to the midpoint of the chosen bucket, so a couple of
// passive nudges stay inside the bucket before crossing into the next one.
export function difficultyForBucket(level: MasteryLevel): number {
  switch (level) {
    case 'easy': return 2;
    case 'hard': return 9;
    default: return 5; // medium / unseen
  }
}

// Seed an initial difficulty from a word's JLPT level relative to the user's.
// JLPT numbering: 5 = N5 (easiest) ... 1 = N1 (hardest). A word whose JLPT number
// is *lower* than the user's level sits above their level => harder for them.
export function seedDifficulty(jlptLevel: number | null | undefined, userLevel: number | null): number {
  // No JLPT signal. Frequency already feeds seeding upstream — the JMDict lookup
  // derives a level from freq_rank/kanji when the official tag is missing (see
  // applyJlptFallback in jmdict.ts) — so a null reaching here means we have *no*
  // signal, not that the word is hard. Seed neutral, not 9: the old "assume hard"
  // default mis-seeded words graded before enrichment (null JLPT) straight to
  // Hard, and a read-past only eases -1/day so they stayed stuck there.
  if (jlptLevel == null) return 6;      // no signal => neutral, let reads ease it
  if (userLevel == null) return 5;      // unknown user level => neutral
  const delta = userLevel - jlptLevel;  // >0 => word harder than the user
  return clampDifficulty(6 + delta * 2);
}

// Promote a word from the intake queue into active FSRS scheduling (#68). Seeds an
// initial schedule from `difficulty`, anchored at `now` (a freshly promoted word
// becomes due ~one interval from promotion), and stamps it `active`. Pure: the caller
// persists + syncs the returned record. Used ONLY by the daily promotion pass — the
// one path that mints a "new" flashcard (a manual easy-set activates into far-out
// maintenance instead, without a promotedTs; see setWordMastery).
function activateWord(w: WordData, difficulty: number, now: number): WordData {
  const srs = seedSrsFromDifficulty(difficulty, now);
  return {
    ...w,
    difficulty,
    mastery: bucketForDifficulty(difficulty),
    intakeStatus: 'active',
    promotedTs: now,
    stability: srs.stability,
    fsrsDifficulty: srs.fsrsDifficulty,
    dueAt: srs.dueAt,
    lastReviewedTs: srs.lastReviewedAt,
    intervalDays: (srs.dueAt - srs.lastReviewedAt) / 86_400_000,
    reps: srs.reps,
    lapses: srs.lapses,
    srsStatus: srs.status,
  };
}

/**
 * Resolve the current user id for fire-and-forget background syncs.
 * getUser() round-trips to /auth/v1/user on every call; getSession() reads the
 * cached session (refreshing only if the access token has expired), so it's far
 * cheaper and avoids a storm of auth network calls on load and on every action.
 */
async function currentUserId(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.user?.id ?? null;
}

/** Fire-and-forget: persist read/dismissed state server-side and, only when a
 *  real buffer row actually transitioned, ask the server to refill the buffer.
 *  No-ops without a session (dev mode) or for raw feed cards (no processed row),
 *  so swiping raw cards never triggers production (guardrail #6). */
function syncConsumed(id: string, kind: 'read' | 'dismissed'): void {
  import('./api').then((m) => {
    currentUserId().then((uid) => {
      if (!uid) return;
      m.markArticleConsumed(id, uid, kind).then((moved) => {
        if (moved) m.ensureBuffer(uid);
      });
    });
  }).catch(() => { /* never block the UI on a sync failure */ });
}

/**
 * Combine two tracking records that turned out to be the same word (#39): the same
 * entry reached under two keys (e.g. a conjugation and its dictionary form, or a
 * pre-link surface key and its later-resolved entry_id). Exposures are additive —
 * they were genuinely separate sightings — while the graded SRS signal from the
 * stronger source wins. `into` is treated as the surviving record.
 */
export function mergeWordData(into: WordData, from: WordData): WordData {
  // Prefer an explicitly graded signal (flashcard/manual > click > skip) over an
  // ungraded one. A flashcard grade and a modal set are both deliberate (rank 3);
  // a lookup outranks a passive read, which outranks a bare seeded difficulty.
  const rank = (w: WordData) =>
    w.lastAdjustReason === 'flashcard' || w.lastAdjustReason === 'manual' ? 3
      : w.lastAdjustReason === 'click' ? 2
      : w.difficulty != null ? 1 : 0;
  const graded = rank(from) > rank(into) ? from : into;
  const days = Array.from(new Set([...(into.uniqueDaysSeen ?? []), ...(from.uniqueDaysSeen ?? [])]));
  return {
    ...into,
    // Richest display/definition fields win (a linked record over a placeholder).
    reading: into.reading || from.reading,
    meaning: into.meaning && into.meaning !== 'Implicitly parsed context' ? into.meaning : (from.meaning || into.meaning),
    grammarNote: into.grammarNote ?? from.grammarNote,
    furiganaMap: into.furiganaMap ?? from.furiganaMap,
    pos: into.pos ?? from.pos,
    jlptLevel: into.jlptLevel ?? from.jlptLevel,
    jlptDerived: into.jlptLevel != null ? into.jlptDerived : from.jlptDerived,
    surface: into.surface ?? from.surface,
    jmdictEntryId: into.jmdictEntryId ?? from.jmdictEntryId,
    // SRS state from whichever record carried the stronger grade.
    difficulty: graded.difficulty ?? into.difficulty ?? from.difficulty,
    mastery: graded.mastery ?? into.mastery,
    lastAdjustedDay: graded.lastAdjustedDay ?? into.lastAdjustedDay,
    lastAdjustReason: graded.lastAdjustReason ?? into.lastAdjustReason,
    // Exposures are additive; recency and streak take the most recent.
    timesSeen: (into.timesSeen ?? 0) + (from.timesSeen ?? 0),
    uniqueDaysSeen: days,
    lastSeenTs: Math.max(into.lastSeenTs ?? 0, from.lastSeenTs ?? 0),
    streak: (into.lastSeenTs ?? 0) >= (from.lastSeenTs ?? 0) ? (into.streak ?? 0) : (from.streak ?? 0),
  };
}

/** True when two ms-epoch timestamps fall on the same LOCAL calendar day. Daily
 * gates (intake promotion, RTK bump) compare days rather than elapsed hours: a
 * rolling `now - last >= 24h` check only fires while the app happens to be open,
 * so its fire time drifts later every day and mornings come up empty. */
function sameLocalDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

export interface WordData {
  reading: string;
  meaning: string;
  grammarNote?: string;
  furiganaMap?: { kanji: string; kana: string }[];
  jlptLevel?: number | null;
  jlptDerived?: boolean;
  pos?: string[];
  jmdictEntryId?: string;
  // Human-readable form for display/lists. Since the map key is the JMDict
  // entry_id once a word is linked (#39 canonical keying), the surface can no
  // longer be read off the key — it's carried here (the dictionary/lemma form).
  surface?: string;
  mastery: MasteryLevel;          // derived bucket, kept in sync with `difficulty`
  difficulty?: number | null;     // 1..10 source of truth; null/undefined = unseen
  lastAdjustedDay?: string;       // YYYY-MM-DD of the last difficulty change (daily dedup)
  lastAdjustReason?: AdjustReason;
  timesSeen: number;
  uniqueDaysSeen: string[];
  lastSeenTs: number;
  streak: number;
  // FSRS schedule (#67). Undefined until the word is first scheduled; `difficulty`
  // stays the coarse palette signal and seeds the initial state. See services/srs.ts.
  stability?: number | null;      // FSRS S, days
  fsrsDifficulty?: number | null; // FSRS D, 1..10 (algorithm-managed; ≠ `difficulty`)
  dueAt?: number | null;          // ms epoch — next review ("what's due")
  lastReviewedTs?: number | null; // ms epoch — last scheduler event
  intervalDays?: number | null;   // scheduled gap (days)
  reps?: number | null;
  lapses?: number | null;
  srsStatus?: SrsStatus | null;
  // Intake queue (#68). `queued` = encountered/candidate, exposure recorded but NOT on
  // a schedule; `active` = promoted into FSRS scheduling. Only the daily new-word cap
  // (foundation-first) mints a NEW card (promotedTs stamped); a manual easy-set
  // activates into far-out maintenance with promotedTs null (Policy F — known words
  // aren't drilled). Undefined on legacy records until the v7 migration stamps them.
  freqRank?: number | null;       // JMDict freq_rank (1 = most common); for compareIntake
  intakeStatus?: 'queued' | 'active';
  promotedTs?: number | null;     // ms epoch — when it entered active study
}

interface AppState {
  isOnboarded: boolean;
  jlptLevel: number | null;
  rtkLevel: number | null;
  studyMode: 'natural' | 'balanced' | 'study';
  vocabMode: 'natural' | 'balanced' | 'study';
  furiganaMode: 'always' | 'never' | 'dynamic';
  readingIntensity: 'leisure' | 'balanced' | 'intensive';
  // Target article length (paragraphs) by source fullness. Length follows how
  // much real source material the article was built from; JLPT drives complexity.
  targetParagraphs: { full: number; partial: number; snippet: number };
  // Feed topics (#10): curated topic ids the news pipeline pulls from. null =
  // never chosen → server defaults (world/technology/science). See src/data/feedTopics.ts.
  feedTopics: string[] | null;
  // Intake queue (#68): the Anki-style daily cap on how many new words graduate from
  // the queue into active study, and when the last promotion pass ran (daily gate).
  newWordsPerDay: number;
  lastIntakePromotionTs: number | null;
  // Review-activity history (#73): count of schedule-advancing review events per
  // calendar day (YYYY-MM-DD → count), powering the study dashboard's heatmap.
  // Local-only, pruned to a rolling window so the persisted blob can't grow unbounded.
  reviewsByDay: Record<string, number>;

  wordDatabase: Record<string, WordData>;
  studyKanji: string[];
  lastRtkUpdateTs: number | null;
  lastResetTs: number | null;
  // Study-pacing flood fix: when the one-time forward-reseed / re-queue last ran.
  lastStudyPacingResetTs: number | null;
  // One-shot furigana re-align: when the stored furiganaMap back-catalog was last
  // recomputed with the per-kanji reading tables (see realignFurigana).
  lastFuriganaRealignTs: number | null;
  // Daily throttle for the sync-time JLPT label refresh (server labels win).
  lastJlptLabelRefreshTs: number | null;
  currentArticle: NewsArticle | null;
  articlesCache: Record<string, NewsArticle>;
  processingArticles: string[];
  dismissedArticleIds: string[];
  readArticleIds: string[];
  readerFontSize: number;
  readerFontWeight: number;
  
  setOnboarded: (jlpt: number, rtk: number) => void;
  setJlptLevel: (level: number) => void;
  setRtkLevel: (level: number) => void;
  setStudyMode: (mode: 'natural' | 'balanced' | 'study') => void;
  setVocabMode: (mode: 'natural' | 'balanced' | 'study') => void;
  setFuriganaMode: (mode: 'always' | 'never' | 'dynamic') => void;
  setReadingIntensity: (intensity: 'leisure' | 'balanced' | 'intensive') => void;
  setTargetParagraphs: (kind: 'full' | 'partial' | 'snippet', value: number) => void;
  setFeedTopics: (topics: string[]) => void;
  setNewWordsPerDay: (n: number) => void;
  setCurrentArticle: (article: NewsArticle | null) => void;
  saveProcessedArticle: (id: string, article: NewsArticle) => void;
  setArticlesCache: (cache: Record<string, NewsArticle>) => void;
  dismissArticle: (id: string) => void;
  markArticleRead: (id: string) => void;
  setProcessing: (id: string, isProcessing: boolean) => void;
  resetFeedForNewDay: (now: number) => void;
  setReaderFontSize: (size: number) => void;
  setReaderFontWeight: (weight: number) => void;
  resetProgress: () => void;
  
  saveWordDefinition: (word: string, def: Partial<WordData>) => void;
  recordWordSeen: (word: string, withoutLookup?: boolean) => void;
  applyDifficultyEvent: (word: string, event: 'skip' | 'click', jlptLevel?: number | null) => void;
  reviewWord: (word: string, rating: Rating, now: number) => void;
  resetStudyPacing: () => Promise<{ keptActive: number; requeued: number }>;
  realignFurigana: () => Promise<{ updated: number; scanned: number }>;
  setWordMastery: (word: string, level: MasteryLevel) => void;
  gradeDiscoverWord: (candidate: IntakeCandidate, level: Exclude<MasteryLevel, 'unseen'>) => void;
  mergeWordRecords: (fromKey: string, toKey: string) => void;
  checkDailyKanji: () => void;
  promoteIntakeQueue: (now: number) => Promise<void>;
  syncSrsWithSupabase: (userId: string) => Promise<void>;
  backfillWordProgress: () => Promise<void>;
}

// #73: rolling window of review-activity history kept in localStorage. 180 tiny
// "YYYY-MM-DD": count entries is a few KB — bounded so it can't bloat the persist
// blob over time (see #54 / the localStorage-quota failure mode).
const REVIEW_HISTORY_DAYS = 180;

// #54: the read/dismissed id lists exist only to avoid re-suggesting already-seen
// articles; old ids age out of the feed anyway, so a bounded recent window is
// sufficient — unbounded, they creep the persist blob back toward the ~5MB quota
// that once wedged the iOS PWA. Server-side consumed state is the source of truth,
// so trimming is loss-free.
const MAX_TRACKED_ARTICLE_IDS = 1000;
// Aggressive truncation used by the quota evict-and-retry path: when a persist
// write overflows, shrink to a floor that still covers the feed's working set.
const EVICTED_ARTICLE_IDS = 100;

/** Keep only the most recent `max` ids (lists append newest-last). */
function capIds(ids: string[], max = MAX_TRACKED_ARTICLE_IDS): string[] {
  return ids.length > max ? ids.slice(-max) : ids;
}

/** Increment `dayKey`'s review-event tally and prune to the rolling window. Pure;
 * ISO date keys sort chronologically, so the oldest keys drop first. */
function bumpReviewDay(byDay: Record<string, number>, dayKey: string): Record<string, number> {
  const next = { ...byDay, [dayKey]: (byDay[dayKey] ?? 0) + 1 };
  const keys = Object.keys(next);
  if (keys.length > REVIEW_HISTORY_DAYS) {
    for (const k of keys.sort().slice(0, keys.length - REVIEW_HISTORY_DAYS)) delete next[k];
  }
  return next;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      isOnboarded: false,
      jlptLevel: null,
      rtkLevel: null,
      studyMode: 'balanced',
      vocabMode: 'balanced',
      furiganaMode: 'dynamic',
      readingIntensity: 'balanced',
      targetParagraphs: { full: 5, partial: 4, snippet: 3 },
      feedTopics: null,
      newWordsPerDay: 3,
      lastIntakePromotionTs: null,
      reviewsByDay: {},
      wordDatabase: {},
      studyKanji: [],
      lastRtkUpdateTs: null,
      lastResetTs: null,
      lastStudyPacingResetTs: null,
      lastFuriganaRealignTs: null,
      lastJlptLabelRefreshTs: null,
      currentArticle: null,
      articlesCache: {},
      processingArticles: [],
      dismissedArticleIds: [],
      readArticleIds: [],
      readerFontSize: 18,
      readerFontWeight: 500,

      setOnboarded: (jlpt, rtk) => set({ isOnboarded: true, jlptLevel: jlpt, rtkLevel: rtk }),

      setJlptLevel: (level) => {
        set({ jlptLevel: level });
        currentUserId().then((uid) => {
          if (uid) import('./api').then(m => m.upsertUserPreferences(uid, { jlpt_level: level }));
        });
      },
      setRtkLevel: (level) => {
        set({ rtkLevel: level, studyKanji: rtkKanjiList.slice(Math.max(0, level - 15), level), lastRtkUpdateTs: Date.now() });
        currentUserId().then((uid) => {
          if (uid) import('./api').then(m => m.upsertUserPreferences(uid, { rtk_level: level }));
        });
      },
      setStudyMode: (mode) => {
        set({ studyMode: mode });
        currentUserId().then((uid) => {
          if (uid) import('./api').then(m => m.upsertUserPreferences(uid, { study_mode: mode }));
        });
      },
      setVocabMode: (mode) => {
        set({ vocabMode: mode });
        currentUserId().then((uid) => {
          if (uid) import('./api').then(m => m.upsertUserPreferences(uid, { vocab_mode: mode }));
        });
      },
      setReadingIntensity: (intensity) => {
        set({ readingIntensity: intensity });
        currentUserId().then((uid) => {
          if (uid) import('./api').then(m => m.upsertUserPreferences(uid, { reading_intensity: intensity }));
        });
      },
      setTargetParagraphs: (kind, value) => {
        const v = Math.max(1, Math.min(10, Math.round(value)));
        set((state) => ({ targetParagraphs: { ...state.targetParagraphs, [kind]: v } }));
        const column = ({
          full: 'target_paragraphs_full',
          partial: 'target_paragraphs_partial',
          snippet: 'target_paragraphs_snippet',
        } as const)[kind];
        currentUserId().then((uid) => {
          if (uid) import('./api').then(m => m.upsertUserPreferences(uid, { [column]: v }));
        });
      },
      setFeedTopics: (topics) => {
        // Never persist an empty selection — the server would fall back to
        // defaults anyway, which would silently contradict the UI.
        if (!Array.isArray(topics) || topics.length === 0) return;
        const clean = [...new Set(topics)];
        set({ feedTopics: clean });
        currentUserId().then((uid) => {
          if (uid) import('./api').then(m => m.upsertUserPreferences(uid, { feed_topics: clean }));
        });
      },
      setNewWordsPerDay: (n) => {
        const v = Math.max(0, Math.min(50, Math.round(n)));
        set({ newWordsPerDay: v });
        currentUserId().then((uid) => {
          if (uid) import('./api').then(m => m.upsertUserPreferences(uid, { new_words_per_day: v }));
        });
      },

      setFuriganaMode: (mode) => set({ furiganaMode: mode }),
      setCurrentArticle: (article) => set({ currentArticle: article }),
      saveProcessedArticle: (id, article) => {
        // Local cache only. The server write is owned by process-article (it
        // upserts the row as `status='ready'`), so the old Supabase mirror here
        // was a redundant second write — removed per issue #31.
        set((state) => ({
          articlesCache: { ...state.articlesCache, [id]: article }
        }));
      },
      setArticlesCache: (cache) => set({ articlesCache: cache }),
      dismissArticle: (id) => {
        set((state) => ({
          dismissedArticleIds: capIds(Array.from(new Set([...state.dismissedArticleIds, id])))
        }));
        // Server-owned dismissed state + JIT refill. Local array stays as a fast
        // cache; the server is the source of truth (cross-device + buffer trigger).
        syncConsumed(id, 'dismissed');
      },
      // Reading an article does NOT hide it from the visible feed — the user
      // dismisses it manually. But a read article must never be pulled back in
      // as a fresh suggestion, so it's tracked separately and (unlike dismissals)
      // is not cleared by the daily feed reset.
      markArticleRead: (id) => {
        set((state) => ({
          readArticleIds: capIds(Array.from(new Set([...state.readArticleIds, id])))
        }));
        // Mark read server-side (on open) and top up the buffer.
        syncConsumed(id, 'read');
      },
      setProcessing: (id, isP) => set((state) => {
        const next = new Set(state.processingArticles || []);
        if (isP) next.add(id); else next.delete(id);
        return { processingArticles: Array.from(next) };
      }),
      resetFeedForNewDay: (now) => set({ 
        dismissedArticleIds: [], 
        lastResetTs: now 
      }),
      setReaderFontSize: (size) => set({ readerFontSize: size }),
      setReaderFontWeight: (weight) => set({ readerFontWeight: weight }),
      
      resetProgress: () => {
        set({ 
          isOnboarded: false, 
          jlptLevel: null, 
          rtkLevel: null, 
          wordDatabase: {},
          studyKanji: [],
          lastRtkUpdateTs: null,
          lastIntakePromotionTs: null,
        });
        
        // Wipe Supabase data
        currentUserId().then((uid) => {
          if (uid) {
            Promise.all([
              supabase.from('user_word_progress').delete().eq('user_id', uid),
              supabase.from('study_history').delete().eq('user_id', uid)
            ]).then(() => {
              console.log("♻️ Supabase Progress Wiped.");
              window.location.reload(); // Refresh to ensure a totally clean state
            });
          }
        });
      },
      
      saveWordDefinition: (word, def) =>
        set((state) => {
          // New words enter the intake queue (#68) — 'queued', not yet scheduled.
          const current = state.wordDatabase[word] || { reading: '', meaning: '', mastery: 'unseen', timesSeen: 0, uniqueDaysSeen: [], lastSeenTs: 0, intakeStatus: 'queued' as const };
          // Strip undefined values so partial saves don't erase cached fields (e.g. grammarNote)
          const cleanDef = Object.fromEntries(Object.entries(def).filter(([, v]) => v !== undefined));
          return {
            wordDatabase: {
              ...state.wordDatabase,
              [word]: { ...current, ...cleanDef }
            }
          };
        }),

      // Collapse two records for one word onto a single key (#39). Used when a
      // dictionary lookup resolves an entry_id for a token that was first tracked
      // under its surface/lemma — the surface-keyed record is merged into the
      // canonical entry_id key so the word stays one record (and one server row).
      mergeWordRecords: (fromKey: string, toKey: string) =>
        set((state) => {
          if (fromKey === toKey) return {};
          const from = state.wordDatabase[fromKey];
          if (!from) return {};
          const db = { ...state.wordDatabase };
          const existing = db[toKey];
          db[toKey] = existing ? mergeWordData(existing, from) : { ...from };
          delete db[fromKey];
          return { wordDatabase: db };
        }),

        
      recordWordSeen: (word: string, withoutLookup = false) => 
        set((state) => {
          const today = new Date().toISOString().split('T')[0];
          // A word first met while reading enters the intake queue (#68) as 'queued':
          // exposure is recorded here, but it waits for daily promotion before scheduling.
          const current = state.wordDatabase[word] || { reading: '', meaning: '', mastery: 'unseen', timesSeen: 0, uniqueDaysSeen: [], lastSeenTs: 0, streak: 0, intakeStatus: 'queued' as const };
          const newDays = current.uniqueDaysSeen.includes(today)
            ? current.uniqueDaysSeen 
            : [...current.uniqueDaysSeen, today];
            
          const newStreak = withoutLookup ? (current.streak || 0) + 1 : 0;
          const updatedWord = { 
            ...current, 
            timesSeen: current.timesSeen + 1,
            uniqueDaysSeen: newDays,
            lastSeenTs: Date.now(),
            streak: newStreak
          };

          // Sync to Supabase background
          currentUserId().then((uid) => {
            if (uid && updatedWord.jmdictEntryId) {
              import('./api').then(m => {
                const syncData = {
                  mastery: updatedWord.mastery,
                  // Preserve the word's graded difficulty. This is a full-row upsert,
                  // so omitting `difficulty` writes null and wipes the SRS signal that
                  // applyDifficultyEvent/setMastery wrote — and the seen path fires far
                  // more often than grading, so it clobbered most words.
                  difficulty: updatedWord.difficulty ?? null,
                  timesSeen: updatedWord.timesSeen,
                  streak: updatedWord.streak,
                  lastSeenTs: updatedWord.lastSeenTs
                };
                m.upsertWordProgressToSupabase(uid, updatedWord.jmdictEntryId!, syncData);
                m.logStudyEventToSupabase(uid, updatedWord.jmdictEntryId!, withoutLookup ? 'seen' : 'lookup');
              });
            }
          });
            
          return {
            wordDatabase: {
              ...state.wordDatabase,
              [word]: updatedWord
            }
          };
        }),

      // A learning event nudges the word's internal difficulty (1..10):
      //   - 'click' (looked up)        -> +2  (a lookup means it wasn't known)
      //   - 'skip'  (seen, not looked) -> -1  (read past => a little more familiar)
      // First encounter seeds from JLPT relative to the user: a 'skip' applies the -1
      // nudge to the seed, a 'click' uses the raw seed (see below). Thereafter both nudge.
      // Daily dedup: at most one passive adjustment per word per day, except a
      // 'click' may override an earlier same-day 'skip' once (a lookup is a stronger
      // signal). The user-facing bucket (mastery) is re-derived from difficulty.
      applyDifficultyEvent: (word: string, event: 'skip' | 'click', jlptLevel?: number | null) =>
        set((state) => {
          const current = state.wordDatabase[word];
          if (!current) return {}; // word must be saved first

          // Intake gate (#68): a queued word is not yet on a schedule. Reading past it
          // or looking it up records exposure (recordWordSeen, fired separately) but
          // does NOT grade or schedule it — it waits for daily promotion, foundation-
          // first. Only `active` words advance. (A stability-bearing legacy row with no
          // intake_status is treated as active so grandfathered schedules still tick.)
          const isActive = current.intakeStatus === 'active' || current.stability != null;
          if (!isActive) return {};

          // Shared daily-dedup gate (#71): the same rule the flashcard path stamps
          // into `lastAdjustedDay`, so a passive read never double-counts on top of
          // a same-day read OR a deliberate flashcard/manual review of this word.
          const today = new Date().toISOString().split('T')[0];
          if (!readerEventMayAdvance(event, current.lastAdjustedDay, current.lastAdjustReason, today)) return {};

          // First contact (no prior numeric difficulty) seeds from the word's JLPT
          // level relative to the user. The skip/click signal is applied asymmetrically:
          //   - 'skip' (read past, no lookup) nudges the seed DOWN by 1 — mild evidence
          //     of familiarity. For an N4 user this lands an N3 word in high medium, an
          //     N4 word in low medium, and an N5 word in easy (exactly the intended map).
          //   - 'click' uses the RAW seed (no +2): a single lookup isn't enough to call a
          //     word 'hard' — applying +2 here is the old bug where every lookup => 'hard'.
          // Once a baseline exists, every event nudges (repeat lookups harden, clean reads ease).
          const prior = current.difficulty;
          let difficulty: number;
          if (prior == null) {
            const seed = seedDifficulty(jlptLevel ?? current.jlptLevel, state.jlptLevel);
            difficulty = clampDifficulty(event === 'skip' ? seed - 1 : seed);
          } else {
            difficulty = clampDifficulty(prior + (event === 'click' ? 2 : -1));
          }
          const mastery = bucketForDifficulty(difficulty);

          // ── FSRS schedule (#67) ────────────────────────────────────────────
          // Reading a word in context always advances its real spaced-repetition
          // schedule (read-past = "Good", lookup = "Again"). The daily-dedup guard
          // above already caps passive reads to one/day, and FSRS makes the push
          // self-limiting (early reads gain little), so re-scrolls can't inflate it.
          // The word joins the schedule seeded from its coarse `difficulty` the
          // first time; thereafter the stored SRS state drives everything.
          const now = Date.now();
          const rating = ratingForReaderEvent(event);
          const priorSrs: SrsState =
            current.stability != null && current.dueAt != null
              ? {
                  stability: current.stability,
                  fsrsDifficulty: current.fsrsDifficulty ?? difficulty,
                  dueAt: current.dueAt,
                  lastReviewedAt: current.lastReviewedTs ?? current.lastSeenTs ?? now,
                  reps: current.reps ?? 0,
                  lapses: current.lapses ?? 0,
                  status: (current.srsStatus ?? 'review') as SrsStatus,
                }
              : seedSrsFromDifficulty(difficulty, current.lastSeenTs ?? now);
          const elapsedDays = (now - priorSrs.lastReviewedAt) / 86_400_000;
          const sched = schedule(priorSrs, rating, now);

          const updatedWord: WordData = {
            ...current,
            difficulty,
            mastery,
            lastAdjustedDay: today,
            lastAdjustReason: event,
            stability: sched.stability,
            fsrsDifficulty: sched.fsrsDifficulty,
            dueAt: sched.dueAt,
            lastReviewedTs: sched.lastReviewedAt,
            intervalDays: sched.intervalDays,
            reps: sched.reps,
            lapses: sched.lapses,
            srsStatus: sched.status,
          };

          currentUserId().then((uid) => {
            if (uid && updatedWord.jmdictEntryId) {
              import('./api').then(m => {
                m.upsertWordProgressToSupabase(uid, updatedWord.jmdictEntryId!, {
                  mastery: updatedWord.mastery,
                  difficulty,
                  timesSeen: updatedWord.timesSeen,
                  streak: updatedWord.streak,
                  lastSeenTs: updatedWord.lastSeenTs,
                  stability: sched.stability,
                  fsrsDifficulty: sched.fsrsDifficulty,
                  dueAt: sched.dueAt,
                  lastReviewedTs: sched.lastReviewedAt,
                  intervalDays: sched.intervalDays,
                  reps: sched.reps,
                  lapses: sched.lapses,
                  srsStatus: sched.status,
                });
                m.logStudyEventToSupabase(uid, updatedWord.jmdictEntryId!, 'mastery_change', { difficulty, mastery, event });
                m.logSrsReviewToSupabase(uid, updatedWord.jmdictEntryId!, {
                  rating,
                  source: event === 'click' ? 'reader_click' : 'reader_skip',
                  stabilityBefore: priorSrs.stability,
                  stabilityAfter: sched.stability,
                  difficultyBefore: priorSrs.fsrsDifficulty,
                  difficultyAfter: sched.fsrsDifficulty,
                  scheduledDays: sched.intervalDays,
                  elapsedDays,
                });
              });
            }
          });

          return {
            wordDatabase: {
              ...state.wordDatabase,
              [word]: updatedWord
            },
            // #73: this read advanced the schedule (the daily gate above passed), so
            // it counts as one review event for the dashboard's activity history.
            reviewsByDay: bumpReviewDay(state.reviewsByDay, today),
          };
        }),

      // Explicit user selection in the modal. Snaps difficulty to the bucket
      // midpoint and always applies (bypasses daily dedup); the manual stamp also
      // prevents passive sees later that day from overriding the user's call.
      setWordMastery: (word: string, level: MasteryLevel) =>
        set((state) => {
          const current = state.wordDatabase[word] || { reading: '', meaning: '', mastery: 'unseen', timesSeen: 0, uniqueDaysSeen: [], lastSeenTs: 0, streak: 0, intakeStatus: 'queued' as const };
          const today = new Date().toISOString().split('T')[0];
          const now = Date.now();
          const difficulty = level === 'unseen' ? null : difficultyForBucket(level);

          // #68 D3, revised under Policy F ("flashcards augment reading"): a manual
          // grade no longer fast-tracks a word into the flashcard deck. For a word
          // not yet in active study, decidePacing classifies the declaration:
          //   • hard/medium ("I'm learning this") — just record the grade; the word
          //     STAYS QUEUED and exits via the daily foundation-first cap, which
          //     seeds its schedule from this grade when it wins a slot.
          //   • easy ("I know this") — drilling a known word wastes a daily slot, so
          //     it skips the queue INTO FAR-OUT MAINTENANCE: the same forward reseed
          //     the pacing rebalance uses, with promotedTs left null so it never
          //     surfaces as a "new" card. Reading pushes it further out from there.
          // Setting 'unseen' is never a promotion.
          const notActive = current.intakeStatus !== 'active' && current.stability == null;
          let base = current;
          let toMaintenance = false;
          if (difficulty != null && notActive) {
            const decision = decidePacing({
              key: word,
              difficulty,
              distinctExposures: current.uniqueDaysSeen?.length ?? 0,
              intakeStatus: current.intakeStatus,
              stability: current.stability,
            }, now);
            if (decision.action === 'keep-active') {
              const srs = decision.srs;
              toMaintenance = true;
              base = {
                ...current,
                intakeStatus: 'active',
                promotedTs: null,
                stability: srs.stability,
                fsrsDifficulty: srs.fsrsDifficulty,
                dueAt: srs.dueAt,
                lastReviewedTs: srs.lastReviewedAt,
                intervalDays: (srs.dueAt - srs.lastReviewedAt) / 86_400_000,
                reps: srs.reps,
                lapses: srs.lapses,
                srsStatus: srs.status,
              };
            }
          }
          const updatedWord: WordData = { ...base, mastery: level, difficulty, lastAdjustedDay: today, lastAdjustReason: 'manual' };

          // Sync to Supabase
          currentUserId().then((uid) => {
            if (uid && updatedWord.jmdictEntryId) {
              import('./api').then(m => {
                m.upsertWordProgressToSupabase(uid, updatedWord.jmdictEntryId!, {
                  mastery: updatedWord.mastery,
                  difficulty,
                  timesSeen: updatedWord.timesSeen,
                  streak: updatedWord.streak,
                  lastSeenTs: updatedWord.lastSeenTs,
                  // On a maintenance activation, persist the far-out schedule +
                  // intake status (promotedTs stays null — not a "new" card).
                  ...(toMaintenance ? {
                    intakeStatus: 'active',
                    stability: updatedWord.stability,
                    fsrsDifficulty: updatedWord.fsrsDifficulty,
                    dueAt: updatedWord.dueAt,
                    lastReviewedTs: updatedWord.lastReviewedTs,
                    intervalDays: updatedWord.intervalDays,
                    reps: updatedWord.reps,
                    lapses: updatedWord.lapses,
                    srsStatus: updatedWord.srsStatus,
                  } : {}),
                });
                m.logStudyEventToSupabase(uid, updatedWord.jmdictEntryId!, 'mastery_change', { level, difficulty });
              });
            }
          });

          return {
            wordDatabase: {
              ...state.wordDatabase,
              [word]: updatedWord
            }
          };
        }),

      // Discover-mode triage (#113): the user flipped through an UNSEEN foundation
      // word on the Study tab and self-assessed it. Unlike the reader/modal paths
      // the word usually has no record yet, so this materialises one (entry-id
      // keyed, same template as a promotion win) and applies the Policy F split
      // that setWordMastery uses:
      //   • easy — already known: activate straight into far-out maintenance
      //     (promotedTs null — never surfaces as a "new" card, spends no daily slot).
      //   • medium/hard — worth studying: the word joins the intake queue with the
      //     grade recorded, and enters the deck via the daily foundation-first cap
      //     exactly as if it had been graded med/hard from reading.
      gradeDiscoverWord: (candidate: IntakeCandidate, level: Exclude<MasteryLevel, 'unseen'>) =>
        set((state) => {
          const key = candidate.entryId;
          const now = Date.now();
          const today = new Date(now).toISOString().split('T')[0];
          const existing = state.wordDatabase[key];
          // Already actively scheduled (raced with a promotion or a sync from
          // another device) — don't clobber a live schedule with a triage tap.
          if (existing && (existing.intakeStatus === 'active' || existing.stability != null)) return {};

          const difficulty = difficultyForBucket(level);
          // Same aligner as enrichment (jmdictToWordDetails), so if this word is
          // later promoted its flashcard shows furigana split like any other.
          const furiganaMap = alignReading(candidate.word, candidate.reading);
          const base: WordData = existing
            ? {
                ...existing,
                reading: existing.reading || candidate.reading,
                meaning: existing.meaning || candidate.meaning,
                surface: existing.surface ?? candidate.word,
                furiganaMap: existing.furiganaMap?.length ? existing.furiganaMap : furiganaMap,
                jmdictEntryId: existing.jmdictEntryId ?? candidate.entryId,
                jlptLevel: existing.jlptLevel ?? candidate.jlptLevel,
                freqRank: existing.freqRank ?? candidate.freqRank,
                intakeStatus: existing.intakeStatus ?? 'queued',
              }
            : {
                reading: candidate.reading,
                meaning: candidate.meaning,
                surface: candidate.word,
                furiganaMap,
                jmdictEntryId: candidate.entryId,
                jlptLevel: candidate.jlptLevel,
                freqRank: candidate.freqRank,
                mastery: 'unseen',
                timesSeen: 0,
                uniqueDaysSeen: [],
                lastSeenTs: 0,
                streak: 0,
                intakeStatus: 'queued',
              };

          // The triage flip is a genuine exposure — record it like a sighting.
          const seen: WordData = {
            ...base,
            timesSeen: (base.timesSeen ?? 0) + 1,
            uniqueDaysSeen: base.uniqueDaysSeen?.includes(today)
              ? base.uniqueDaysSeen
              : [...(base.uniqueDaysSeen ?? []), today],
            lastSeenTs: now,
          };

          const decision = decidePacing({
            key,
            difficulty,
            distinctExposures: seen.uniqueDaysSeen.length,
            intakeStatus: seen.intakeStatus,
            stability: seen.stability,
          }, now);

          let updatedWord: WordData;
          if (decision.action === 'keep-active') {
            const srs = decision.srs;
            updatedWord = {
              ...seen,
              intakeStatus: 'active',
              promotedTs: null,
              stability: srs.stability,
              fsrsDifficulty: srs.fsrsDifficulty,
              dueAt: srs.dueAt,
              lastReviewedTs: srs.lastReviewedAt,
              intervalDays: (srs.dueAt - srs.lastReviewedAt) / 86_400_000,
              reps: srs.reps,
              lapses: srs.lapses,
              srsStatus: srs.status,
            };
          } else {
            updatedWord = seen; // stays queued; the daily cap seeds its schedule later
          }
          updatedWord = { ...updatedWord, mastery: level, difficulty, lastAdjustedDay: today, lastAdjustReason: 'manual' };

          // Sync — unlike setWordMastery this always writes intakeStatus: the row
          // usually doesn't exist server-side yet, so 'queued' must land too.
          currentUserId().then((uid) => {
            if (!uid) return;
            import('./api').then(m => {
              m.upsertWordProgressToSupabase(uid, key, {
                mastery: updatedWord.mastery,
                difficulty,
                timesSeen: updatedWord.timesSeen,
                streak: updatedWord.streak,
                lastSeenTs: updatedWord.lastSeenTs,
                intakeStatus: updatedWord.intakeStatus,
                ...(decision.action === 'keep-active' ? {
                  stability: updatedWord.stability,
                  fsrsDifficulty: updatedWord.fsrsDifficulty,
                  dueAt: updatedWord.dueAt,
                  lastReviewedTs: updatedWord.lastReviewedTs,
                  intervalDays: updatedWord.intervalDays,
                  reps: updatedWord.reps,
                  lapses: updatedWord.lapses,
                  srsStatus: updatedWord.srsStatus,
                } : {}),
              });
              m.logStudyEventToSupabase(uid, key, 'mastery_change', { level, difficulty, source: 'discover' });
            });
          });

          return {
            wordDatabase: {
              ...state.wordDatabase,
              [key]: updatedWord
            }
          };
        }),

      // Flashcard grade (#70). A deliberate review — the strongest, most explicit
      // difficulty signal we get. It (1) advances the real FSRS schedule, (2) nudges
      // the coarse difficulty/mastery so the Progress page + the LLM palette reflect
      // study (D3: Again +2, Hard +1, Good -1, Easy -2), and (3) writes a
      // `flashcard`-sourced review-log row. A grade always applies (the deck only
      // surfaces a word once/day, so it can't stack on itself), but it now STAMPS
      // the shared daily-dedup marker (#71): after studying a word on a card, a
      // passive read-past of that same word later today is deduped by the reader
      // gate instead of double-advancing the one schedule. Rating: 1=Again 2=Hard
      // 3=Good 4=Easy.
      reviewWord: (word: string, rating: Rating, now: number) =>
        set((state) => {
          const current = state.wordDatabase[word];
          if (!current) return {};

          // Prior schedule, or a seed from `difficulty` if somehow unscheduled — the
          // same fallback the reader path uses, so a card is always gradeable.
          const baseDifficulty = current.difficulty ?? 5;
          // A genuinely-new card (promoted from intake, never actually graded) grades
          // from a fresh FSRS card so the first grade yields a real new-card ladder. Its
          // stored stability is only a synthetic difficulty seed written as status
          // 'review'; feeding that to FSRS would treat the word as an established review
          // and bunch Hard/Good/Easy around the seed. Mirrors the Flashcards preview.
          const isNewCard = current.promotedTs != null && (current.reps ?? 0) === 0;
          const priorSrs: SrsState | null = isNewCard
            ? null
            : current.stability != null && current.dueAt != null
              ? {
                  stability: current.stability,
                  fsrsDifficulty: current.fsrsDifficulty ?? baseDifficulty,
                  dueAt: current.dueAt,
                  lastReviewedAt: current.lastReviewedTs ?? current.lastSeenTs ?? now,
                  reps: current.reps ?? 0,
                  lapses: current.lapses ?? 0,
                  status: (current.srsStatus ?? 'review') as SrsStatus,
                }
              : seedSrsFromDifficulty(baseDifficulty, current.lastSeenTs ?? now);
          const elapsedDays = priorSrs ? (now - priorSrs.lastReviewedAt) / 86_400_000 : 0;
          const sched = schedule(priorSrs, rating, now);

          // Coarse difficulty nudge (D3), clamped 1..10, mirroring how reader events
          // nudge the same signal — a repeatedly-failed card should *look* hard to the
          // article generator, a repeatedly-easy one easy.
          const nudge: Record<Rating, number> = { 1: 2, 2: 1, 3: -1, 4: -2 };
          const difficulty = clampDifficulty(baseDifficulty + nudge[rating]);
          const mastery = bucketForDifficulty(difficulty);

          const today = new Date(now).toISOString().split('T')[0];
          const updatedWord: WordData = {
            ...current,
            difficulty,
            mastery,
            lastAdjustedDay: today,
            lastAdjustReason: 'flashcard',
            lastSeenTs: now,
            stability: sched.stability,
            fsrsDifficulty: sched.fsrsDifficulty,
            dueAt: sched.dueAt,
            lastReviewedTs: sched.lastReviewedAt,
            intervalDays: sched.intervalDays,
            reps: sched.reps,
            lapses: sched.lapses,
            srsStatus: sched.status,
          };

          currentUserId().then((uid) => {
            if (uid && updatedWord.jmdictEntryId) {
              import('./api').then(m => {
                m.upsertWordProgressToSupabase(uid, updatedWord.jmdictEntryId!, {
                  mastery: updatedWord.mastery,
                  difficulty,
                  timesSeen: updatedWord.timesSeen,
                  streak: updatedWord.streak,
                  lastSeenTs: updatedWord.lastSeenTs,
                  stability: sched.stability,
                  fsrsDifficulty: sched.fsrsDifficulty,
                  dueAt: sched.dueAt,
                  lastReviewedTs: sched.lastReviewedAt,
                  intervalDays: sched.intervalDays,
                  reps: sched.reps,
                  lapses: sched.lapses,
                  srsStatus: sched.status,
                });
                m.logSrsReviewToSupabase(uid, updatedWord.jmdictEntryId!, {
                  rating,
                  source: 'flashcard',
                  stabilityBefore: priorSrs?.stability ?? 0,
                  stabilityAfter: sched.stability,
                  difficultyBefore: priorSrs?.fsrsDifficulty ?? baseDifficulty,
                  difficultyAfter: sched.fsrsDifficulty,
                  scheduledDays: sched.intervalDays,
                  elapsedDays,
                });
              });
            }
          });

          return {
            wordDatabase: {
              ...state.wordDatabase,
              [word]: updatedWord
            },
            // #73: a flashcard grade always advances the schedule → one review event.
            reviewsByDay: bumpReviewDay(state.reviewsByDay, today),
          };
        }),

      // One-time study-pacing reset (the flood fix). Reclassifies the whole active
      // back-catalog under Policy F (see services/pacing.ts + docs/study-pacing-flood-fix.md):
      // easy words (difficulty ≤ 3) are kept active but forward-reseeded FAR OUT so they
      // rarely surface as flashcards; medium+ words go back to the intake queue to drip in
      // at the daily cap. Clears lastIntakePromotionTs so the next open promotes a fresh
      // batch. Syncs every touched row to Supabase (writing nulls to clear cleared
      // schedules). Idempotent-ish: re-running just re-applies the same rule.
      resetStudyPacing: async () => {
        const now = Date.now();
        const touched: WordData[] = [];
        set((state) => {
          const db = { ...state.wordDatabase };
          for (const [key, w] of Object.entries(db)) {
            if (!w) continue;
            const input = {
              key,
              difficulty: w.difficulty ?? null,
              distinctExposures: w.uniqueDaysSeen?.length ?? (w.timesSeen ? 1 : 0),
              intakeStatus: w.intakeStatus,
              stability: w.stability ?? null,
            };
            if (!isActiveForPacing(input)) continue; // queued/unscheduled words already paced
            const decision = decidePacing(input, now);
            let next: WordData;
            if (decision.action === 'keep-active') {
              const s = decision.srs;
              next = {
                ...w,
                intakeStatus: 'active',
                mastery: bucketForDifficulty(w.difficulty ?? 3),
                stability: s.stability,
                fsrsDifficulty: s.fsrsDifficulty,
                dueAt: s.dueAt,
                lastReviewedTs: s.lastReviewedAt,
                intervalDays: (s.dueAt - s.lastReviewedAt) / 86_400_000,
                reps: s.reps,
                lapses: s.lapses,
                srsStatus: s.status,
              };
            } else {
              // Medium+ → back to the queue. Clear the synthetic schedule but KEEP
              // difficulty/mastery (the learning signal; re-promotion re-seeds from it).
              next = {
                ...w,
                intakeStatus: 'queued',
                promotedTs: null,
                stability: null,
                fsrsDifficulty: null,
                dueAt: null,
                lastReviewedTs: null,
                intervalDays: null,
                reps: 0,
                lapses: 0,
                srsStatus: null,
              };
            }
            db[key] = next;
            touched.push(next);
          }
          return { wordDatabase: db, lastStudyPacingResetTs: now, lastIntakePromotionTs: null };
        });

        // Persist every touched row (entry-id-backed only), batched. Writes nulls so a
        // re-queued word's cleared schedule sticks server-side (cross-device + rehydrate).
        const uid = await currentUserId();
        if (uid && touched.length > 0) {
          const { resetStudyPacingBatch } = await import('./api');
          const rows = touched
            .filter((w) => w.jmdictEntryId)
            .map((w) => ({
              wordId: w.jmdictEntryId!,
              mastery: w.mastery,
              difficulty: w.difficulty ?? null,
              timesSeen: w.timesSeen,
              streak: w.streak,
              lastSeenTs: w.lastSeenTs || now,
              intakeStatus: w.intakeStatus ?? null,
              promotedTs: w.promotedTs ?? null,
              stability: w.stability ?? null,
              fsrsDifficulty: w.fsrsDifficulty ?? null,
              dueAt: w.dueAt ?? null,
              lastReviewedTs: w.lastReviewedTs ?? null,
              intervalDays: w.intervalDays ?? null,
              reps: w.reps ?? 0,
              lapses: w.lapses ?? 0,
              srsStatus: w.srsStatus ?? null,
            }));
          await resetStudyPacingBatch(uid, rows).catch((e) =>
            console.warn('[store] study-pacing reset sync failed:', e));
        }

        const keptActive = touched.filter((w) => w.intakeStatus === 'active').length;
        return { keptActive, requeued: touched.length - keptActive };
      },

      // One-shot furigana re-align (Settings → Advanced), sibling of resetStudyPacing.
      // The per-kanji reading tables were never loaded at runtime before main.tsx
      // primed them (#36 was inert), so every STORED furiganaMap was computed by the
      // coarser okurigana fallback: no-okurigana compounds (意味, 病院) carry one
      // grouped segment instead of per-kanji readings. furiganaMap is local-only
      // (never synced to user_word_progress), so this is a pure client re-derive —
      // no server writes. Self-hiding via lastFuriganaRealignTs.
      realignFurigana: async () => {
        await loadReadingData();
        let updated = 0;
        let scanned = 0;
        set((state) => {
          const db = { ...state.wordDatabase };
          for (const [key, w] of Object.entries(db)) {
            // Entry-id keys are numeric (#39); legacy keys ARE the surface form.
            const surface = w.surface || (/^\d+$/.test(key) ? '' : key);
            if (!surface || !w.reading || !hasKanji(surface)) continue;
            scanned++;
            const fresh = alignReading(surface, w.reading);
            const prev = w.furiganaMap ?? [];
            const same = prev.length === fresh.length &&
              prev.every((s, i) => s.kanji === fresh[i].kanji && s.kana === fresh[i].kana);
            if (same) continue;
            db[key] = { ...w, furiganaMap: fresh };
            updated++;
          }
          return updated > 0
            ? { wordDatabase: db, lastFuriganaRealignTs: Date.now() }
            : { lastFuriganaRealignTs: Date.now() };
        });
        return { updated, scanned };
      },

      syncSrsWithSupabase: async (userId) => {
        const { fetchUserWordProgress, fetchUserPreferences } = await import('./api');

        // Pull remote preferences and merge into local state
        const remotePrefs = await fetchUserPreferences(userId);
        if (remotePrefs) {
          set((state) => ({
            jlptLevel: remotePrefs.jlpt_level ?? state.jlptLevel,
            rtkLevel: remotePrefs.rtk_level ?? state.rtkLevel,
            studyMode: remotePrefs.study_mode ?? state.studyMode,
            vocabMode: remotePrefs.vocab_mode ?? state.vocabMode,
            furiganaMode: remotePrefs.furigana_mode ?? state.furiganaMode,
            readingIntensity: remotePrefs.reading_intensity ?? state.readingIntensity,
            targetParagraphs: {
              full: remotePrefs.target_paragraphs_full ?? state.targetParagraphs.full,
              partial: remotePrefs.target_paragraphs_partial ?? state.targetParagraphs.partial,
              snippet: remotePrefs.target_paragraphs_snippet ?? state.targetParagraphs.snippet,
            },
            newWordsPerDay: remotePrefs.new_words_per_day ?? state.newWordsPerDay,
            feedTopics: remotePrefs.feed_topics ?? state.feedTopics,
          }));
        }

        // Pull remote SRS progress (Last Write Wins)
        const remoteProgress = await fetchUserWordProgress(userId);
        // JLPT-cleanup tombstones: ignore rows the server-side fix removes or
        // remaps, so an un-migrated server can't re-add them locally (the remap
        // targets arrive through this same sync under their own ids).
        for (const id of Object.keys(remoteProgress)) {
          if (TOMBSTONED_WORD_IDS.has(id)) delete remoteProgress[id];
        }
        set((state) => {
          const newDatabase = { ...state.wordDatabase };
          let changed = false;

          Object.entries(remoteProgress).forEach(([wordId, remoteData]: [string, any]) => {
            // Local records are keyed by entry_id (#39), so the server word_id is a
            // direct lookup; fall back to a scan for any legacy surface-keyed record
            // that still carries this entry_id.
            const wordKey =
              newDatabase[wordId] ? wordId
              : Object.entries(newDatabase).find(([_, data]) => data.jmdictEntryId === wordId)?.[0];
            if (wordKey) {
              const localData = newDatabase[wordKey];
              if (remoteData.lastSeenTs > localData.lastSeenTs) {
                newDatabase[wordKey] = { ...localData, ...remoteData };
                changed = true;
              } else if (localData.difficulty == null && remoteData.difficulty != null) {
                // Local never graded this word but the server has a grade — from
                // another device, or a server-side change that didn't bump
                // last_seen_at (which the plain LWW gate above would miss). Adopt
                // the grade without disturbing local exposure counts (#41).
                newDatabase[wordKey] = { ...localData, mastery: remoteData.mastery, difficulty: remoteData.difficulty };
                changed = true;
              }
            }
          });

          if (changed) return { wordDatabase: newDatabase };
          return {};
        });

        // Rehydrate remote-only words. The merge above only UPDATES words already
        // cached locally — it never ADDS ones that exist on the server but not in
        // the local store. So a wiped localStorage (reinstall / cleared cache) left
        // Progress empty despite intact server data. Pull full JMDict details for
        // any server word missing locally and reconstruct its WordData. Guarded by
        // `missingIds`, so once the cache is whole this fetch is skipped.
        const haveIds = new Set(
          Object.values(get().wordDatabase).map((w) => w.jmdictEntryId).filter(Boolean),
        );
        const missingIds = Object.keys(remoteProgress).filter((id) => !haveIds.has(id));
        if (missingIds.length > 0) {
          try {
            const { fetchDetailsByEntryIds } = await import('./jmdict');
            const details = await fetchDetailsByEntryIds(missingIds);
            if (details.size > 0) {
              set((state) => {
                const newDatabase = { ...state.wordDatabase };
                details.forEach((d, id) => {
                  const r = remoteProgress[id];
                  if (!r) return;
                  // Keyed by entry_id (#39). Skip if already present (merge above
                  // handled it); this only ADDS server-only words.
                  if (newDatabase[id]) return;
                  newDatabase[id] = {
                    reading: d.reading,
                    meaning: d.meaning,
                    surface: d.word,
                    jlptLevel: d.jlptLevel,
                    jlptDerived: d.jlptDerived,
                    pos: d.pos,
                    furiganaMap: d.furiganaMap,
                    jmdictEntryId: id,
                    mastery: r.mastery ?? 'unseen',
                    difficulty: r.difficulty ?? null,
                    timesSeen: r.timesSeen ?? 0,
                    streak: r.streak ?? 0,
                    lastSeenTs: r.lastSeenTs ?? Date.now(),
                    uniqueDaysSeen: [],
                    // FSRS schedule + intake state (#67/#68). Dropping these here made
                    // a word promoted on ANOTHER device rehydrate as unscheduled — its
                    // promotedTs/stability vanished, so it never surfaced in the deck
                    // and never counted against the daily new-word cap.
                    stability: r.stability ?? null,
                    fsrsDifficulty: r.fsrsDifficulty ?? null,
                    dueAt: r.dueAt ?? null,
                    lastReviewedTs: r.lastReviewedTs ?? null,
                    intervalDays: r.intervalDays ?? null,
                    reps: r.reps ?? 0,
                    lapses: r.lapses ?? 0,
                    srsStatus: r.srsStatus ?? null,
                    intakeStatus: r.intakeStatus ?? undefined,
                    promotedTs: r.promotedTs ?? null,
                  };
                });
                return { wordDatabase: newDatabase };
              });
            }
            // Surface-keyed rows — the local-only remainder synced under their
            // surface key (no JMDict entry to resolve above) — reconstruct
            // minimally so their grades survive a reinstall. Only keys that look
            // like Japanese surfaces qualify: an entry id that failed to resolve
            // (stale/deleted JMDict row) must not become a junk "word" record.
            // They keep living in Progress "Other" (no JLPT ⇒ deck-ineligible)
            // until the healing pass in backfillWordProgress links them.
            const surfaceOnly = missingIds.filter((id) =>
              !details.has(id) && /[぀-ゟ゠-ヿ一-鿿㐀-䶿々]/.test(id));
            if (surfaceOnly.length > 0) {
              set((state) => {
                const newDatabase = { ...state.wordDatabase };
                let added = 0;
                for (const id of surfaceOnly) {
                  const r = remoteProgress[id];
                  if (!r || newDatabase[id]) continue;
                  newDatabase[id] = {
                    reading: '',
                    meaning: '',
                    surface: id,
                    mastery: r.mastery ?? 'unseen',
                    difficulty: r.difficulty ?? null,
                    timesSeen: r.timesSeen ?? 0,
                    streak: r.streak ?? 0,
                    lastSeenTs: r.lastSeenTs ?? Date.now(),
                    uniqueDaysSeen: [],
                    stability: r.stability ?? null,
                    fsrsDifficulty: r.fsrsDifficulty ?? null,
                    dueAt: r.dueAt ?? null,
                    lastReviewedTs: r.lastReviewedTs ?? null,
                    intervalDays: r.intervalDays ?? null,
                    reps: r.reps ?? 0,
                    lapses: r.lapses ?? 0,
                    srsStatus: r.srsStatus ?? null,
                    intakeStatus: r.intakeStatus ?? undefined,
                    promotedTs: r.promotedTs ?? null,
                  };
                  added++;
                }
                if (added > 0) console.log(`[store] rehydrated ${added} surface-keyed word(s)`);
                return added > 0 ? { wordDatabase: newDatabase } : {};
              });
            }
          } catch (e) {
            console.warn('[store] word-cache rehydrate failed:', e);
          }
        }

        // Repair words stored without a JLPT level (→ Progress "Other") and/or
        // without a difficulty (→ "Ungraded") — read-past / pre-enrichment / legacy
        // records. They carry a JMDict entry id, so the level is recoverable and a
        // first-contact difficulty can be seeded. Early-returns once backfilled.
        await get().backfillWordProgress();

        // Refresh JLPT labels for entry-backed words (daily). The local cache
        // keeps the label captured at lookup time, so server-side retagging
        // (docs/jlpt_vocab_audit.md) left stale levels behind — 来る displayed
        // in the N1 list while the server said N5. Server value wins here,
        // including derived levels for now-untagged entries.
        const lastLabelTs = get().lastJlptLabelRefreshTs ?? 0;
        if (Date.now() - lastLabelTs > 24 * 60 * 60 * 1000) {
          try {
            const { fetchJlptByEntryIds } = await import('./jmdict');
            const refreshIds = Object.values(get().wordDatabase)
              .map((w) => w.jmdictEntryId)
              .filter((id): id is string => !!id);
            const levels = await fetchJlptByEntryIds(refreshIds);
            set((state) => {
              const db = { ...state.wordDatabase };
              let changed = 0;
              for (const [key, w] of Object.entries(db)) {
                const info = w.jmdictEntryId ? levels.get(w.jmdictEntryId) : undefined;
                if (!info) continue;
                if ((w.jlptLevel ?? null) !== info.jlptLevel || (w.jlptDerived ?? false) !== info.jlptDerived) {
                  db[key] = { ...w, jlptLevel: info.jlptLevel, jlptDerived: info.jlptDerived };
                  changed++;
                }
              }
              if (changed > 0) console.log(`[store] refreshed JLPT labels on ${changed} word(s)`);
              return changed > 0
                ? { wordDatabase: db, lastJlptLabelRefreshTs: Date.now() }
                : { lastJlptLabelRefreshTs: Date.now() };
            });
          } catch (e) {
            console.warn('[store] JLPT label refresh failed:', e);
          }
        }

        // Reconcile local → server: words graded locally but ungraded (or absent)
        // on the server never had their grade persisted (legacy rows / failed past
        // syncs). Local is authoritative — it reflects real reading — so push those
        // grades up. We only FILL server nulls here; an existing server difficulty
        // is left untouched, so this can't clobber a newer cross-device grade.
        //
        // Entry-less records sync too, under their SURFACE key (path-forward §1.2):
        // word_id is "JMDict entry id or unique word string" by schema, so the
        // ~hundreds of graded words the healing pass can't link stop being
        // localStorage-only — a reinstall no longer erases their grades. Junk
        // guard: the key must contain a Japanese character and not be a bare
        // single-kana parse fragment (mirrors the healing pass's filter).
        const surfaceSyncable = (key: string) =>
          /[぀-ゟ゠-ヿ一-鿿㐀-䶿々]/.test(key) && !(key.length === 1 && /[぀-ゟ゠-ヿ]/.test(key));
        const toPush = Object.entries(get().wordDatabase)
          .filter(([key, w]) => {
            if (w.difficulty == null) return false;
            if (!w.jmdictEntryId && !surfaceSyncable(key)) return false;
            // Never resurrect a tombstoned row from a stale local cache.
            if (TOMBSTONED_WORD_IDS.has(w.jmdictEntryId ?? key)) return false;
            const remote = remoteProgress[w.jmdictEntryId ?? key];
            return !remote || remote.difficulty == null;
          })
          .map(([key, w]) => ({
            wordId: w.jmdictEntryId ?? key,
            mastery: w.mastery,
            difficulty: w.difficulty!,
            timesSeen: w.timesSeen,
            streak: w.streak,
            lastSeenTs: w.lastSeenTs,
          }));
        if (toPush.length > 0) {
          const { upsertWordProgressBatch } = await import('./api');
          await upsertWordProgressBatch(userId, toPush).catch((e) => {
            console.warn('[store] local→server grade reconcile failed:', e);
          });
        }
      },

      // Backfill degraded cached words:
      //   - entry-less records: resolved by surface form and re-keyed onto their
      //     canonical entry_id (see the first stage below).
      //   - jlptLevel: resolved official → kanji → frequency (matches enrichment).
      //   - difficulty: seeded from the (now-known) JLPT as a read-past 'skip',
      //     exactly like applyDifficultyEvent's first contact, so a word seen before
      //     grading existed stops sitting in the unseen/ungraded bucket.
      // Only seeds difficulty for words actually encountered (timesSeen >= 1) and
      // syncs the seeded grades to Supabase in one batched round-trip.
      backfillWordProgress: async () => {
        // Heal entry-less records by resolving their surface form against JMDict.
        // A partially-failed enrichment (one lookup leg timing out / truncating)
        // used to leave tokens link-less, and grading off them stored degraded
        // records: conjugated reading, blank meaning, no entry id, no JLPT — stuck
        // permanently in Progress's "Other" and invisible to the entry-id stages
        // below. The stored surface is the kuromoji lemma, so a JMDict surface
        // lookup recovers the entry; the record is then re-keyed onto its canonical
        // entry_id (merging into any healthy duplicate tracked there) and picks up
        // the dictionary reading/meaning/JLPT. Katakana-only surfaces are skipped
        // on purpose: article katakana is mostly proper nouns, and linking e.g.
        // トランプ (the person) to JMDict's "playing cards" would be wrong — those
        // records legitimately live in "Other".
        const entrylessTargets = Object.entries(get().wordDatabase)
          .map(([key, w]) => ({ key, surface: w.surface ?? key, w }))
          .filter(({ surface, w }) => {
            if (w.jmdictEntryId) return false;
            // Resolvable = contains hiragana or kanji (excludes katakana-only,
            // romaji, digits) and isn't a bare single-kana parse fragment.
            if (!/[぀-ゟ一-鿿㐀-䶿々]/.test(surface)) return false;
            if (surface.length === 1 && /[぀-ゟ]/.test(surface)) return false;
            return true;
          });
        if (entrylessTargets.length > 0) {
          try {
            const { lookupLemmasBatch, jmdictToWordDetails } = await import('./jmdict');
            const surfaces = [...new Set(entrylessTargets.map(t => t.surface))];
            // Chunk the batch: each surface can match several entries, and one huge
            // .in() risks the silent ~1000-row cap — the very truncation that
            // created these records during enrichment.
            const resolved = new Map<string, import('./jmdict').JMDictResult>();
            const CHUNK = 50;
            for (let i = 0; i < surfaces.length; i += CHUNK) {
              const part = await lookupLemmasBatch(surfaces.slice(i, i + CHUNK));
              part.forEach((v, k) => resolved.set(k, v));
            }
            if (resolved.size > 0) {
              set((state) => {
                const db = { ...state.wordDatabase };
                let changed = false;
                for (const { key, surface } of entrylessTargets) {
                  // Re-read latest; a concurrent lookup may have linked it already.
                  const current = db[key];
                  if (!current || current.jmdictEntryId) continue;
                  const entry = resolved.get(surface);
                  if (!entry) continue;
                  const d = jmdictToWordDetails(surface, entry);
                  const healed: WordData = {
                    ...current,
                    // The stored reading/furigana came from a conjugated token;
                    // the JMDict lemma reading matches the displayed surface.
                    reading: d.reading || current.reading,
                    meaning: current.meaning && current.meaning !== 'Implicitly parsed context'
                      ? current.meaning
                      : (d.meaning || current.meaning),
                    furiganaMap: d.furiganaMap.length > 0 ? d.furiganaMap : current.furiganaMap,
                    pos: current.pos ?? d.pos,
                    jlptLevel: current.jlptLevel ?? d.jlptLevel,
                    jlptDerived: current.jlptLevel != null ? current.jlptDerived : d.jlptDerived,
                    freqRank: current.freqRank ?? d.freqRank,
                    surface: current.surface ?? surface,
                    jmdictEntryId: d.jmdictEntryId,
                  };
                  if (d.jmdictEntryId !== key) {
                    const existing = db[d.jmdictEntryId];
                    db[d.jmdictEntryId] = existing ? mergeWordData(existing, healed) : healed;
                    delete db[key];
                  } else {
                    db[key] = healed;
                  }
                  changed = true;
                }
                return changed ? { wordDatabase: db } : {};
              });
            }
          } catch (e) {
            console.warn('[store] entry-less word resolve failed:', e);
          }
        }

        // Heal words that entered via read-past (recordWordSeen creates them with an
        // empty `reading`) or were promoted to the deck before ever being looked up:
        // with no reading and no furiganaMap the flashcard front can't show furigana.
        // Reading/furigana come straight from JMDict by entry_id (not per-user), so
        // this is a client-only re-derive — no server write. Early-returns once whole.
        const readingTargets = Object.entries(get().wordDatabase)
          .filter(([, w]) => !!w.jmdictEntryId && !w.reading);
        if (readingTargets.length > 0) {
          try {
            const { fetchDetailsByEntryIds } = await import('./jmdict');
            const details = await fetchDetailsByEntryIds([
              ...new Set(readingTargets.map(([, w]) => w.jmdictEntryId!)),
            ]);
            if (details.size > 0) {
              set((state) => {
                const newDatabase = { ...state.wordDatabase };
                let changed = false;
                for (const [key] of readingTargets) {
                  const current = newDatabase[key];
                  if (!current || !current.jmdictEntryId || current.reading) continue;
                  const d = details.get(current.jmdictEntryId);
                  if (!d || !d.reading) continue;
                  newDatabase[key] = {
                    ...current,
                    reading: d.reading,
                    furiganaMap: current.furiganaMap && current.furiganaMap.length > 0
                      ? current.furiganaMap
                      : d.furiganaMap,
                  };
                  changed = true;
                }
                return changed ? { wordDatabase: newDatabase } : {};
              });
            }
          } catch (e) {
            console.warn('[store] reading backfill failed:', e);
          }
        }

        const targets = Object.entries(get().wordDatabase)
          .filter(([, w]) => !!w.jmdictEntryId && (w.jlptLevel == null || w.difficulty == null));
        if (targets.length === 0) return;

        const { fetchJlptByEntryIds } = await import('./jmdict');
        let resolved: Map<string, { jlptLevel: number | null; jlptDerived: boolean }>;
        try {
          resolved = await fetchJlptByEntryIds(targets.map(([, w]) => w.jmdictEntryId!));
        } catch (e) {
          console.warn('[store] word-progress backfill failed:', e);
          return;
        }

        const synced: { wordId: string; mastery: MasteryLevel; difficulty: number | null; timesSeen: number; streak: number; lastSeenTs: number }[] = [];

        set((state) => {
          const newDatabase = { ...state.wordDatabase };
          let changed = false;
          for (const [key] of targets) {
            // Re-read latest; a concurrent enrichment/grade may have already set it.
            const current = newDatabase[key];
            if (!current || !current.jmdictEntryId) continue;
            const hit = resolved.get(current.jmdictEntryId);
            const next: WordData = { ...current };
            let touched = false;

            // 1. Backfill JLPT level → moves the word out of "Other".
            if (next.jlptLevel == null && hit && hit.jlptLevel != null) {
              next.jlptLevel = hit.jlptLevel;
              next.jlptDerived = hit.jlptDerived;
              touched = true;
            }

            // 2. Seed a difficulty for seen-but-ungraded words → out of "Ungraded".
            //    Treat the past encounter as a read-past 'skip' (seed - 1), matching
            //    first contact in applyDifficultyEvent. Post-#68 this only applies to
            //    ACTIVE words: a queued word is intentionally ungraded (it waits for
            //    daily promotion), so backfill must not grade it on sight and re-open
            //    the every-word-on-sight floodgate the intake queue exists to close.
            const isActive = next.intakeStatus === 'active' || next.stability != null;
            if (isActive && next.difficulty == null && current.timesSeen >= 1) {
              next.difficulty = clampDifficulty(seedDifficulty(next.jlptLevel ?? null, state.jlptLevel) - 1);
              next.mastery = bucketForDifficulty(next.difficulty);
              next.lastAdjustReason = 'skip';
              touched = true;
            }

            if (touched) {
              newDatabase[key] = next;
              changed = true;
              // Only the difficulty path needs a server write (the level is always
              // re-derivable client-side); push those rows for one batched upsert.
              if (next.difficulty !== current.difficulty) {
                synced.push({
                  wordId: current.jmdictEntryId,
                  mastery: next.mastery,
                  difficulty: next.difficulty ?? null,
                  timesSeen: next.timesSeen,
                  streak: next.streak,
                  lastSeenTs: next.lastSeenTs,
                });
              }
            }
          }
          return changed ? { wordDatabase: newDatabase } : {};
        });

        if (synced.length > 0) {
          const uid = await currentUserId();
          if (uid) {
            const { upsertWordProgressBatch } = await import('./api');
            upsertWordProgressBatch(uid, synced).catch(() => { /* best-effort sync */ });
          }
        }
      },

      checkDailyKanji: () => {
        const now = Date.now();
        const state = get();
        // First time, or a new local calendar day (a rolling 24h gate drifts later
        // every day — see sameLocalDay).
        if (!state.lastRtkUpdateTs || !sameLocalDay(state.lastRtkUpdateTs, now)) {
          let currentLevel = state.rtkLevel || 122;
          if (currentLevel < 122) currentLevel = 122; // One-time alignment
          const newLevel = Math.min(currentLevel + 3, rtkKanjiList.length);
          
          // The newest 3 kanji become today's "Study Kanji"
          const dailyTargets = rtkKanjiList.slice(currentLevel, newLevel);
          
          set({
            rtkLevel: newLevel,
            studyKanji: dailyTargets,
            lastRtkUpdateTs: now
          });
        }
      },

      // Daily intake promotion (#68). Graduates up to `newWordsPerDay` words from the
      // intake queue into active FSRS scheduling, foundation-first (easiest level first,
      // then most common). The queue draws from TWO sources — words the user has met
      // while reading (local 'queued' records) and important common words at/below their
      // level they haven't read yet (the get_intake_candidates RPC) — so the common
      // backbone gets built even when articles skip it. Gated to once per LOCAL CALENDAR
      // DAY: a rolling 24h gate ratchets the promotion time later every day (it only
      // fires while the app is open), so a morning open kept finding yesterday's stamp
      // too fresh and produced no cards. Call it on app open, AFTER syncSrsWithSupabase.
      promoteIntakeQueue: async (now: number) => {
        const state = get();
        if (state.lastIntakePromotionTs && sameLocalDay(state.lastIntakePromotionTs, now)) return;
        // Stamp immediately so a re-entrant call (e.g. a double mount) can't double-promote.
        set({ lastIntakePromotionTs: now });

        const capPref = state.newWordsPerDay ?? 3;
        if (capPref <= 0) return; // 0 = new words paused

        // Words already promoted TODAY count against the cap. `promotedTs` stamps ride
        // the sync (this runs after syncSrsWithSupabase), so a batch promoted on another
        // device — or a manual modal mastery-set — spends today's slots instead of
        // stacking a second full batch on top.
        const promotedToday = Object.values(state.wordDatabase)
          .filter((w) => w.promotedTs != null && sameLocalDay(w.promotedTs, now)).length;
        const cap = capPref - promotedToday;
        if (cap <= 0) return;

        // Source 1: words already encountered and waiting in the local queue. Only
        // deck-eligible words (JLPT level known — mirrors deck.isEligible) may compete:
        // a level-less fragment that wins a slot becomes an *invisible* active word,
        // silently burning the day's cap on cards the deck refuses to show.
        const queuedItems: IntakeItem[] = Object.entries(state.wordDatabase)
          .filter(([, w]) => w.intakeStatus === 'queued' && w.jlptLevel != null)
          .map(([key, w]) => ({
            key,
            entryId: w.jmdictEntryId ?? key,
            jlptLevel: w.jlptLevel ?? null,
            freqRank: w.freqRank ?? null,
            timesSeen: w.timesSeen ?? 0,
          }));

        // Source 2: important unseen-foundation words (virtual, server-sourced). Needs a
        // session + a known level; skipped in dev/no-auth (queue then = local words only).
        let candidateItems: IntakeItem[] = [];
        const uid = await currentUserId();
        const userJlpt = state.jlptLevel;
        if (uid && userJlpt != null) {
          // A failed fetch silently erases the day's unseen-foundation slots (this
          // pass runs once per calendar day — there is no later attempt). Retry once
          // after a short pause before giving up, and log the give-up as an error so
          // it surfaces once error monitoring lands (path-forward §0.3).
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const seenIds = Object.values(get().wordDatabase)
                .map((w) => w.jmdictEntryId)
                .filter((id): id is string => !!id);
              const { fetchIntakeCandidates } = await import('./jmdict');
              const cands = await fetchIntakeCandidates(userJlpt, seenIds, cap + 20);
              candidateItems = cands.map((c) => ({
                key: null,
                entryId: c.entryId,
                jlptLevel: c.jlptLevel,
                freqRank: c.freqRank,
                timesSeen: 0,
                candidate: c,
              }));
              break;
            } catch (e) {
              if (attempt === 0) {
                console.warn('[store] intake candidate fetch failed, retrying once:', e);
                await new Promise((r) => setTimeout(r, 1500));
              } else {
                console.error('[store] intake candidate fetch failed after retry — no unseen-foundation words today:', e);
              }
            }
          }
        }

        const winners = selectPromotions(queuedItems, candidateItems, cap);
        if (winners.length === 0) return;

        const toSync: WordData[] = [];
        set((s) => {
          const db = { ...s.wordDatabase };
          for (const win of winners) {
            let key: string;
            let record: WordData;
            if (win.key != null && db[win.key]) {
              key = win.key;
              record = db[key];
            } else if (win.candidate) {
              // Materialise a virtual unseen-foundation word, keyed by entry_id (#39).
              key = win.entryId;
              record = db[key] ?? {
                reading: win.candidate.reading,
                meaning: win.candidate.meaning,
                surface: win.candidate.word,
                jmdictEntryId: win.candidate.entryId,
                jlptLevel: win.candidate.jlptLevel,
                freqRank: win.candidate.freqRank,
                mastery: 'unseen',
                timesSeen: 0,
                uniqueDaysSeen: [],
                lastSeenTs: 0,
                streak: 0,
                intakeStatus: 'queued',
              };
            } else {
              continue;
            }
            if (record.intakeStatus === 'active') continue; // already promoted; skip
            const difficulty = record.difficulty ?? clampDifficulty(seedDifficulty(record.jlptLevel ?? null, s.jlptLevel));
            const activated = activateWord(record, difficulty, now);
            db[key] = activated;
            toSync.push(activated);
          }
          return { wordDatabase: db };
        });

        // Persist promotions (schedule + intake status). Best-effort per row.
        if (uid && toSync.length > 0) {
          const { upsertWordProgressToSupabase } = await import('./api');
          for (const w of toSync) {
            if (!w.jmdictEntryId) continue;
            upsertWordProgressToSupabase(uid, w.jmdictEntryId, {
              mastery: w.mastery,
              difficulty: w.difficulty ?? null,
              timesSeen: w.timesSeen,
              streak: w.streak,
              lastSeenTs: w.lastSeenTs || now,
              intakeStatus: 'active',
              promotedTs: w.promotedTs,
              stability: w.stability,
              fsrsDifficulty: w.fsrsDifficulty,
              dueAt: w.dueAt,
              lastReviewedTs: w.lastReviewedTs,
              intervalDays: w.intervalDays,
              reps: w.reps,
              lapses: w.lapses,
              srsStatus: w.srsStatus,
            }).catch(() => { /* best-effort */ });
          }
        }
      }
    }),
    {
      name: 'yugen-storage',
      version: 9,
      // A persist write throws QuotaExceededError once localStorage fills up. That
      // exception used to propagate out of store actions (markArticleRead,
      // recordWordSeen, ...) and abort the tap handler — silently breaking article
      // opens and word lookups while read-only UI (Progress) kept working, worse the
      // longer the session ran. Swallow write failures so a full quota degrades
      // gracefully (stale persisted state) instead of wedging the UI.
      storage: createJSONStorage(() => ({
        getItem: (name) => localStorage.getItem(name),
        setItem: (name, value) => {
          try {
            localStorage.setItem(name, value);
          } catch (e) {
            // #54 evict-and-retry: a quota overflow used to just stop persisting —
            // a whole session's grades silently lost on next reload. Truncate the
            // article-id lists (loss-free; server owns consumed state) and retry
            // once so the write that matters (wordDatabase) still lands.
            try {
              const parsed = JSON.parse(value);
              const s = parsed?.state;
              if (s && (Array.isArray(s.readArticleIds) || Array.isArray(s.dismissedArticleIds))) {
                if (Array.isArray(s.readArticleIds)) s.readArticleIds = capIds(s.readArticleIds, EVICTED_ARTICLE_IDS);
                if (Array.isArray(s.dismissedArticleIds)) s.dismissedArticleIds = capIds(s.dismissedArticleIds, EVICTED_ARTICLE_IDS);
                localStorage.setItem(name, JSON.stringify(parsed));
                console.warn('[store] localStorage quota hit — evicted article-id lists and re-persisted:', e);
                return;
              }
            } catch { /* fall through to the log below */ }
            captureError(e, { where: 'localStorage-persist', evicted: true });
          }
        },
        removeItem: (name) => localStorage.removeItem(name),
      })),
      // Persist only durable, lightweight state. Full processed articles
      // (articlesCache, currentArticle) are large, accumulate with every article
      // read, and were the bulk of the blob that overflowed the ~5MB quota. They
      // live in Supabase / the JIT buffer and are refetched on demand, so they never
      // need to survive a reload. processingArticles is in-flight-only (and already
      // cleared on rehydrate).
      partialize: (state) => ({
        isOnboarded: state.isOnboarded,
        jlptLevel: state.jlptLevel,
        rtkLevel: state.rtkLevel,
        studyMode: state.studyMode,
        vocabMode: state.vocabMode,
        furiganaMode: state.furiganaMode,
        readingIntensity: state.readingIntensity,
        targetParagraphs: state.targetParagraphs,
        feedTopics: state.feedTopics,
        newWordsPerDay: state.newWordsPerDay,
        lastIntakePromotionTs: state.lastIntakePromotionTs,
        reviewsByDay: state.reviewsByDay,
        wordDatabase: state.wordDatabase,
        studyKanji: state.studyKanji,
        lastRtkUpdateTs: state.lastRtkUpdateTs,
        lastResetTs: state.lastResetTs,
        lastStudyPacingResetTs: state.lastStudyPacingResetTs,
        lastFuriganaRealignTs: state.lastFuriganaRealignTs,
        lastJlptLabelRefreshTs: state.lastJlptLabelRefreshTs,
        dismissedArticleIds: capIds(state.dismissedArticleIds),
        readArticleIds: capIds(state.readArticleIds),
        readerFontSize: state.readerFontSize,
        readerFontWeight: state.readerFontWeight,
      }),
      migrate: (persistedState: any, version: number) => {
        let state = persistedState;
        if (version < 2) {
          state = {
            ...state,
            processingArticles: [],
            dismissedArticleIds: [],
            currentArticle: null
          };
        }
        // v3: seed the numeric `difficulty` from the legacy mastery bucket.
        if (version < 3 && state?.wordDatabase) {
          const wordDatabase = { ...state.wordDatabase };
          Object.keys(wordDatabase).forEach((key) => {
            const w = wordDatabase[key];
            if (w && w.difficulty == null && w.mastery && w.mastery !== 'unseen') {
              wordDatabase[key] = { ...w, difficulty: difficultyForBucket(w.mastery) };
            }
          });
          state = { ...state, wordDatabase };
        }
        // v4: repair difficulties mis-seeded by the grading race. Words read past
        // before client enrichment populated their JLPT were seeded from a null
        // level => difficulty 8/9 => stuck "hard". Re-seed any *passively* graded
        // (read-past — not a manual set or a lookup) hard row from its stored JLPT;
        // legit-hard rows (e.g. an N3 word for an N5 user) re-derive to the same
        // value, so only the mis-seeded ones actually move. Rows with no stored
        // JLPT drop to ungraded and re-grade correctly on the next read.
        if (version < 4 && state?.wordDatabase) {
          const wordDatabase = { ...state.wordDatabase };
          Object.keys(wordDatabase).forEach((key) => {
            const w = wordDatabase[key];
            if (!w) return;
            const passivelyHard =
              (w.mastery === 'hard' || (w.difficulty != null && w.difficulty >= 8)) &&
              w.lastAdjustReason !== 'manual' &&
              w.lastAdjustReason !== 'click';
            if (!passivelyHard) return;
            if (w.jlptLevel != null) {
              // Mirror a single read-past on a fresh seed (see applyDifficultyEvent).
              const difficulty = clampDifficulty(seedDifficulty(w.jlptLevel, state.jlptLevel ?? null) - 1);
              wordDatabase[key] = { ...w, difficulty, mastery: bucketForDifficulty(difficulty), lastAdjustReason: 'skip' };
            } else {
              wordDatabase[key] = { ...w, difficulty: null, mastery: 'unseen', lastAdjustedDay: undefined, lastAdjustReason: undefined };
            }
          });
          state = { ...state, wordDatabase };
        }
        // v5: canonical entry_id keying (#39). Re-key every dictionary-linked record
        // from its old surface/lemma key to its JMDict entry_id, carrying the old key
        // over as the `surface` display form. Records that share an entry_id (a word
        // tracked under a conjugation AND its base form, kana vs kanji, etc.) collapse
        // into one via mergeWordData — summing exposures, keeping the stronger grade.
        // Entry-less records (proper nouns, parse artifacts) keep their surface key.
        if (version < 5 && state?.wordDatabase) {
          const rekeyed: Record<string, WordData> = {};
          Object.entries(state.wordDatabase as Record<string, WordData>).forEach(([key, w]) => {
            if (!w) return;
            const targetKey = w.jmdictEntryId || key;
            const withSurface: WordData = { ...w, surface: w.surface ?? key };
            rekeyed[targetKey] = rekeyed[targetKey]
              ? mergeWordData(rekeyed[targetKey], withSurface)
              : withSurface;
          });
          state = { ...state, wordDatabase: rekeyed };
        }
        // v6: FSRS scheduling (#67). Seed a real schedule for every already-graded
        // word from its coarse `difficulty` + `lastSeenTs`, mirroring the server-side
        // SQL backfill (database/23_fsrs_scheduling.sql) — easy words seed with a long
        // interval, hard words come due soon. This also covers local-only words (no
        // entry_id) that the SQL backfill can't reach. Ungraded words stay unscheduled
        // (they belong in #68's intake queue); anything read after this seeds lazily.
        if (version < 6 && state?.wordDatabase) {
          const wordDatabase = { ...state.wordDatabase };
          Object.keys(wordDatabase).forEach((key) => {
            const w = wordDatabase[key];
            if (!w || w.difficulty == null || w.stability != null) return;
            const s = seedSrsFromDifficulty(w.difficulty, w.lastSeenTs ?? Date.now());
            wordDatabase[key] = {
              ...w,
              stability: s.stability,
              fsrsDifficulty: s.fsrsDifficulty,
              dueAt: s.dueAt,
              lastReviewedTs: s.lastReviewedAt,
              intervalDays: (s.dueAt - s.lastReviewedAt) / 86_400_000,
              reps: s.reps,
              lapses: s.lapses,
              srsStatus: s.status,
            };
          });
          state = { ...state, wordDatabase };
        }
        // v7: intake queue (#68). Grandfather (D2) — stamp every existing word's
        // intake_status so today's graded-on-sight words keep their schedule: a word
        // already scheduled/graded is 'active'; an ungraded one becomes 'queued' (it
        // now waits for daily promotion instead of being graded on next read). Mirrors
        // the SQL backfill in database/24_intake_queue.sql. Non-destructive: no
        // schedules touched. New words created after this migration default to 'queued'.
        if (version < 7 && state?.wordDatabase) {
          const wordDatabase = { ...state.wordDatabase };
          Object.keys(wordDatabase).forEach((key) => {
            const w = wordDatabase[key];
            if (!w || w.intakeStatus) return;
            const active = w.stability != null || w.difficulty != null;
            wordDatabase[key] = { ...w, intakeStatus: active ? 'active' : 'queued' };
          });
          state = { ...state, wordDatabase };
        }
        // v8: JLPT tag cleanup (docs/jlpt_vocab_audit.md). Drop word records for
        // tombstoned homograph/noise entries — the server keeps (or remaps) the
        // real progress, and the rehydrate pass re-adds remap targets with fresh
        // dictionary data. Covers entry-id keys and legacy surface-keyed records
        // that still carry a tombstoned jmdictEntryId.
        if (version < 8 && state?.wordDatabase) {
          const wordDatabase = { ...state.wordDatabase };
          Object.keys(wordDatabase).forEach((key) => {
            const w = wordDatabase[key];
            if (!w) return;
            if (TOMBSTONED_WORD_IDS.has(w.jmdictEntryId ?? key)) delete wordDatabase[key];
          });
          state = { ...state, wordDatabase };
        }
        // v9: drop local copies of the misattributed homophone rows (する
        // credited to 擦る, いる to 射る, なる to 生る) ONCE — the server-side
        // remap moves that progress to the correct entries and it rehydrates
        // back with fresh dictionary data. No sync block: these are real words.
        if (version < 9 && state?.wordDatabase) {
          const wordDatabase = { ...state.wordDatabase };
          Object.keys(wordDatabase).forEach((key) => {
            const w = wordDatabase[key];
            if (!w) return;
            if (RECOVERABLE_WORD_IDS.has(w.jmdictEntryId ?? key)) delete wordDatabase[key];
          });
          state = { ...state, wordDatabase };
        }
        return state;
      },
      onRehydrateStorage: () => (state) => {
        // Post-hydration cleanup.
        // `processingArticles` tracks in-flight, in-memory processing calls that
        // cannot survive a reload — any entry present at hydration time is stale
        // (the app closed mid-processing). Always clear it, otherwise the stale
        // flag makes handleProcessArticle() / the JIT pre-processor treat the
        // article as "already processing" and silently refuse to retry it.
        if (state) state.processingArticles = [];
        if (state && !Array.isArray(state.dismissedArticleIds)) state.dismissedArticleIds = [];
        if (state && !Array.isArray(state.readArticleIds)) state.readArticleIds = [];
        // #54: trim lists that grew unbounded before the cap existed.
        if (state) {
          state.dismissedArticleIds = capIds(state.dismissedArticleIds);
          state.readArticleIds = capIds(state.readArticleIds);
        }
      }
    }
  )
);
