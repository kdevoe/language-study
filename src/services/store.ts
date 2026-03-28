import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { rtkKanjiList } from '../data/rtkKanji';

export type MasteryLevel = 'unseen' | 'hard' | 'medium' | 'easy';

export interface WordData {
  reading: string;
  meaning: string;
  grammarNote?: string;
  mastery: MasteryLevel;
  timesSeen: number;
  uniqueDaysSeen: string[];
  lastSeenTs: number;
}

interface AppState {
  isOnboarded: boolean;
  jlptLevel: number | null;
  rtkLevel: number | null;
  unknownKanjiDensity: number; // Percentage 0-100
  furiganaMode: 'always' | 'never' | 'dynamic';
  
  wordDatabase: Record<string, WordData>;
  studyKanji: string[];
  lastRtkUpdateTs: number | null;
  
  setOnboarded: (jlpt: number, rtk: number) => void;
  setJlptLevel: (level: number) => void;
  setRtkLevel: (level: number) => void;
  setUnknownKanjiDensity: (density: number) => void;
  setFuriganaMode: (mode: 'always' | 'never' | 'dynamic') => void;
  resetProgress: () => void;
  
  saveWordDefinition: (word: string, def: { reading: string; meaning: string; grammarNote?: string }) => void;
  recordWordSeen: (word: string) => void;
  setWordMastery: (word: string, level: MasteryLevel) => void;
  checkDailyKanji: () => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      isOnboarded: false,
      jlptLevel: null,
      rtkLevel: null,
      unknownKanjiDensity: 15,
      furiganaMode: 'dynamic',
      wordDatabase: {},
      studyKanji: [],
      lastRtkUpdateTs: null,

      setOnboarded: (jlpt, rtk) => set({ isOnboarded: true, jlptLevel: jlpt, rtkLevel: rtk }),
      
      setJlptLevel: (level) => set({ jlptLevel: level }),
      setRtkLevel: (level) => set({ rtkLevel: level, studyKanji: rtkKanjiList.slice(Math.max(0, level - 15), level), lastRtkUpdateTs: Date.now() }),
      setUnknownKanjiDensity: (density) => set({ unknownKanjiDensity: density }),
      
      setFuriganaMode: (mode) => set({ furiganaMode: mode }),
      
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
        
      recordWordSeen: (word) => 
        set((state) => {
          const today = new Date().toISOString().split('T')[0];
          const current = state.wordDatabase[word] || { reading: '', meaning: '', mastery: 'unseen', timesSeen: 0, uniqueDaysSeen: [], lastSeenTs: 0 };
          const newDays = current.uniqueDaysSeen.includes(today) 
            ? current.uniqueDaysSeen 
            : [...current.uniqueDaysSeen, today];
            
          return {
            wordDatabase: {
              ...state.wordDatabase,
              [word]: { 
                ...current, 
                timesSeen: current.timesSeen + 1,
                uniqueDaysSeen: newDays,
                lastSeenTs: Date.now()
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
    }
  )
);
