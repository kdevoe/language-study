# Furigana & Dictionary Accuracy — Process Review
A detailed walkthrough of _why_ you see wrong furigana, wrong dictionary meanings, and missing JLPT levels — and how the pipeline could be fixed.
## The bug you saw, decoded
In the screenshot the text is `心を鎮めて` ("to calm one's heart"). The correct word is **鎮める (しずめる)** — and your yugen keyword box gets it exactly right.

But the _tappable_ token in the running text was just the single kanji **鎮**, with furigana **ちん** on top, and tapping it returned _"a weight; temple supervisor; town (of China)"_ with the RTK keyword TRANQUILLIZE — and no JLPT badge.

That is three separate failures stacking up on the same word:

1. **Wrong segmentation** — `鎮める` was split into `鎮` + `めて`, so the tap target was a bare kanji, not the verb.
  
2. **Wrong furigana** — the isolated `鎮` got its dictionary _on'yomi_ `ちん`, not the contextual `しず`.
  
3. **Wrong dictionary entry + no JLPT** — looking up the surface string `鎮` matched the standalone-kanji noun entry (ちん = a Chinese town/weight), which carries no JLPT tag.
  

The keyword box is right and the inline tap is wrong **for the same word in the same sentence** — that contrast is the key clue. It tells us the failure is not in Gemini's understanding of the article; it's in the _tokenization layer_ that runs afterward.
## How the pipeline actually works today
The whole chain lives in `supabase/functions/process-article/index.ts` plus the live tap lookup in `supabase/functions/dictionary-lookup/index.ts` and `src/services/jmdict.ts`.
### Article processing (3 passes, all at `process-article/index.ts`)
- **Pass 1 — Rewrite** (`prompt1`, line 321): Gemini writes the Japanese article as plain text strings. It is explicitly told _"DO NOT tokenize the text yet"_ (line 336). This pass is reliable — Gemini writes natural prose, and when it emits a yugen-box keyword it writes the word, reading, and meaning together as one unit. **This is why your keyword boxes are correct.**
  
- **Pass 2 — Tokenize + furigana** (`prompt2`, line 355): Gemini is told _"You are a morphological analyzer"_ and asked to split every sentence into tokens and attach a `furigana` reading to each. **This is the root cause.** An LLM is being used to do dictionary-grounded morphological analysis from scratch, with:
  
  - no lexicon, so word boundaries are guessed (`鎮める` → `鎮` + `めて`);
    
  - no okurigana model, so a fragment like a bare `鎮` gets a plausible-in-isolation reading (`ちん`) rather than the contextual one (`しず`);
    
  - no lemmatization, so conjugated forms are never reduced to their dictionary form.
    
- **Pass 3 — JMDict linking** (line 377): for each token that has furigana, the code does an **exact surface-string match** against `jmdict_kanji.text` / `jmdict_kana.text` and stores _"the first entry_id found"_ (line 399–402). There is no context, no part-of-speech filter, and no "common entry wins" logic. So `鎮` resolves to whatever row comes back first.
  
### The tap lookup (`Reader.tsx` → `jmdict.ts` / `dictionary-lookup`)
When you tap a token (`Reader.tsx:357`):

- If Pass 3 attached a `jmdict_entry_id`, it's fetched directly (`fetchWordDefinitionQuick`, `api.ts:180`) — **propagating Pass 3's wrong link**.
  
- Otherwise it looks up the **surface string** via `lookupWord` (`jmdict.ts:41`): exact kanji match, else exact kana match. A conjugated `鎮めて` exact-matches nothing, so it falls through to the Groq LLM fallback in `dictionary-lookup` — which returns a free-form definition with **no** `jlptLevel` **field at all** (`dictionary-lookup/index.ts:210`).
  

So every path shares the same three weaknesses: **surface-only matching, first-entry-wins, and no lemmatization.**
### Why JLPT is so often blank
- `jmdict_entries.jlpt_level` (`database/07_jmdict_jlpt.sql`) is NULL for most entries — only the ~8k official JLPT-list words are tagged. Rare/auxiliary/kanji-as-noun entries (like `鎮`=ちん) are untagged by design.
  
- When the wrong entry is matched, it's frequently one of those untagged entries → no badge.
  
- Conjugated forms that miss JMDict entirely go to the Groq fallback, which never emits a JLPT level.
  
- `buildFuriganaMap` (`jmdict.ts:212`) splits multi-kanji blocks by an _even character count_ heuristic (line 258) — fine for `食べる`, wrong for compounds like `副大統領`, so even correctly-matched words can show mis-aligned furigana.
  
