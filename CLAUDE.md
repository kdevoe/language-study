# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Yugen Study is a Japanese language learning platform that rewrites real English news articles into Japanese, personalized to the user's JLPT level, RTK kanji progression, and vocabulary mastery. Users read adapted articles with interactive word lookup, furigana, grammar insights, and SRS-based vocabulary tracking.

## Commands

```bash
npm run dev        # Start Vite dev server (port 5173)
npm run build      # TypeScript check + Vite production build
npm run lint       # ESLint
npm run preview    # Preview production build locally
```

Set `VITE_DEV_MODE=true` in `.env` to bypass auth and onboarding during local development.

There is no test suite configured.

### Supabase Edge Functions

Edge Functions live in `supabase/functions/` and run on Deno. They are deployed via the Supabase CLI (`supabase functions deploy <name>`). Local development: `supabase start` then `supabase functions serve`.

## Architecture

**Stack**: React 18 + TypeScript + Vite (frontend), Supabase Postgres + Edge Functions (backend), Gemini 2.0-flash (article rewriting), Groq (dictionary fallback)

### Frontend (`src/`)

- **State**: Zustand store in `services/store.ts`, persisted to localStorage under key `yugen-storage`. All user preferences (JLPT level, RTK level, study/vocab/furigana modes) and word progress live here, with async sync to Supabase.
- **API layer**: `services/api.ts` wraps all Supabase Edge Function calls via `invokeEdgeFn()`. Also handles Supabase persistence (articles, word progress, preferences).
- **Dictionary**: `services/jmdict.ts` queries JMDict tables in Supabase (216k+ entries). Lookup tries kanji form first, then kana, with LLM disambiguation for ambiguous matches.
- **App.tsx** is the main orchestrator: manages auth state, beta whitelist gate, tab routing (Feed/Reader/Settings), and the JIT article pre-processor that keeps 1 article ahead processed.
- **Feed.tsx**: Swipe-to-dismiss article cards with Framer Motion gestures. Replenishes when <5 visible articles remain.
- **Reader.tsx**: Renders processed article blocks with interactive word lookup, sentence translation, and mastery controls.
- **WordModal.tsx**: Dictionary modal with definition, grammar insights, JLPT badges, and mastery quick-set buttons.
- **FuriganaText.tsx**: Renders `<ruby>/<rt>` HTML for furigana display (always/never/dynamic modes).

### Backend

Four Supabase Edge Functions:
- **fetch-raw-news**: Fetches English articles from NewsAPI with multi-query fallback
- **process-article**: Rewrites articles to Japanese via Gemini, personalized to user's JLPT/RTK/vocab targets. Returns structured `ArticleBlock[]` with furigana, grammar boxes, and word tokens
- **dictionary-lookup**: Word definitions (Groq), grammar analysis (Gemini), and sentence translation (Groq)
- **daily-feed**: Scheduled pre-processing of articles

### Database

Schema files in `database/` (numbered 00-09). Key tables: `processed_news` (article cache per user), `user_preferences`, `user_word_progress` (SRS tracking), `study_history` (event log), and JMDict tables (`jmdict_entries`, `jmdict_kanji`, `jmdict_kana`, `jmdict_senses`). All user-facing tables use RLS for per-user isolation.

RPC `check_is_approved(email)` returns `'approved'|'waitlisted'|'not_joined'` for the beta gate.

## Key Conventions

- **Styling**: Typography-first design using Shippori Mincho (serif) + Inter (sans-serif). Zen minimalist aesthetic -- no heavy UI, shadows, or borders. Use existing CSS variables from `index.css` (`--bg-color`, `--bg-card`, `--text-main`, `--accent-primary`, etc.). Do not introduce utility CSS frameworks.
- **News proxy**: Production NewsAPI requests go through the `/api/news` Vercel serverless function (CORS). Localhost uses the client-side `VITE_NEWS_API_KEY` directly.
- **SRS Auto-Bump threshold**: defaults to 3 (in store).
- **RTK progression**: 3 new kanji per day, auto-bumped via `checkDailyKanji()`.
- **Task tracking**: Maintain `docs/task.md` synchronously with project progress. Use `gh` CLI for GitHub issues/project boards.
- **Beta access**: Managed via `waitlist.is_approved` column in Supabase dashboard.

## Environment Variables

See `.env.example`. Required: `VITE_NEWS_API_KEY`, `VITE_GEMINI_API_KEY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. Optional: `VITE_GROQ_API_KEY`, `VITE_DEV_MODE`.
