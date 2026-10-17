# Tutor & Speaking Partner — Design Exploration
Status: **proposal, 2026-10-17.** Nothing built yet. Written up from a design discussion so the work can start in its own session. Decisions still open are in §11.

The idea: an agent the reader can talk to from **anywhere in the app**. It is one person, a Japanese **tutor who is also your language-exchange partner**. It chats with you in Japanese at your level, and when you stumble or ask, it steps out briefly to explain, then picks the conversation back up. It knows what's on your screen, what you're reading and studying, and what you've struggled with before.

Today the app is all **input**: reading, listening, flashcards. This adds **output** (writing, then speaking), the part a learner can't get from reading alone. It also makes everything else more valuable, because the tutor works from the learner's own material.

* * *
## 1. One persona, not a tutor plus a partner
An early sketch split it into a "partner" (Japanese conversation) and a "tutor" (explanations in a side channel). **Rejected:** a good exchange partner who tutors is one person who switches languages fluidly:

> あ、ここは「に」じゃなくて「で」だよ — because it's where the action happens. で、京都で何したの？

- **Japanese by default**, at the learner's level. A brief aside when asked or when it matters, in English or easy Japanese (the learner's preference), then straight back to Japanese.
- **Correction is the tutor's judgment**, like a person's:
  - small slips → **recast** in passing (repeat it back correctly, no comment)
  - a pattern the learner keeps getting wrong → a brief explicit aside
  - anything the learner asks about → a full explanation
- **Style is set the way you'd tell a tutor**: "correct everything", "only when I ask", "explain in Japanese". Saved as preferences, changeable mid-conversation by just saying so.
- **No mode switch.** "Let's talk about the article", "quiz me on today's words" and "just chat" are things you *say*, not settings.

**Kept from the split version (visual only):** asides render slightly smaller or muted, so the Japanese conversation stays scannable, and the end-of-chat recap can collect them (§5). Same speaker throughout.

**Who:** the podcast cast (`src/data/podcastCast.ts`, voices in `supabase/functions/_shared/podcastCast.ts`): ハルカ, ソウタ, ヨウコ, and so on. The learner picks one; they already have personalities and ElevenLabs voices, so you hear them on 聞く and then talk with them. Dialect personas (ケンジ 関西弁, タクミ 博多弁) are a fun later option but should default off for learners.

* * *
## 2. Entry points: a gesture on every screen
**iOS has already claimed most gestures:**

| Gesture | Problem |
| --- | --- |
| Swipe in from the left or right edge | In a Safari tab: back and forward. In the installed PWA: probably free, see below |
| Swipe up from the bottom | Home indicator |
| Long-press | Already used: word lookup, select mode in archive lists, song tiles |
| Shake | Needs the DeviceMotion permission prompt on iOS, and gets triggered by accident |

**Edge swipes in the installed PWA.** The app installs as a standalone PWA (`public/manifest.json`: `"display": "standalone"`). Standalone iOS web apps have no browser chrome and, as far as we know, **no system back/forward edge swipe** (a long-standing PWA complaint). The page would then receive edge touches itself. Behaviour has varied across iOS versions, so **confirm on a device**. Things to watch even when it works:
1. **The left edge means "back"** to anyone used to native iOS apps. The app has no swipe-back today and would benefit from one on reading surfaces, so keep the left edge for that.
2. **The app already uses horizontal swipes:** dismissing news cards, and swipe-left to delete in 本棚 and 聞く lists. An edge zone needs a strict rule (the touch must *start* within about 16px of the edge) so swipes on cards aren't ambiguous.
3. **Safari-tab users** (the app not installed) lose edges to the browser, so a non-edge fallback is required.
4. **Accidental triggers** from a one-handed grip: use a distance threshold and commit only after the finger has moved clearly inward.

**The right edge is the strongest candidate:** there's no "forward" habit in native apps, it doesn't collide with a future swipe-back, and it's where a right-handed thumb rests.

