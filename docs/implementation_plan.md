# Yūgen News

A typography-first Japanese reading application focusing on a "Zen-like" user experience.

## User Review Required
- Is there a specific RSS feed or News API you'd prefer for fetching articles, or should we use placeholder articles for now?
- For the AI personalization (LLM rewriting), should we mock the rewrite functionality initially, or do you have an API key/provider in mind?
- Do you approve the creation of a React/Vite web application in the current directory using Vanilla CSS?

## Proposed Changes

### Project Setup
#### [NEW] `package.json`
#### [NEW] `vite.config.ts`
#### [NEW] `index.html` (Typography links to Google Fonts)
#### [NEW] `src/index.css` (Base typography-first minimal styling)

### Components
#### [NEW] `src/App.tsx` (Main layout, Reader and Onboarding entry)
#### [NEW] `src/components/Reader.tsx` (Invisible UI reading experience)
#### [NEW] `src/components/WordModal.tsx` (Bottom sheet for word details and "Yūgen" context style)
#### [NEW] `src/components/FuriganaText.tsx` (Dynamic ruby annotations)
#### [NEW] `src/components/Onboarding.tsx` (JLPT/RTK quiz)

### State & Services
#### [NEW] `src/services/store.ts` (State persistence using Zustand or Context + LocalStorage)
#### [NEW] `src/services/ai.ts` (Stubbed logic for rewriting text and introducing new concepts)
#### [NEW] `src/services/kanji.ts` (RTK list logic and daily schedule)

## Verification Plan
### Automated Tests
- We will rely on manual visual testing initially. Once core components are structured, we will add unit tests for the spacing and ruby tag (furigana) logic using Vitest if needed.
### Manual Verification
- Render the Reader component and verify that the UI is completely devoid of distracting chrome.
- Tap a Japanese word in the text to ensure the WordModal bottom sheet opens elegantly, displaying RTK definitions and grammar points.
- Verify that Furigana settings (always/never/dynamic) change the display immediately.
