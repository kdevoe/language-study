import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { rtkKanjiList } from '../data/rtkKanji';
import { NewsArticle } from './api';
import { supabase } from './supabase';

export type MasteryLevel = 'unseen' | 'hard' | 'medium' | 'easy';

export interface WordData {
  reading: string;
  meaning: string;
  grammarNote?: string;
  furiganaMap?: { kanji: string; kana: string }[];
  jlptLevel?: number | null;
  pos?: string[];
  jmdictEntryId?: string;
  mastery: MasteryLevel;
  timesSeen: number;
  uniqueDaysSeen: string[];
  lastSeenTs: number;
  consecutiveUnseen?: number;
}

interface AppState {
  isOnboarded: boolean;
  jlptLevel: number | null;
  rtkLevel: number | null;
  studyMode: 'natural' | 'balanced' | 'study';
  vocabMode: 'natural' | 'balanced' | 'study';
  furiganaMode: 'always' | 'never' | 'dynamic';
  
  wordDatabase: Record<string, WordData>;
  studyKanji: string[];
  lastRtkUpdateTs: number | null;
  lastResetTs: number | null;
  currentArticle: NewsArticle | null;
  articlesCache: Record<string, NewsArticle>;
  processingArticles: string[];
  dismissedArticleIds: string[];
  srsAutoBumpThreshold: number | '';
  readerFontSize: number;
  readerFontWeight: number;
  
  setOnboarded: (jlpt: number, rtk: number) => void;
  setJlptLevel: (level: number) => void;
  setRtkLevel: (level: number) => void;
  setStudyMode: (mode: 'natural' | 'balanced' | 'study') => void;
  setVocabMode: (mode: 'natural' | 'balanced' | 'study') => void;
  setFuriganaMode: (mode: 'always' | 'never' | 'dynamic') => void;
  setCurrentArticle: (article: NewsArticle | null) => void;
  saveProcessedArticle: (id: string, article: NewsArticle) => void;
  setArticlesCache: (cache: Record<string, NewsArticle>) => void;
  dismissArticle: (id: string) => void;
  setProcessing: (id: string, isProcessing: boolean) => void;
  setSrsAutoBumpThreshold: (count: number | '') => void;
  resetFeedForNewDay: (now: number) => void;
  setReaderFontSize: (size: number) => void;
  setReaderFontWeight: (weight: number) => void;
  resetProgress: () => void;
  
  saveWordDefinition: (word: string, def: Partial<WordData>) => void;
  recordWordSeen: (word: string, withoutLookup?: boolean) => void;
  setWordMastery: (word: string, level: MasteryLevel) => void;
  checkDailyKanji: () => void;
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
      wordDatabase: {},
      studyKanji: [],
      lastRtkUpdateTs: null,
      lastResetTs: null,
      currentArticle: null,
      articlesCache: {},
      processingArticles: [],
      dismissedArticleIds: [],
      srsAutoBumpThreshold: 3,
      readerFontSize: 18,
      readerFontWeight: 500,

      setOnboarded: (jlpt, rtk) => set({ isOnboarded: true, jlptLevel: jlpt, rtkLevel: rtk }),
      
      setJlptLevel: (level) => set({ jlptLevel: level }),
      setRtkLevel: (level) => set({ rtkLevel: level, studyKanji: rtkKanjiList.slice(Math.max(0, level - 15), level), lastRtkUpdateTs: Date.now() }),
      setStudyMode: (mode) => set({ studyMode: mode }),
      setVocabMode: (mode) => set({ vocabMode: mode }),
      
      setFuriganaMode: (mode) => set({ furiganaMode: mode }),
      setCurrentArticle: (article) => set({ currentArticle: article }),
      saveProcessedArticle: (id, article) => {
        set((state) => ({ 
          articlesCache: { ...state.articlesCache, [id]: article } 
        }));
        // Mirror to Supabase for persistence across sessions
        import('./api').then(m => {
          supabase.auth.getUser().then(({ data: { user } }) => {
            if (user) m.saveProcessedArticleToSupabase(article, user.id);
          });
        });
      },
      setArticlesCache: (cache) => set({ articlesCache: cache }),
      dismissArticle: (id) => set((state) => ({
        dismissedArticleIds: Array.from(new Set([...state.dismissedArticleIds, id]))
      })),
      setProcessing: (id, isP) => set((state) => {
        const next = new Set(state.processingArticles || []);
        if (isP) next.add(id); else next.delete(id);
        return { processingArticles: Array.from(next) };
      }),
      resetFeedForNewDay: (now) => set({ 
        dismissedArticleIds: [], 
        lastResetTs: now 
      }),
      setSrsAutoBumpThreshold: (count) => set({ srsAutoBumpThreshold: count }),
      setReaderFontSize: (size) => set({ readerFontSize: size }),
      setReaderFontWeight: (weight) => set({ readerFontWeight: weight }),
      
      resetProgress: () => set({ 
        isOnboarded: false, 
        jlptLevel: null, 
        rtkLevel: null, 
        wordDatabase: {}, 
        studyKanji: [], 
        lastRtkUpdateTs: null 
      }),
      
      saveWordDefinition: (word, def) => 
        set((state) => {
          const current = state.wordDatabase[word] || { reading: '', meaning: '', mastery: 'unseen', timesSeen: 0, uniqueDaysSeen: [], lastSeenTs: 0 };
          return {
            wordDatabase: {
              ...state.wordDatabase,
              [word]: { ...current, ...def }
            }
          };
        }),
        
      recordWordSeen: (word, withoutLookup = false) => 
        set((state) => {
          const today = new Date().toISOString().split('T')[0];
          const current = state.wordDatabase[word] || { reading: '', meaning: '', mastery: 'unseen', timesSeen: 0, uniqueDaysSeen: [], lastSeenTs: 0, consecutiveUnseen: 0 };
          const newDays = current.uniqueDaysSeen.includes(today) 
            ? current.uniqueDaysSeen 
            : [...current.uniqueDaysSeen, today];
            
          const newConsecutive = withoutLookup ? (current.consecutiveUnseen || 0) + 1 : 0;
            
          return {
            wordDatabase: {
              ...state.wordDatabase,
              [word]: { 
                ...current, 
                timesSeen: current.timesSeen + 1,
                uniqueDaysSeen: newDays,
                lastSeenTs: Date.now(),
                consecutiveUnseen: newConsecutive
              }
            }
          };
        }),

      setWordMastery: (word, level) => 
        set((state) => {
          const current = state.wordDatabase[word] || { reading: '', meaning: '', mastery: 'unseen', timesSeen: 0, uniqueDaysSeen: [], lastSeenTs: 0 };
          return {
            wordDatabase: {
              ...state.wordDatabase,
              [word]: { ...current, mastery: level }
            }
          };
        }),

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
      version: 2,
      migrate: (persistedState: any, version: number) => {
        if (version < 2) {
          return {
            ...persistedState,
            processingArticles: [],
            dismissedArticleIds: [],
            currentArticle: null
          };
        }
        return persistedState;
      },
      onRehydrateStorage: () => (state) => {
        // Post-hydration cleanup
        if (state && !Array.isArray(state.processingArticles)) state.processingArticles = [];
        if (state && !Array.isArray(state.dismissedArticleIds)) state.dismissedArticleIds = [];
      }
    }
  )
);