**Proposal:**
- **Swipe in from the right edge** (installed PWA): opens the tutor sheet. The main gesture.
- **Drag up on the bottom nav** (`BottomNav.tsx`), as if it were a sheet handle. The fallback, and how it works in a Safari tab. The nav is on every tab page, and an upward drag on it means nothing today. The tutor rises as a **half-height bottom sheet** (design-system §6.2) so the screen stays visible behind it.
- **Reading surfaces** (Reader, podcast player, song player), where the nav is hidden: a small quiet icon in the back row, or a drag down on it.
- **Targeted entry:** long-press a sentence in the Reader → **聞く** ("ask"). This opens the same tutor focused on that sentence.
- A **visible hint**, at least at first (a small grabber line on the nav). Gestures nobody can see don't get found.

* * *
## 3. Screen context: each screen describes itself
A small **context registry** (React context, e.g. `useTutorContext(snapshot)`): each screen registers a short, structured description of what's on it, and the tutor takes a snapshot when it opens.

| Screen | Reports |
| --- | --- |
| Reader | work / part or article id, the paragraph on screen, the sentence tapped, words looked up this session |
| Flashcards | current word, **whether it's revealed**, the card kind (new / review) |
| Podcast player | episode, the current sentence and time |
| Song player | song, the current line |
| Home / 本棚 / lists | what's listed, what's next up |
| 進捗 (progress) | weak words, recent mistakes |

**Rules:**
- **Show what it can see.** The sheet opens with a **context chip** ("第3部 · 段落5 · 影") that the learner can tap away.
- **Don't spoil.** On an unrevealed flashcard the tutor gets the prompt side only, and helps with hints, not the answer.
- **Audio pauses** while the sheet is open (like word lookup does now, via `sharedAudio`) and resumes when it closes.

* * *
## 4. One running conversation
- A **single thread**, not one per screen. Opening from a new place **appends the new context** as a mid-conversation system message instead of starting over. "The word from the article earlier" keeps working, and the history stays a stable, cacheable prefix (§8).
- A fresh thread **each day**, or on an explicit 新しい会話 ("new conversation").
- Previous threads are summarized into memory (§6), not kept verbatim forever.

* * *
## 5. What a conversation looks like
- **Main column:** the learner and the tutor in Japanese. Tutor messages render through the Reader's pipeline (`FuriganaText`, `enrichArticle`, `useWordLookup` / `WordModal`), so words are tappable and furigana follows the learner's setting.
- **Asides:** the tutor's explanations, same speaker, slightly smaller and muted (§1).
- **Recap** when the learner closes or ends the chat:
  - 2–3 corrections worth remembering
  - new words, each with one-tap **add to deck**
  - words the learner **used correctly** count as successful reviews for that word's flashcard schedule (FSRS, `services/srs.ts`)

* * *
## 6. Memory
| Layer | Contents | Source |
| --- | --- | --- |
| Learner profile | JLPT, RTK progress, known / learning / due words | store + `user_word_progress` (exists) |
| Current activity | the screen context snapshot | §3 |
| Learner notes | recurring mistakes ("mixes up は/が"), interests, style preferences | written by the tutor via a tool |
| Relationship notes (per persona) | things the learner has told them (their weekend, their job) | written by the tutor via a tool |

The notes are what make it feel like one person who knows you. They should also **feed back** into the rest of the app: weak points bias review selection, and interests bias article topics.

New tables (sketch): `tutor_threads` (id, user_id, persona, started_at, summary), `tutor_messages` (thread_id, role, content, context jsonb), `tutor_notes` (user_id, persona nullable, kind, text, updated_at). All with RLS like the other user tables.

* * *
## 7. Tools the agent gets
| Tool | Does |
| --- | --- |
| `lookup_word` | JMDict lookup (`services/jmdict.ts` tables), for accurate readings and senses |
| `get_text` | the current article or part text, or a podcast or song transcript, by id |
| `add_to_deck` | add a word to the learner's deck (intake queue) |
| `record_usage` | a word used correctly or incorrectly → SRS signal |
| `save_note` | write a learner or relationship note (§6) |
| `set_preference` | correction style, explanation language |

These let it act on the learner's data instead of just talking about it.

