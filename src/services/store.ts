import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { rtkKanjiList } from '../data/rtkKanji';
import { NewsArticle } from './api';
import { supabase } from './supabase';

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
  if (jlptLevel == null) return 9;      // no JLPT data => assume hard
  if (userLevel == null) return 5;      // unknown user level => neutral
  const delta = userLevel - jlptLevel;  // >0 => word harder than the user
  return clampDifficulty(6 + delta * 2);
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

export interface WordData {
  reading: string;
  meaning: string;
  grammarNote?: string;
  furiganaMap?: { kanji: string; kana: string }[];
  jlptLevel?: number | null;
  jlptDerived?: boolean;
  pos?: string[];
  jmdictEntryId?: string;
  mastery: MasteryLevel;          // derived bucket, kept in sync with `difficulty`
  difficulty?: number | null;     // 1..10 source of truth; null/undefined = unseen
  lastAdjustedDay?: string;       // YYYY-MM-DD of the last difficulty change (daily dedup)
  lastAdjustReason?: 'skip' | 'click' | 'manual';
  timesSeen: number;
  uniqueDaysSeen: string[];
  lastSeenTs: number;
  streak: number;
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
  checkDailyKanji: () => void;
  syncSrsWithSupabase: (userId: string) => Promise<void>;
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
          lastRtkUpdateTs: null 
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
          const current = state.wordDatabase[word] || { reading: '', meaning: '', mastery: 'unseen', timesSeen: 0, uniqueDaysSeen: [], lastSeenTs: 0 };
          // Strip undefined values so partial saves don't erase cached fields (e.g. grammarNote)
          const cleanDef = Object.fromEntries(Object.entries(def).filter(([, v]) => v !== undefined));
          return {
            wordDatabase: {
              ...state.wordDatabase,
              [word]: { ...current, ...cleanDef }
            }
          };
        }),
        
        
      recordWordSeen: (word: string, withoutLookup = false) => 
        set((state) => {
          const today = new Date().toISOString().split('T')[0];
          const current = state.wordDatabase[word] || { reading: '', meaning: '', mastery: 'unseen', timesSeen: 0, uniqueDaysSeen: [], lastSeenTs: 0, streak: 0 };
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

          const updatedWord: WordData = {
            ...current,
            difficulty,
            mastery,
            lastAdjustedDay: today,
            lastAdjustReason: event
          };

          currentUserId().then((uid) => {
            if (uid && updatedWord.jmdictEntryId) {
              import('./api').then(m => {
                m.upsertWordProgressToSupabase(uid, updatedWord.jmdictEntryId!, {
                  mastery: updatedWord.mastery,
                  difficulty,
                  timesSeen: updatedWord.timesSeen,
                  streak: updatedWord.streak,
                  lastSeenTs: updatedWord.lastSeenTs
                });
                m.logStudyEventToSupabase(uid, updatedWord.jmdictEntryId!, 'mastery_change', { difficulty, mastery, event });
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
          const current = state.wordDatabase[word] || { reading: '', meaning: '', mastery: 'unseen', timesSeen: 0, uniqueDaysSeen: [], lastSeenTs: 0, streak: 0 };
          const today = new Date().toISOString().split('T')[0];
          const difficulty = level === 'unseen' ? null : difficultyForBucket(level);
          const updatedWord: WordData = { ...current, mastery: level, difficulty, lastAdjustedDay: today, lastAdjustReason: 'manual' };

          // Sync to Supabase
          currentUserId().then((uid) => {
            if (uid && updatedWord.jmdictEntryId) {
              import('./api').then(m => {
                const syncData = {
                  mastery: updatedWord.mastery,
                  difficulty,
                  timesSeen: updatedWord.timesSeen,
                  streak: updatedWord.streak,
                  lastSeenTs: updatedWord.lastSeenTs
                };
                m.upsertWordProgressToSupabase(uid, updatedWord.jmdictEntryId!, syncData);
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
          }));
        }

        // Pull remote SRS progress (Last Write Wins)
        const remoteProgress = await fetchUserWordProgress(userId);
        set((state) => {
          const newDatabase = { ...state.wordDatabase };
          let changed = false;

          Object.entries(remoteProgress).forEach(([wordId, remoteData]: [string, any]) => {
            const localWord = Object.entries(newDatabase).find(([_, data]) => data.jmdictEntryId === wordId);
            if (localWord) {
              const [wordKey, localData] = localWord;
              if (remoteData.lastSeenTs > localData.lastSeenTs) {
                newDatabase[wordKey] = { ...localData, ...remoteData };
                changed = true;
              }
            }
          });

          if (changed) return { wordDatabase: newDatabase };
          return {};
        });
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
      }
    }),
    {
      name: 'yugen-storage',
      version: 3,
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
