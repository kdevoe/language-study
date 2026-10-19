# Intake v2: learn the words you meet, one level up (spec, rev. 2026-10-18)

Revision of the July spec (branch `worktree-srs-usage-audit`, never implemented), rewritten against October data. Companion: `docs/srs-usage-audit-2026-07-18.md`.

This spec changes **which words enter the flashcard deck, what an intake slot costs, and which new words articles teach**. It does not touch FSRS scheduling math.

## Why the current system isn't advancing you

The design was: intake fills the lowest level from unseen words, bottom up, 3 a day, and articles reinforce. Each piece works as written. Together they stall. The data, for your account on 2026-10-18:

### 1. N5 *is* filled. Intake spent three months on its dictionary tail

| | N5 | N4 | N3 |
|---|---|---|---|
| Solid (known) | 627 / 705 (89%) | ~30% | low |
| Never met | 0 | 173 | many |
| Waiting in the intake queue (met in reading, not yet studied) | 0 | 192 | 579 |

Promotions into the deck by month:

| Month | Promoted | N5 | N4 | N3 | First graded Easy (already known) |
|---|---|---|---|---|---|
| July | 63 | 61 | 0 | 0 | 25 |
| August | 87 | 76 | 0 | 0 | 37 |
| September | 24 | 21 | 0 | 0 | 12 |
| October | 48 | 21 | 12 | 0 | 14 |

The order is "easiest JLPT level first, then most common". Once the common N5 words were known, "next N5 word" meant the rare, old-fashioned end of the list: 字引, 伯父さん, 葉書, 不味い, 晩御飯. Most have no frequency rank at all. Your N5 count did rise, but by words you'll rarely meet.

Intake crossed into N4 only on **Oct 14** (着物, 倍, 受付, 旅館, 火事, 屋上, 講堂, 祖母). So "filling our way up" is now happening, about four months late.

### 2. Reviews are N5 because the deck is N5

Almost every word promoted since July was N5 (179 of 222). Reviews are those words coming back for maintenance. Nothing else gets in, so nothing else comes up.

### 3. A third of the slots bought nothing

Of 222 promotions, 88 were first graded **Easy**: you already knew them. The slot is spent anyway. There's no refund. Another ~9 of October's 48 were junk that slipped past the eligibility gate: fragments and non-words (見, 社, 入れ, 御, 達, １２月, 上と下, 西アフリカ).

### 4. The words you actually meet are parked behind the sort

