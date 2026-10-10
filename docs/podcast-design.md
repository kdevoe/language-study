# Generated Podcasts — Exploration & Scope (#12)
Status: **v1 built, 2026-10-09** (branch `feat/podcasts`, stacked on #136). Decisions are in §9; what shipped, and where it deviates from this doc, is in §10.

The idea: reuse the personalization machinery behind news and long-form to write a Japanese **podcast script** tuned to the listener. ElevenLabs turns the script into audio. A player plays the audio with a **scrolling transcript you can interact with**: tap a word for WordModal, tap a sentence to seek. This is issue #12, broadened from a "daily digest" to podcasts in general.

* * *
## 1. What exists today (and what doesn't)
| Area | State | Reuse |
| --- | --- | --- |
| Script generation | `process-article` + `_shared/rewritePrompt.ts` (lexicon ALLOWED LIST, JLPT/RTK, `longform` variant with continuity) | Add a `podcast` prompt variant. Lexicon, review words and level config come along as-is |
| Job model | `processed_news.status` pending → ready / failed, with stale-claim reclaim (5 min) and 409-while-fresh. Client polls (Reader's next-part pattern) | Same claim/poll pattern for episodes |
| Caps | 3 imports + 15 parts per rolling 24h (`import_limit` 429) | Same pattern: episodes per day |
| Transcript rendering | `FuriganaText`, `WordModal`, `YugenBox`, `enrichArticle` (client-side kuromoji + JMDict) | Reusable, **but** `renderParagraph`, the tap handlers and grading live inline in `Reader.tsx` and need extracting (§6) |
| Library | 書庫 tab: filter pills, flat card list, import sheet, in-flight placeholder card | Podcasts could live here as a filter (§9 Q3) |
| Audio / TTS | **None.** No audio code, no `speechSynthesis`, no Supabase Storage usage at all | All new |
| Background work | No queue, no `waitUntil`. pg_cron + `net.http_post` for overnight jobs | Needed if episodes are pre-generated |

The roadmap (`path-forward-2026-07.md` §3.2) recommended cheap word-level TTS before #12 to "establish audio plumbing". The podcast work below _is_ that plumbing (Storage, audio player, Media Session). So word-level TTS becomes a small follow-on, not a prerequisite.

* * *
## 2. TTS provider: ElevenLabs (confirmed as the right default)
Research summary (Oct 2026, sources at the end):

- `POST /v1/text-to-dialogue/with-timestamps` does multi-speaker dialogue in **one call**, with up to 10 voices. It returns **per-character alignment** plus `voice_segments`, which give each turn's start/end time and its character range. That is exactly the data needed to highlight the transcript. Character-level matters for Japanese because there are no spaces to split on, and we can map characters to kuromoji tokens ourselves.
  
- **Request size:** keep each dialogue request at or under about 2,000 chars. Longer requests risk being cut short. A 5-minute Japanese episode is about 1,300–1,700 chars (natural speech runs at roughly 300 chars/min, slower for learners), so **one request per episode** for v1. Longer episodes split by segment and concatenate, offsetting the times.
  
- **Models:** v3 is the dialogue default; v4 is the new flagship. All list Japanese, but nobody here has _listened_ yet → spike (§8 P0).
  
- **Cost:** about $0.08 per 1k chars on PAYG, so **about $0.12–0.16 per 5-min episode** (a v4 promo runs to Oct 12). Script generation adds pennies. Plans start at $6 / $22 / $99 per month.
  
- **Plain REST**, with JSON containing base64 MP3. A single `fetch` from a Deno edge function works; no SDK needed.
  

**Alternatives considered:**

- **Gemini TTS:** very natural Japanese, but max 2 speakers, **no timestamps** (we'd need a separate forced-alignment pass) and WAV only.
  
- **Azure:** has word boundaries, but only via the SDK WebSocket; awkward from Deno.
  
- **Google Chirp 3 HD:** probably no timepoints.
  
- **OpenAI:** weaker Japanese and no timestamps.
  

Fallback if the ElevenLabs Japanese disappoints in the spike: Gemini TTS for the audio plus the ElevenLabs forced-alignment API for timing.

**Known risks to test in the spike:**

1. **Kanji misreadings.** Pronunciation dictionaries only reliably support _alias_ rules for Japanese (生物 → せいぶつ), and one report says even those don't always apply. The robust fix is to send kana for ambiguous words in the TTS text while showing kanji in the transcript. That needs an index map, because alignment then refers to the TTS string, not the displayed one. **v1 proposal:** send the displayed text verbatim, so alignment maps 1:1. Measure the misread rate, and only add kana substitution if it's a real problem.
  
2. **Speed.** The dialogue endpoint doesn't document a speed setting. But **client-side** `audio.playbackRate` (0.75 / 0.9 / 1.0, pitch-preserving in modern browsers) covers learner speed for free, and alignment times scale with it automatically. So server-side speed is a nice-to-have, not a blocker.
  
3. **Alignment accuracy** on Japanese with v3/v4.
  

* * *
## 3. What is an episode? (the biggest open question)
Three content models, not mutually exclusive:

| Model | Source | Pros | Cons |
| --- | --- | --- | --- |
| **A. Daily digest** (#12 as written) | 2–4 of today's raw news items in the user's feed topics | "Morning radio" habit; zero user effort; fits pre-generation by pg_cron | Generated whether or not it's listened to → cost; hard to tie to reading |
| **B. Companion episode** | An article or work the user has read (or will read) | Ears + eyes on the **same vocabulary** is great reinforcement; the source is already processed; the user chooses | Content repeats what they just read; less "new" |
| **C. On-demand topic** | User types a topic or pastes text/URL (like BYOC) | Max agency; reuses the long-form import flow | Another input surface; the most variable quality |

**Recommendation:** start with **B and C on demand** (one "make a podcast" path that accepts an article/work, pasted text or a topic). Add **A** later as a pg_cron job once per-episode cost and listening habits are known. B is the most pedagogically distinctive: hear the words you just looked up.

* * *
## 4. Script generation
A new `podcast` variant in `rewritePrompt.ts`, alongside `longform`. The news prompt stays byte-identical (eval baseline rule).

- **Format:** two hosts (e.g. a curious host + a knowledgeable guest) in a natural 対談 style. Dialogue gives natural turn-taking, built-in repetition and rephrasing ("つまり…ということですね"), and questions that scaffold comprehension, all of which help listeners more than a monologue.
  
- **Listening difficulty is harder than reading difficulty.** You can't re-read, and there's no kanji to lean on. The lexicon ALLOWED LIST still applies. On top of it:
  
  - shorter sentences;
    
  - more repetition of key terms;
    
  - explicit signposting;
    
  - review words used 2–3 times each.
    
- **Possibly a level step down from reading** (§9 Q4).
  
- **Output shape:** turns, not paragraphs:
  
  ```ts
  type PodcastTurn = { speaker: 'host' | 'guest'; text: string };   // plain Japanese, no furigana
  type PodcastScript = { title: string; turns: PodcastTurn[]; vocab?: YugenBoxBlock[] };
  ```
  
  `vocab` reuses yugen-box items as "words in this episode" shown before or after listening.
  
- **Target length:** about 1,500 chars (roughly 5 min) for v1. Validate with `validateBlocks`-style checks: turn count, total chars at or under 2,000, speakers alternate.
  
- **Eval:** new fixtures in `scripts/eval-article-rewrite.mjs`. Judge criteria need a "listenability" axis (sentence length, repetition, register) on top of jlptFit / fidelity / naturalness. Per the standing rule, this must pass the harness before shipping.
  

* * *
## 5. Backend pipeline
**New edge function** `generate-podcast`**.** Take the user from the **JWT** (process-article's `userId`-in-body with `verify_jwt=false` is a pattern we shouldn't copy).

```
client: POST generate-podcast {source: {articleId | workId | text | url | topic}}
  1. claim: insert podcast_episodes row status='scripting'          (409 if a fresh claim exists; 429 at cap)
  2. script: Gemini podcast variant → turns[]                       → status='voicing'
  3. voice:  ElevenLabs text-to-dialogue/with-timestamps            (one request for ≤2k chars)
  4. store:  MP3 → Storage `podcasts/{user_id}/{episode_id}.mp3`; alignment jsonb → row
  5. status='ready'   (any error → 'failed' + retry affordance)
client polls the row (Reader next-part pattern: every 5s) → plays via signed URL
```

- **Wall clock:** script (20–40s, flash burns thought tokens on lexicon prompts) plus TTS (likely 10–30s for 1.5k chars) is close to the edge-function budget for one request. Two options:
  
  - split it into two invocations (`scripting` → self-fetch → `voicing`), the same server-to-server chain ensure-buffer already uses;
    
  - use `EdgeRuntime.waitUntil` and return 202 immediately.
    
  
  Either way the client only ever polls the status.
  
- **Table** (new migration `28_podcasts.sql`, applied manually per usual):
  
  ```sql
  create table podcast_episodes (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references auth.users not null,
    title text not null,
    source_kind text not null,          -- article | work | text | url | topic | digest
    source_ref text,                    -- processed_news id / work id / url
    status text not null default 'scripting',  -- scripting | voicing | ready | failed
    script jsonb,                       -- PodcastScript (turns, vocab)
    alignment jsonb,                    -- per-turn char start/end times (compacted, see below)
    audio_path text,                    -- storage object path
    duration_ms int,
    tts_model text, voices jsonb,       -- provenance for re-renders / A-B
    listen_position_ms int default 0,   -- invisible resume, like long-form
    status_detail text, usage jsonb,
    created_at timestamptz default now()
  );
  ```
  
  Plus RLS "own rows", and a private Storage bucket with a per-user path policy.
  
- **Alignment storage:** ElevenLabs returns parallel arrays of character / start / end. Store **per turn** `{charStartsMs: int[]}` (one number per character of `turn.text`). A 1,500-char episode is about 10 KB. The client derives token and sentence start times from character offsets after kuromoji tokenizes the transcript, so the server never needs a tokenizer.
  
- **Why not reuse** `long_form_works` **/** `processed_news`**?** Episodes have a different shape (turns + audio + alignment, not paragraph blocks), and putting them in `processed_news` would mean another `source_type` value and CHECK-constraint churn for no Reader reuse. Word tracking is client-side and keyed by word, not by article row, so a separate table loses nothing.
  
- **Caps / cost guard:** e.g. 3 episodes per rolling 24h per user (`podcast_limit` 429). At about $0.15 each, that's a worst case of about $0.45 per user per day for the beta.
  
- **New secrets:** `ELEVENLABS_API_KEY`. Voice IDs and model go in `_shared/models.ts` (`ELEVEN_DIALOGUE_MODEL`, `PODCAST_VOICES`) so there's one place to bump them.
  

* * *
## 6. Listening UI
Interactive mockup: `docs/mockups/listen.html` (LISTEN tab + player). It plays two real v4 episodes with the designed cast when `scripts/podcast-spike/audio/` is present locally, and falls back to a simulated clock otherwise.

### 6.1 Selecting podcasts
**Decided (your input, 2026-10-09): Podcasts replaces Settings in the bottom nav.** Settings is already reachable from the header gear (`App.tsx:684`), so the bottom-bar entry is redundant. The nav becomes `NEWS · LIBRARY · LISTEN · REVIEW · PROGRESS`, still 5 tabs, so there's no crowding. The flashcards tab is also renamed **STUDY → REVIEW** (label only; the `flashcards` tab id stays), in the same PR.

- Changes:
  
  - in `BottomNav.tsx`, swap the `settings` entry for `listen` (label LISTEN, lucide `Headphones` icon). The rail keeps today's lucide icons and active-pill styling, not the kanji glyphs used in mockups (review 2026-10-09). Settings stays as an `activeTab` value reachable only from the header;
    
  - in `App.tsx`, add `podcastView` state (list | player) alongside `newsView` / `libraryView`, plus `isReading`-style nav hiding and back-button branches while the player is open.
    
- Order: LISTEN sits next to LIBRARY, since both are "content you chose". Open to reordering.
  
- **The LISTEN tab** has the same flat card list + filter pills idiom as 書庫. Pills could be すべて / 未再生 / 再生中 / 完了. Each card shows the title, source (記事 / トピック / テキスト), duration and a progress line. A `+` sheet creates an episode from a topic, pasted text or URL. While an episode generates, a placeholder card appears (as Library does for imports).
  
- **Entry points elsewhere:** a "🎧 ポッドキャストにする" action at the end of an article/part (the companion model B), which creates the episode and shows it in the LISTEN tab.
  
- **Mini-player:** when you leave the player while audio is playing, a slim bar above the bottom nav keeps playback going across tabs. This is v2 polish, but the state should live in a store slice (not player-local) from day one so it's possible.
  
### 6.2 The player
Same chrome-free aesthetic as the Reader: text is the interface.

- **Transcript** rendered with the shared paragraph component. Each turn is a block with a subtle speaker marker (a name in small Inter caps or an indent, not chat bubbles; zen, no borders).
  
- **Active sentence highlight:** a soft background tint (`--accent-primary` at low alpha). Optionally karaoke-style token highlighting inside the sentence (we have per-character times, so it's cheap). Start with sentence-level; token-level is a toggle to try.
  
- **Auto-scroll:** keeps the active sentence about 40% down the screen. If the user scrolls manually, auto-scroll **pauses** and a small "↓ 再生位置へ" pill appears to re-sync (the Apple Music lyrics pattern).
  
- **Interactions:**
  
  - tap a word → **pause** + WordModal; closing resumes, configurable;
    
  - tap a sentence's 。 or double-tap → seek there + play;
    
  - long-press a sentence → translation (the existing `fetchSentenceTranslation`).
    
- **Transport bar** (bottom, minimal): play/pause, previous/next sentence (better than ±10s for learning), a speed chip (0.75 / 0.9 / 1.0 via `playbackRate`), and a furigana mode chip.
  
- **Listen-first mode** (toggle): the transcript is blurred or hidden until tapped, for real listening practice. Cheap to build, high pedagogical value.
  
- **Platform:**
  
  - **Media Session API** for lock-screen controls and title/artwork;
    
  - continue playing when the app is backgrounded;
    
  - iOS PWA background audio is fragile, so test on device early (cf. the PWA memories);
    
  - persist `listen_position_ms` (debounced) for invisible resume.
    
- **Offline:** a Workbox runtime-cache rule for the audio path (like the kuromoji rule). This is v2.
  
### 6.3 Refactor needed first
`renderParagraph`, `handleWordClick` / `handleDictionaryLookup` / `handleSentenceTranslate` and the IntersectionObserver grading are inlined in `Reader.tsx` and closed over Reader state. Extract them into:

- a `useWordInteraction()` hook (tap → modal, lookup, mastery, translation);
  
- an `<InteractiveParagraph block sentenceIdPrefix activeSentenceId>` component.
  

The Reader is then refactored onto these with **no behaviour change**, and the player reuses both. This is the riskiest frontend step. Do it as its own PR and verify the Reader end to end.

* * *
## 7. SRS / word tracking
- **Lookups count exactly as in the Reader**: `recordWordSeen`, `applyDifficultyEvent('click')`, `study_history`. A word you had to look up while listening is a real struggle signal.
  
- **No passive "skip" credit from playback** in v1. The Reader's dwell-on-screen grading is wrong for audio: hearing a word ≠ knowing it, and the SRS audit already found the deck starved by over-generous reader_skip credit.
  
- **Listening mastery** (#12's "separate weighting for listening vs reading") is real but deferred. It needs its own design: what counts as "understood by ear"? A listen-first mode with self-report per sentence would be one signal. Flagged as Phase 3.
  
- Respect **Sandbox mode** (`sandboxMode` gates all word-progress writers already; the player just uses the same actions).
  

* * *
## 8. Phasing
| Phase | Scope | Exit criteria |
| --- | --- | --- |
| **P0 Spike** (1 session) | `scripts/spike-podcast.mjs`: take 1–2 existing processed articles → Gemini dialogue script (draft prompt) → ElevenLabs dialogue-with-timestamps (v3 and v4, 2–3 voice pairs) → write MP3 + alignment JSON + a static HTML page that highlights along. No app changes | You listen and pick voices/model; misread rate is acceptable or the kana-substitution need is confirmed; alignment-to-token mapping proven; real cost and latency per episode measured |
| **P1 Backend** | Migration 28 (table + bucket + RLS), `generate-podcast` fn (claim → script → voice → store), `podcast` prompt variant + eval fixtures, caps | Episodes generate end to end from article / text / topic; the eval harness passes; news prompt byte-identical |
| **P2 Frontend** | Reader refactor PR (no behaviour change) → LISTEN tab replaces SETTINGS in BottomNav + episode list + create sheet + "make podcast" action → player (transcript, highlight, auto-scroll, tap-to-pause / lookup, seek, speed, resume, Media Session) | Usable on iOS PWA + desktop, Sandbox ON test |
| **P3 Later** | Daily digest via pg_cron (model A), listen-first mode + listening mastery, token-level karaoke, offline caching, word-level TTS in WordModal / flashcards (reuse Storage + player plumbing), kana substitution if needed | —   |

* * *
## 9. Decisions (review 2026-10-09)
1. **Content model:** all three. Daily digest (A) is in alongside companion (B) and on-demand (C).
2. **Format:** two-host dialogue with **named personalities**, drawn from a rotating cast of several. Mix male and female voices and **dialects**: e.g. a mild 関西弁 host paired with a 標準語 guest, which also gives dialect exposure. Casts are config (persona + dialect + voice id), so adding one needs no code.
3. **Placement:** a **LISTEN** tab replaces SETTINGS in the bottom nav; STUDY is renamed REVIEW. Nav: NEWS · LIBRARY · LISTEN · REVIEW · PROGRESS.
4. **Difficulty:** listening drops below reading. The spike prompt targets one JLPT level easier than the reading level (N4 → N5) and reuses the article's own vocabulary.
5. **Length:** 5 min to start, with longer episodes coming. The renderer chunks at turn boundaries (each request at or under 1,900 chars) and stitches with `previous_request_ids` from day one.
6. **Budget:** OK, **no per-user cap** for now (keep the claim/409 guard against double-generation).
7. **Mockups first** for the LISTEN tab + player, before frontend code.

**Current focus: the P0 spike, ElevenLabs v3 vs v4 on our Japanese content.** `scripts/spike-podcast.mjs`:
- Source: the gemini-3.8-flash eval rewrites, four fixtures from N5 to N2.
- Gemini writes two-host scripts (the tokyo and kansai casts) of about 1,400 chars each.
- Both models voice the identical script.
- Output: `scripts/podcast-spike/compare.html` with synced, clickable transcripts, speed control and per-model latency, duration and credits used.

### Spike results (2026-10-09)
- **Alignment works for Japanese.** On both models, per-character timestamps matched the script text 1:1 (no normalization drift) and ran in order, with one request per 1,400-char episode. The transcript can be built straight from the stored script.
- **Model: v4 (tentative).**
  - About 33s to generate an episode vs about 50s for v3.
  - Cleaner audio: every voice's noise floor is 7–20 dB lower than on v3.
  - Speaks at 350–405 chars/min vs v3's 270–370. Use player speed for learners.
  - v3 reproduced a noisy library voice's static (Kaito: -37 dB floor). v4 doesn't.
- **Voices: designed, not library.** Library voices sounded clean enough on v4 but none were liked. They also vary by about 15 dB in loudness. All 7 Voice Design voices (`eleven_ttv_v3`) were liked. They measure about -86 dB noise floor (silent) and sit within about 2 dB of each other in loudness.
- **Cast voices must not be high-pitched.** Kyoko (232 Hz) and Hiyori (235 Hz) were rejected as too high. Female cast voices target roughly ≤ 210 Hz.
- **Cast admission process:**
  1. Voice Design → three previews.
  2. QC: noise floor under -50 dB; pitch; loudness gain to -20 LUFS.
  3. Save the chosen preview as an account voice (`yugen-*`).
  4. Record `voice_id` + `gainDb` + persona in the cast config.

  The spike's `design` / `audition` / `qc` commands implement this.
- **Designed voices (in the account):**

  | id | Voice | Pitch |
  | --- | --- | --- |
  | kansai-m | Kansai host, M 30s | 137 Hz |
  | kansai-f | Kansai co-host, F late 20s | 239 Hz (preview 2 at 208 Hz is the lower alternative) |
  | tokyo-f-host | standard host, F 30s alto | 208 Hz |
  | tokyo-f-older | narrator, F 50s | 178 Hz |
  | tokyo-m-guest | explainer, M 40s | 120 Hz |
  | tokyo-m-young | co-host, M 20s | 131 Hz |
  | hakata-m | Hakata host, M 30s | 136 Hz |

  The kansai-f saved preview stays as is (reviewed: preferred over the lower preview 2).

### Cast rotation (decided 2026-10-09)
There are no fixed pairs. The cast is a **pool of personas**, and every episode draws a fresh host + guest pairing so the show keeps changing.

- **Persona** = designed voice + Japanese name + personality blurb + dialect + `gainDb`. It lives in a config file (`_shared/podcastCast.ts`), so adding a voice is config-only. Each persona keeps the same name and personality wherever it appears, so listeners get to know the "regulars".
- **Pairing rule**, per user, using the `voices` recorded on their past `podcast_episodes`:
  1. Host ≠ guest.
  2. Never repeat the previous episode's pair, in either order.
  3. Prefer the least-recently-heard pairing.
  4. Prefer mixed gender.
  5. At most one dialect speaker per episode, so a learner always has a 標準語 anchor.
- **The script prompt receives both personas.** The dialogue therefore carries each persona's personality and dialect, as in the spike's casts.
- **Starting pool (7):**

  | Persona | Voice | Notes |
  | --- | --- | --- |
  | ハルカ | tokyo-f-host | standard, 30s |
  | ヨウコ | tokyo-f-older | standard, 50s |
  | ソウタ | tokyo-m-guest | standard explainer, 40s |
  | ユウキ | tokyo-m-young | standard, 20s |
  | ケンジ | kansai-m | 関西弁 |
  | アヤ | kansai-f | 関西弁 |
  | タクミ | hakata-m | 博多弁 |

  Names are placeholders; rename freely.

## 10. Implementation (v1, 2026-10-09)
**Backend (deployed to production 2026-10-09, with approval):**
- Migration `database/28_podcasts.sql` has been applied:
  - `podcast_episodes` table, with RLS allowing users to read, update and delete their own rows;
  - private `podcasts` bucket, readable only from the user's own folder.
- `ELEVENLABS_API_KEY` is set as a function secret.
- `generate-podcast` is deployed. It runs scripting and voicing as **two invocations** (the script stage re-invokes the function), so each stage has its own wall-clock budget. One request per 1,900 chars, stitched with `previous_request_ids`.
- Shared modules:
  - `_shared/podcastCast.ts`: personas plus `pickPairing`, implementing the rotation rule;
  - `_shared/podcastPrompt.ts`: the prompt, kept separate from `rewritePrompt.ts`, which is unchanged;
  - `_shared/elevenlabs.ts`: dialogue rendering and alignment;
  - `ELEVEN_DIALOGUE_MODEL = 'eleven_v4'` in `models.ts`.
- First production episode: today's digest for the owner account. Script 18s, voice 24s; all 29 turns aligned 1:1 with the text.
  - It ran 2:39 against a 5-minute target. v4 speaks about 385 chars/min, so `CHARS_PER_MINUTE` went from 280 to **370**, and the prompt now asks for *at least* the target.
  - Re-checked Gemini-only with `scripts/eval-podcast-script.mjs`: 2,059–2,127 chars against a 1,850 target, about 5.6 min.

**Frontend:**
- LISTEN replaces SETTINGS in the bottom nav. `Listen.tsx` has the list, filters and create sheet. Today's digest is requested automatically on the first visit each day.
- `PodcastPlayer.tsx`: transcript tokenized by the client tokenizer; per-word timings come from the character alignment.
  - DOM-class highlighting with no per-frame React renders.
  - Auto-scroll with ↓ 再生位置へ.
  - Tap a word to pause and open WordModal; playback resumes when it closes. Tap 。 to translate the sentence; double-tap a sentence to seek.
  - Sentence-step ⏮/⏭, speed 0.75–1.15×, 耳で聴く (listen-first), Media Session, and a saved listening position.
- `hooks/useWordLookup.ts`: the Reader's lookup and translation logic, extracted verbatim (§6.3). The Reader now uses it too, re-verified in the browser.

**Deviations from this doc (follow-ups):**
- **No mini-player yet.** Leaving the player stops audio, because the player unmounts. A store-level audio slice is needed.
- **No ふ toggle.** `FuriganaText` has no ruby mode (readings show on long-press, as in the Reader), so the player matches the Reader.
- **Digest is on-demand, not cron.** It's created the first time LISTEN opens each day, so it costs nothing for users who don't open the tab. A pg_cron pre-generation job can call the function with the service key plus `userId` (already supported).
- **Topic, text and URL episodes don't get the reader's lexicon (ALLOWED LIST).** They're pitched by JLPT level only. Article and digest episodes inherit the lexicon through the already-personalized source text.
- **Listening mastery** (§7) is not built. Lookups count as in the Reader; there is no passive credit for playback.
- **Local dev:** Vite serves `kuromoji-dict/*.dat.gz` with `Content-Encoding: gzip`, so the tokenizer fails under `npm run dev` / `preview`. This is a pre-existing issue that also affects the Reader. To test the player locally, serve a `VITE_DEV_MODE` build from a plain static server. `node scripts/spike-podcast.mjs export-dev <episodeId>` copies a real episode to `public/podcast-dev/` (ignored) for dev mode.

## Sources (TTS research)
- ElevenLabs text-to-dialogue with timestamps: [https://elevenlabs.io/docs/api-reference/text-to-dialogue/convert-with-timestamps](https://elevenlabs.io/docs/api-reference/text-to-dialogue/convert-with-timestamps)
  
- Models: [https://elevenlabs.io/docs/overview/models](https://elevenlabs.io/docs/overview/models) · Pricing: [https://elevenlabs.io/pricing/api](https://elevenlabs.io/pricing/api)
  
- Forced alignment: [https://elevenlabs.io/docs/capabilities/forced-alignment](https://elevenlabs.io/docs/capabilities/forced-alignment)
  
- Pronunciation dictionaries (Japanese alias caveat): [https://elevenlabs.io/docs/product/prompting/pronunciation](https://elevenlabs.io/docs/product/prompting/pronunciation) · [https://dev.classmethod.jp/articles/elevenlabs-pronunciation-dictionary-japanese-fallback/](https://dev.classmethod.jp/articles/elevenlabs-pronunciation-dictionary-japanese-fallback/)
  
- Gemini TTS: [https://ai.google.dev/gemini-api/docs/speech-generation](https://ai.google.dev/gemini-api/docs/speech-generation)
  
- Azure synthesis events: [https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-speech-synthesis](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-speech-synthesis)
  
- Google Cloud TTS pricing: [https://cloud.google.com/text-to-speech/pricing](https://cloud.google.com/text-to-speech/pricing)

---
comments:
  c1:
    body: Lets add daily digest, two host dialog (and yes do personalities, maintain
      several. Want to get a variety of male/female voices and dialects going).
      Instead of Podcasts label it as listen. Difficult should drop. 5 mins ok
      to start, we will want to go longer than that. Budget ok, don't have a cap
      right now. Sure mockups first. I'm really mostly interested in the spike
      of elevenlabs v3 vs v4 on our japanese content
    by: user
    at: 2026-10-09T23:30:13.321Z
  c2:
    body: All recorded in §9 Decisions. Spike script is built and the four dialogue scripts are generated; rendering is waiting on ELEVENLABS_API_KEY in .env.
    by: AI
    at: "2026-10-09T23:45:00.000Z"
    re: c1
