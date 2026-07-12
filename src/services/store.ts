import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { rtkKanjiList } from '../data/rtkKanji';
import { NewsArticle } from './api';
import { supabase } from './supabase';
import { schedule, ratingForReaderEvent, seedSrsFromDifficulty, type SrsState, type SrsStatus } from './srs';
import { selectPromotions, type IntakeItem } from './intake';

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
// persists + syncs the returned record. Used by the daily promotion pass and by an
// explicit manual mastery-set (the two paths that graduate a queued word).
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
  // Prefer an explicitly graded signal (manual > click > skip) over an ungraded one.
  const rank = (w: WordData) =>
    w.lastAdjustReason === 'manual' ? 3 : w.lastAdjustReason === 'click' ? 2 : w.difficulty != null ? 1 : 0;
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
  lastAdjustReason?: 'skip' | 'click' | 'manual';
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
  // a schedule; `active` = promoted into FSRS scheduling. A word is promoted only by the
  // daily new-word cap (foundation-first) or an explicit manual mastery-set. Undefined
  // on legacy records until the v7 migration stamps them.
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
  // Intake queue (#68): the Anki-style daily cap on how many new words graduate from
  // the queue into active study, and when the last promotion pass ran (daily gate).
  newWordsPerDay: number;
  lastIntakePromotionTs: number | null;

  wordDatabase: Record<string, WordData>;
  studyKanji: string[];
  lastRtkUpdateTs: number | null;
  lastResetTs: number | null;
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
  setWordMastery: (word: string, level: MasteryLevel) => void;
  mergeWordRecords: (fromKey: string, toKey: string) => void;
  checkDailyKanji: () => void;
  promoteIntakeQueue: (now: number) => Promise<void>;
  syncSrsWithSupabase: (userId: string) => Promise<void>;
  backfillWordProgress: () => Promise<void>;
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
      newWordsPerDay: 3,
      lastIntakePromotionTs: null,
      wordDatabase: {},
      studyKanji: [],
      lastRtkUpdateTs: null,
      lastResetTs: null,
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
          dismissedArticleIds: Array.from(new Set([...state.dismissedArticleIds, id]))
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
          readArticleIds: Array.from(new Set([...state.readArticleIds, id]))
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

          const today = new Date().toISOString().split('T')[0];
          if (current.lastAdjustedDay === today) {
            const overrides = event === 'click' && current.lastAdjustReason === 'skip';
            if (!overrides) return {};
          }

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
            }
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

          // Explicit manual classification promotes a queued word into active study
          // (#68, D3): opening the modal and declaring a word's difficulty is a direct
          // statement of knowledge — unlike a passive read or a lookup, which only
          // signal "I don't know it" and never fast-track promotion. Setting 'unseen'
          // is not a promotion. Seeds the schedule from the chosen difficulty.
          const shouldActivate = difficulty != null && current.intakeStatus !== 'active' && current.stability == null;
          const base = shouldActivate ? activateWord(current, difficulty, now) : current;
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
                  // On promotion, persist the freshly-seeded schedule + intake status.
                  ...(shouldActivate ? {
                    intakeStatus: 'active',
                    promotedTs: updatedWord.promotedTs,
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
          }));
        }

        // Pull remote SRS progress (Last Write Wins)
        const remoteProgress = await fetchUserWordProgress(userId);
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
                  };
                });
                return { wordDatabase: newDatabase };
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

        // Reconcile local → server: words graded locally but ungraded (or absent)
        // on the server never had their grade persisted (legacy rows / failed past
        // syncs). Local is authoritative — it reflects real reading — so push those
        // grades up. We only FILL server nulls here; an existing server difficulty
        // is left untouched, so this can't clobber a newer cross-device grade.
        const toPush = Object.values(get().wordDatabase)
          .filter((w) => {
            if (!w.jmdictEntryId || w.difficulty == null) return false;
            const remote = remoteProgress[w.jmdictEntryId];
            return !remote || remote.difficulty == null;
          })
          .map((w) => ({
            wordId: w.jmdictEntryId!,
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

      // Backfill cached words that have a JMDict entry id but are missing a JLPT
      // level and/or a difficulty:
      //   - jlptLevel: resolved official → kanji → frequency (matches enrichment).
      //   - difficulty: seeded from the (now-known) JLPT as a read-past 'skip',
      //     exactly like applyDifficultyEvent's first contact, so a word seen before
      //     grading existed stops sitting in the unseen/ungraded bucket.
      // Only seeds difficulty for words actually encountered (timesSeen >= 1) and
      // syncs the seeded grades to Supabase in one batched round-trip.
      backfillWordProgress: async () => {
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
        // If it's the first time or 24 hours (86400000 ms) have passed
        if (!state.lastRtkUpdateTs || now - state.lastRtkUpdateTs > 86400000) {
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
      // backbone gets built even when articles skip it. Gated to once per 24h, mirroring
      // checkDailyKanji; call it on app open alongside that pass.
      promoteIntakeQueue: async (now: number) => {
        const state = get();
        if (state.lastIntakePromotionTs && now - state.lastIntakePromotionTs < 86400000) return;
        // Stamp immediately so a re-entrant call (e.g. a double mount) can't double-promote.
        set({ lastIntakePromotionTs: now });

        const cap = state.newWordsPerDay ?? 3;
        if (cap <= 0) return; // 0 = new words paused

        // Source 1: words already encountered and waiting in the local queue.
        const queuedItems: IntakeItem[] = Object.entries(state.wordDatabase)
          .filter(([, w]) => w.intakeStatus === 'queued')
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
          } catch (e) {
            console.warn('[store] intake candidate fetch failed:', e);
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
      version: 7,
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
            console.error('[store] localStorage persist failed (quota?) — continuing without persisting:', e);
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
        newWordsPerDay: state.newWordsPerDay,
        lastIntakePromotionTs: state.lastIntakePromotionTs,
        wordDatabase: state.wordDatabase,
        studyKanji: state.studyKanji,
        lastRtkUpdateTs: state.lastRtkUpdateTs,
        lastResetTs: state.lastResetTs,
        dismissedArticleIds: state.dismissedArticleIds,
        readArticleIds: state.readArticleIds,
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
      }
    }
  )
);