* * *
## 8. Architecture
- **Edge function** `tutor-chat` (Deno, like the others). It calls the **Claude API with tool use** and **streams** the reply to the client.
- **Prompt layout, kept stable so it caches** (cache prefix order is tools → system → messages):
  1. tools
  2. system: the persona plus tutoring rules
  3. learner profile and notes (changes rarely)
  4. thread history
  5. new context as mid-conversation system messages

  Volatile data never goes into the top-level system prompt.
- **Level control:** run each reply through the existing tokenizer and JLPT data. If too many words are above the learner's level, regenerate or ask for a simpler version. Unknown words are tappable regardless.
- **Language drift:** models drift into English once the user writes English. The rule: reply in Japanese unless asked for an explanation, keep explanations short, then return to Japanese. **Verify on real transcripts** before relying on it.
- **Model:** decide by measurement. Text turns are short with mostly cached context, so on Sonnet 5.5 a turn is well under 1¢, and less on Haiku 5.5. Check current pricing and capabilities in the `claude-api` skill before choosing.

* * *
## 9. Voice (later phase)
- **Push to talk**, not an always-open microphone. Learners need time to form a sentence, and a live line pushes them into English.
- **Each turn:** the learner's speech is transcribed, the transcript is shown, then the reply is streamed and spoken in **that persona's ElevenLabs voice**. A visible transcript of both sides keeps it a reading exercise too.
- **Controls:** slow down, replay, and text without audio.
- **Pronunciation:** the transcript is a rough proxy. If it heard 行きました when you meant 着きました, the tutor can point that out gently. Real pronunciation scoring is a separate later step.
- **Latency is the product:** stream text and audio as they're generated, and keep turns to one to three sentences.
- **Speech-to-text:** pick by testing Japanese accuracy. The browser's built-in speech recognition is unreliable on iOS, so most likely a hosted model.

* * *
## 10. Cost and plans
| Part | Cost driver | Plan tier |
| --- | --- | --- |
| Text chat | Claude tokens, mostly cached context | Basic (text) plan |
| Voice replies | ElevenLabs text-to-speech per character | Audio tier (with podcasts and songs), as minutes per month |
| Speech-to-text | per minute, small | Audio tier |

Track usage per user from day one (turns, voice minutes), the same as podcasts and songs.

* * *
## 11. Open questions
1. **Gesture:** does iOS hand right-edge swipes to the installed PWA, and does it feel natural? **Prototype first:** a right-edge swipe detector on one screen, deployed and tried on a phone, alongside the nav drag. Also decide whether the left edge becomes swipe-back on reading surfaces.
2. **Persona choice:** a fixed default (ハルカ?) or chosen in onboarding? Allow switching?
3. **Explanation language** default: English, or easy Japanese from N4 up?
4. **Correction default:** recast only, or recast plus asides for repeated errors?
5. **Thread lifetime:** daily reset, or keep going until the learner starts a new one?
6. **Usage counting toward SRS:** does correct use in chat count as a full review, or a lighter signal?
7. **Safety and scope:** keep it tied to study and the learner's material, so it doesn't become a general assistant. Decide how firmly to steer back.

* * *
## 12. Build order
Each step ships on its own.

1. **Ask your tutor about this.** The context registry, the sheet, the right-edge swipe (after the prototype in §11 Q1) with the nav drag as fallback, and Reader long-press → 聞く. Text only. Asides and explanations, no free conversation yet.
2. **Conversation.** Japanese chat at the learner's level, with recasts and asides, tappable words, and the end-of-chat recap feeding SRS.
3. **Memory and persona.** Learner and relationship notes, a podcast cast member as the tutor, notes feeding article topics and review selection.
4. **Context everywhere.** Flashcards (no spoilers), podcast and song players, 進捗.
5. **Voice.** Push to talk, persona voice, then latency tuning.

**First concrete step:** a mockup in `docs/mockups/` (like `home-today.html`) of the sheet over the Reader and over a flashcard: the context chip, a short Japanese exchange with one aside, and the recap. Then the `tutor-chat` edge function for step 1.
