import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type MasteryLevel = 'unseen' | 'hard' | 'easy' | 'known';

interface AppState {
  isOnboarded: boolean;
  jlptLevel: number | null;
  rtkLevel: number | null;
  furiganaMode: 'always' | 'never' | 'dynamic';
  
  wordMastery: Record<string, MasteryLevel>;
  studyKanji: string[];
  lastRtkUpdateTs: number | null;
  
  setOnboarded: (jlpt: number, rtk: number) => void;
  setFuriganaMode: (mode: 'always' | 'never' | 'dynamic') => void;
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
      wordMastery: {},
      studyKanji: [],
      lastRtkUpdateTs: null,

      setOnboarded: (jlpt, rtk) => set({ isOnboarded: true, jlptLevel: jlpt, rtkLevel: rtk }),
      
      setFuriganaMode: (mode) => set({ furiganaMode: mode }),
      
      setWordMastery: (word, level) => 
        set((state) => ({
          wordMastery: { ...state.wordMastery, [word]: level }
        })),

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
