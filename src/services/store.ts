import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type MasteryLevel = 'unseen' | 'hard' | 'easy' | 'known';

export interface WordData {
  reading: string;
  meaning: string;
  grammarNote?: string;
  mastery: MasteryLevel;
  timesSeen: number;
  uniqueDaysSeen: string[];
}

interface AppState {
  isOnboarded: boolean;
  jlptLevel: number | null;
  rtkLevel: number | null;
  furiganaMode: 'always' | 'never' | 'dynamic';
  
  wordDatabase: Record<string, WordData>;
  studyKanji: string[];
  lastRtkUpdateTs: number | null;
  
  setOnboarded: (jlpt: number, rtk: number) => void;
  setFuriganaMode: (mode: 'always' | 'never' | 'dynamic') => void;
  
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
      furiganaMode: 'dynamic',
      wordDatabase: {},
      studyKanji: [],
      lastRtkUpdateTs: null,

      setOnboarded: (jlpt, rtk) => set({ isOnboarded: true, jlptLevel: jlpt, rtkLevel: rtk }),
      
      setFuriganaMode: (mode) => set({ furiganaMode: mode }),
      
      saveWordDefinition: (word, def) => 
        set((state) => {
          const current = state.wordDatabase[word] || { reading: '', meaning: '', mastery: 'unseen', timesSeen: 0, uniqueDaysSeen: [] };
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
          const current = state.wordDatabase[word] || { reading: '', meaning: '', mastery: 'unseen', timesSeen: 0, uniqueDaysSeen: [] };
          const newDays = current.uniqueDaysSeen.includes(today) 
            ? current.uniqueDaysSeen 
            : [...current.uniqueDaysSeen, today];
            
          return {
            wordDatabase: {
              ...state.wordDatabase,
              [word]: { 
                ...current, 
                timesSeen: current.timesSeen + 1,
                uniqueDaysSeen: newDays
              }
            }
          };
        }),

      setWordMastery: (word, level) => 
        set((state) => {
          const current = state.wordDatabase[word] || { reading: '', meaning: '', mastery: 'unseen', timesSeen: 0, uniqueDaysSeen: [] };
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
          // Mock adding 3 new kanji to study list
          const newKanjiCount = 3;
          // In a real app, this would pick the next 3 unlearned Kanji based on RTK index
          const mockNewKanji = ['間', '言', '葉'].slice(0, newKanjiCount); 
          
          set((s) => ({
            studyKanji: Array.from(new Set([...s.studyKanji, ...mockNewKanji])),
            lastRtkUpdateTs: now
          }));
        }
      }
    }),
    {
      name: 'yugen-storage',
    }
  )
);