When Policy F (#98, July) rebalanced the deck, every medium-or-harder word you'd met in reading went back to the queue. That's the 579 N3 and 192 N4 words above. Of those, 396 N3 and 109 N4 are common (frequency band ≤12). The foundation-first sort won't touch N3 until N4 is exhausted. At 3/day with a third wasted, that's 6+ months away.

The result: words maturing in the deck at N4/N3 fell from **154/109 in July to 9/1 in October**.

### 5. Articles no longer introduce chosen new words

Since the controlled-vocabulary lexicon (#210 made it reliable), a rewrite may use only words you know, plus up to **3 "topic words"** the story can't be told without. There is no NEW-words slot in lexicon mode: the legacy palette's "introduce ~N new words" line didn't carry over. So:

- Each article brings ~3–4 unknown words (measured, October).
- Those words are whatever the story forces: 紛争, 制裁, 当局. That's why the unknown words you meet skew N2/N1, while the N4 words you need never appear on purpose.
- Articles and intake don't talk to each other. Today's 3 new cards aren't in today's articles.

### 6. Smaller distortions

- **Grammar.** No grammar point has ever been rated, so grammar progress is invisible to every system.
- **Intake rate.** At 3/day the ceiling is about 1,100 words a year, before waste. N4 + N3 is roughly 2,500 words.

**In one line:** intake ran bottom-up through a dictionary list instead of through your reading, a third of its tiny budget went on words you knew, and articles stopped choosing new words. So review stayed at N5 and N4/N3 growth flatlined.

* * *

## Goals

1. Daily intake buys **genuinely new, genuinely useful** words: ranked by how often you'll meet them, starting with words you've already met.
2. The working level follows your progress: N4 now, N3 when N4 is mostly solid. It is never "the rarest N5 word left".
3. A slot is consumed only by a word that turns out to need studying.
4. Articles deliberately teach a few target words at your next level, and those are the words intake is feeding.
5. Progress is visible: solid words per level, week over week.

## Non-goals

- No FSRS math changes.
- No deck UX changes beyond replacement cards appearing mid-session.
- No server-side promotion job: promotion stays client-side in `promoteIntakeQueue`.

* * *

## Change 1: One score per word, ranked against each other

**Where:**
- `src/services/intake.ts`: `intakeScore`, `selectPromotions`, `workingLevel`
- `src/services/store.ts`: `promoteIntakeQueue` builds the items

### Working level

The **working level** W is the easiest JLPT level under 80% solid (easy mastery), counted over all of the level's words. Today N5 is 89% solid, so W = N4. It's computed each pass from `intake_level_progress()`.

### The score

Every eligible word gets one score, and the top N win. N is `new_words_per_day`, 3 by default, set in Settings. There are no lanes and no quotas: a day can be three N3 words, or three N4 words.

| Part | Points |
|---|---|
| **Need** | chosen by you (Discover, ハルカ add): +8, so an explicit ask outranks anything inferred · each lookup +0.6 (up to 3) · marked hard +1.5 |
| **Exposure** | times met (log scale, up to 1.5) · met in the last week +1, last month +0.5 |
| **Usefulness** | frequency band, most common = 3 |
| **Level fit** (×3) | W = 1 · one level up 0.7 · easier than W 0.5 · two up 0.3 · three up 0.1 · JLPT-unrated 0.4 |

**Eligible:** a frequency rank is required, unless you chose the word. Junk is out (1b). Never-met dictionary words compete too, with no need or exposure points, so they only win when nothing you've met is as useful.

**Ties:** the more common word, then entry id.

**Dry run (Oct 18, real queue):** the top picks are the words you keep looking up: 機関, 逮捕, 流行, 組織, 権利, 治療. These have 4–7 lookups each, 10–18 encounters, and are mostly N3. Of the next 63 picks, about 4 are N4. The N4 words still queued are ones you read past without looking up, i.e. likely known. If N4 should get more weight, change the level-fit numbers.

### 1a: Lookup counting

**As built:** no new column. `intake_queue_signals()` (migration 39) counts lookups straight from `study_history`, and also returns each queued word's dictionary level and frequency band. Nothing new to keep in sync, and no rehydrate path to extend. `intake_level_progress()` gives the per-level totals for W, counted over all of a level's words, the same numbers 進捗 will show.

### 1b: Junk gate

Eligibility today is meant to be "has a JLPT level", yet October promoted 見, 社, 入れ, 御, 達, １２月, 上と下 and 西アフリカ. The DB has no JLPT level for most of these, so the local record's `jlptLevel` is coming from somewhere else. That's probably the article token tag.

- **Investigate first:** trace where the local `jlptLevel` comes from for these records.
- **Gate:** only the JMDict entry's own level counts. Also reject:
  - single-kanji suffix or prefix entries (屋, 社, 御, 達, 見) unless they are standalone JMDict nouns with a freq rank;
  - number + counter or date forms;
  - katakana compounds;
  - phrase entries.
- **Unrated words:** relax `isEligible` (July 1b) so frequency-ranked JMDict words with no JLPT level can compete. 支援, 奴隷 and 遺伝子 were top struggle words.

## Change 2: Never-met words compete on equal terms

**As built:** folded into the score. Virtual candidates (`fetchIntakeCandidates`) are ranked with everything else, but have no need or exposure points, so a met word of similar frequency beats them. Discover and ハルカ adds count as *chosen* and lead.

## Change 3: Easy first-grade refund + top-up (unchanged from July)

When a new card's first-ever grade is Easy (`isNewCard && rating === 4`):

1. Clear its `promotedTs`. The grade itself stands.
2. Top up: run `promoteIntakeQueue(now, { topUp: true })`.

The replacement card appears in the same session. Top-ups are budgeted at 4×cap per calendar day. With the working level and junk gate, refunds should become rare. October's rate was 29%.

## Change 3b: read-past refund (added 2026-10-19)

A new card (promoted, never graded) read past in an article without a lookup also gives back its daily slot, the same way as an Easy first grade:
- the same top-up and the same 4×cap daily budget
- the read still counts as a Good review

This depends on Change 4's target words being unglossed. A word with a yugen-box beside it gets read past whether it's known or not.

The signal is weaker than Easy. Words read past before their first flashcard were first-graded Easy 65% of the time, against 59% for the rest. So each refund is logged (`study_history` `mastery_change` with `refund: 'read_past'`) to be checked against that word's next flashcard grade:
- **Mostly Good/Easy:** keep it.
- **Many Again:** replace it with a one-tap "知ってる?" check card that doesn't use a slot.

## Change 4: Articles teach the target words (new)

**Where:**
- `supabase/functions/_shared/readerVocab.ts` (`buildLexicon`)
- `supabase/functions/_shared/rewritePrompt.ts` (lexicon branch)
- `process-article`

Add a **TARGET WORDS** slot to the lexicon prompt, next to REVIEW WORDS.

**Source:** the learner's newest cards, promoted in the last 7 days and still at reps ≤ 3. Newest first, up to 8.

**Prompt rule:**
- Use 2–3 target words where they fit the facts naturally.
- Don't gloss them (no yugen-box): meeting a new word bare is the practice, and it makes reading past one meaningful. Changed 2026-10-19; the reader can still tap to look one up.
- Never distort the story to fit one. Same golden rule as now.

**Topic words** stay, capped at 3. Prefer a topic word at level W or W−1 when the story allows a choice: "if a simpler word in TARGET or ALLOWED expresses it, use that."

**Eval:** add a case to `scripts/eval-article-rewrite.mjs` (a regression guard, not something to tune toward). Count target words used and level-W words per article, and check that the known-word share doesn't drop.

**Why:** a new card read in context the same week is how reading and flashcards were meant to reinforce each other. Today they're decoupled.

> **Build status (2026-10-18):** Changes 1–4 and the hygiene fixes are built (PR: intake v2). The junk gate uses the dictionary's own level (`jlptDerived` levels guessed from kanji were the leak), plus filters for digits, affixes and unranked katakana. Target words are the newest cards only, with no top-up. Change 1 became a single score (no lanes) after review. Changes 5–6 are UI and follow mockup-first.

## Change 5: Grammar gets a signal (new, small)

Grammar points have been tracked since #169/#170, but none has ever been rated.

- Add a one-tap "got it / unsure" on the grammar insight panel, the first time a point is met.
- Log it to `study_history`, so 進捗 can show grammar points met vs. understood per level.

Full grammar SRS is out of scope.

> **Build status:** built as an implicit signal rather than a new tap, because the grammar panel already has an EASY / MEDIUM / HARD slider. Opening an unrated point marks it MEDIUM, opening it on 3 different days marks it HARD, and a hand rating always wins (`noteGrammarOpen` in store.ts). Ratings sync through `grammar_progress`.

## Overnight prep (added after review)

Intake runs at 08:30 UTC in `daily-prep`, in the learner's timezone, before the 09:00 news refill, so new articles carry the new words. The app's own promotion pass stays as a fallback, and it adopts server promotions so it can't promote a second batch. At 09:40 the same function asks `generate-podcast` for the morning digest. `level_snapshots` records solid counts per level each night (history only, no UI yet).

**ハルカ's struggle rule:** a word or pattern she marked wrong (`learner_notes` usage, `correct: false`) in at least 2 different conversations in the last 30 days becomes a chosen word (`chosen_by = 'haruka'`), at most 3 a night. It then competes in the same score with the +8 chosen bonus. There's no UI for it and no undo: Home stays shortcuts only, and a word you already know gets graded Easy, which refunds its slot. Queueing a word without the learner asking in the moment is justified because the evidence is the learner's own Japanese, queueing costs nothing, the daily cap still applies, and an Easy grade undoes it.

## Change 6: Show progress by level (new, small)

In 進捗, add one line per level, N5 / N4 / N3: solid / total, plus the change this week. A Settings toggle isn't needed. It's the number that answers "am I advancing?", and today that takes a database query.

> **Build status:** dropped after review. 進捗's level donuts already show each level's solid share, and a separate card only added the weekly gain (design-system §1: every addition must be necessary). daily-prep still writes nightly `level_snapshots`, so the gain can be shown later if it's missed.

## Reader credit: no change

An earlier draft proposed limiting `reader_skip` credit. Dropped (2026-10-18). Reading past a word is the app's highest-volume feedback, and the data supports it: words read past before their first flashcard were first-graded Easy 65% of the time (59% for words never read past), with the same 10% Again rate.

## Hygiene (unchanged from July)

1. `intake_status` NULL on 955 rows: send `'queued'` from every write path that creates a row, then re-run the `24_intake_queue.sql` backfill.
2. Unpersisted flashcard grades: add retry and loud logging in `reviewWord`.

## Acceptance criteria (first two weeks after ship, 3 a day)

- ≥ 80% of retained promotions are words met in reading or chosen (not never-met dictionary words). **Zero** N5 words without a frequency rank.
- First-grade-Easy rate < 15%, and every Easy first grade gets a same-day replacement.
- Zero fragment or date/number promotions.
- Lexicon articles average ≥ 2 target words (unglossed), with no drop in the known-word share (eval + prod sample).
- N4 solid count rises ≥ 25 words/week. Words maturing at N4/N3 recover toward July levels within a month.
- `lookup_count` matches `study_history` for the top 20 words after backfill.

## Test plan

- **`scripts/test-intake.mjs`:**
  - working-level computation at the 80% boundary;
  - one score: each signal moves it; no quotas;
  - struggle eligibility;
  - chosen words lead; met beats never-met;
  - Fo excludes no-freq words;
  - virtual-candidate gate + cold start;
  - junk gate cases (見, 屋, １２月, 上と下).
- **`scripts/test-deck.mjs`:** relaxed `isEligible`; a refund's replacement appears as `kind: 'new'`.
- **`reviewWord` refund cases:** a first Easy refunds; a later Easy doesn't; the budget caps top-ups.
- **Eval harness:** the target-words case.
- **Manual pass** (`verify` skill): Discover-triage a word → it competes next day; Easy on a new card → a replacement card appears.

## Rollout

1. Migration (lookup_count + backfill) and the intake_status backfill. Applied by hand; ask before running.
2. Ship Changes 1–3 + the junk gate (client).
3. Ship Change 4 (edge functions; deploy process-article), with the eval run first.
4. Keep `new_words_per_day` at 3 (adjustable in Settings). With the score and Easy refunds, all ~21 words a week are ones you need, against ~14 useful today.
5. Ship Changes 5–6.
6. Re-run the audit after two weeks against the criteria above.

## Open questions

1. **Working-level threshold:** 80% solid of freq-ranked words, or a fixed count of unseen-common words remaining? 80% moves W to N3 sooner, and N4 stragglers still compete on the score.
2. **Cap:** 5, or more? At 5 the N4 + common-N3 pool (~500 words met in reading) takes ~3.5 months.
3. **Target-word source:** strictly the newest cards, or also due-soon N4 reviews? (Review words already have their own slot.)
4. **Rename the Settings copy?** `new_words_per_day` would count *retained* words ("new words to learn per day").