## The core problem in one sentence
**An LLM is being asked to do the one job LLMs are worst at and dictionary-based tools are best at: deterministic morphological segmentation, reading assignment, and lemmatization.** Everything downstream (furigana, entry linking, JLPT) inherits Pass 2's guesses.
## How to fix it
### Recommendation: replace Pass 2 with a real morphological analyzer
Drop the "Gemini as morphological analyzer" prompt and run a dictionary-based Japanese tokenizer over the Pass-1 text. The standard choice that runs in Deno/browser with no native deps is **kuromoji.js** (a MeCab + IPADIC port); Sudachi/MeCab-WASM are heavier alternatives. For every token a real analyzer gives you, deterministically:

- **surface** (`鎮めて`) — what to display,
  
- **base form / lemma** (`鎮める`) — what to look up,
  
- **reading** (`しずめて`, katakana) — the _contextual_ reading, so furigana is correct,
  
- **part of speech** (verb, ichidan) — to disambiguate JMDict senses.
  

This single change fixes all three symptoms at once:

1. **Segmentation** — `鎮める` stays whole; the tap target is the verb.
  
2. **Furigana** — the reading comes from the analyzer's contextual reading, not an isolated-kanji guess. Align it to the surface with a proper okurigana algorithm (match trailing/leading kana, assign the kanji span the remaining reading) instead of the even-split heuristic.
  
3. **Dictionary + JLPT** — look up by **lemma**, so `鎮める` matches its real entry with the right sense, reading, and JLPT tag. Conjugated forms now resolve instead of falling through to Groq.
  
### Supporting changes
- **Disambiguate Pass 3 /** `lookupWord` **properly.** When a surface/lemma yields multiple entries, don't take "the first found." Rank by `common = true`, then `freq_rank`, then prefer the entry whose `pos` matches the analyzer's POS. Reserve the LLM (`disambiguateWithLLM`, already implemented at `jmdict.ts:112`) for genuinely ambiguous cases — it's currently bypassed in Pass 3 entirely.
  
- **Lemma-aware lookup in** `jmdict.ts`**.** Add a base-form parameter to `lookupWord` so the tap path can try lemma → surface → kana, instead of surface → kana only.
  
- **JLPT fallback ladder.** When the matched entry has no `jlpt_level`: (a) fall back to the max JLPT level of its kanji via the existing `kanji_jlpt` table (`database/08_kanji_jlpt.sql`), or (b) derive a coarse level from `freq_rank`. Surface "untagged" rather than silently blank.
  
- **Pre-bake everything in Pass 3.** Since the analyzer runs server-side once per article, store `surface`, `lemma`, `reading`, `furiganaMap`, `jmdict_entry_id`, and `jlpt_level` directly on each token in `processed_news`. The tap then needs no live lookup at all — eliminating the second place the surface-match bug can reappear and making taps instant.
  
- **Fix** `buildFuriganaMap` **okurigana alignment** (`jmdict.ts:212`, mirrored in `dictionary-lookup/index.ts:16`) regardless — replace the even-split with kana-anchored alignment, and dedupe the two copies into one shared helper.
  
### Effort vs. payoff
| Change | Effort | Payoff |
| --- | --- | --- |
| Swap Pass 2 → kuromoji.js | Medium | Fixes segmentation + furigana + enables lemma lookup (the big one) |
| Lemma-based JMDict lookup + POS-ranked disambiguation | Low–Medium | Fixes wrong meanings on conjugated/ambiguous words |
| JLPT fallback ladder (kanji_jlpt / freq_rank) | Low | Fills in most missing badges |
| Pre-bake token metadata in Pass 3 | Low | Instant taps, removes a whole class of live-lookup bugs |
| Fix `buildFuriganaMap` alignment | Low | Correct furigana on multi-kanji words |

The first row is the linchpin: once tokens carry a real lemma and reading, the rest are small, well-scoped follow-ups.
## Open questions for you
1. Is adding a JS morphological analyzer (kuromoji-class) into the `process-article` edge function acceptable, given its dictionary adds bundle/cold-start weight to the Deno function?
  
2. Do you want furigana/linking computed **once at processing time** (pre-baked, my recommendation) or kept **live at tap time**?
  
3. How important is full JLPT coverage vs. just "don't show a wrong level" — do you want the kanji-level / frequency fallback, or is blank acceptable when untagged?

---
comments:
  c1:
    body: tell me more about kuromoji.js
    by: user
    at: 2026-06-07T17:07:22.496Z
