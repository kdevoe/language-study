# Grammar cards from the weekly recap, and a recap list in 進捗

Status: plan, 2026-10-25. Mockup: `docs/mockups/grammar-cards.html`.

## What we're building

1. **Grammar cards.** Each Sunday the recap names 2–3 patterns you keep getting wrong. For each one ハルカ also writes 2–3 cards: a Japanese sentence with a blank and two choices (旅館＿泊まります: に / で). You pick one, the card flips, and the back shows the right answer in the sentence plus one or two lines on why. The cards come up **mixed into the 単語 session** and are scheduled with FSRS like everything else.
2. **A recap list in 進捗.** At the bottom of 進捗, one row per week (dates + title). A tap opens the same recap sheet the chat opens.

Decided (2026-10-25): cards in 単語, not their own deck row. Cards come from recap patterns only, not from catalogue points met in reading. The 進捗 lookup is a list of weeks, not an index by pattern.

## The data we have

One recap so far (today's, Oct 19–25), with three patterns: だ / な / で around adjectives (11 slips), particles that go with a verb (7), and an extra の between a verb and a noun (3). Each pattern carries the learner's own slips as `was → now` pairs with the changed part (`fix`), e.g. 旅館で泊まります → 旅館**に**泊まります. Those pairs are ready-made cards: the blank goes where `fix` is, the wrong option is what the learner actually wrote.

Not every slip makes a clean two-way choice. 若いなのに → 若いのに is "な or nothing", and 大事と思う → 大事だと思う is "と or だと". Choices can be whole chunks (だと / と), not only single particles. When one choice would be "nothing" (勝つ＿チャンス: の or nothing), the card offers the two whole phrases instead, 勝つチャンス / 勝つのチャンス, with the blank spanning the phrase. A card is fine as long as exactly one choice is correct.

## Cards

### What a card holds

```
before   旅館
answer   に
wrong    で
after    泊まります。
explain  泊まる marks the place you stay with に. で is for where an action happens: 旅館で食べる.
pattern  Particles with verbs          (the recap pattern's `short`)
from     slip | new                    (built on the learner's own sentence, or a fresh one)
```

### How they're made

In the Sunday recap call (`learner-dream/recap.ts`, Sonnet), same context, same call: each pattern gains `cards: [{ before, answer, wrong, after, explain }]`, 2–3 of them. At least one is built on one of the learner's own slips (its `now` with the blank where `fix` is, and `was`'s version as the wrong choice). The others are fresh sentences that test the same point with words at their level.

Every card is checked before it's stored:

- **Deterministic:** answer ≠ wrong; both are short (≤ 8 characters) and neither is empty; the whole sentence is ≤ 40 characters and Japanese only; no links, contacts or markup (as the report is checked today); explain ≤ 160 characters. A slip card's filled-in sentence must match the learner's corrected line.
- **A second opinion (Haiku):** given the sentence with each choice filled in, is exactly one of them natural Japanese? Cards where both read fine (に and で are both possible in plenty of sentences) are dropped. This is the main risk: a card with two right answers teaches the wrong thing.

At most 9 cards a week. They're written by the weekly cron, not by a tap, so there's no per-user trigger to cap beyond that number.

### Schema (migration 43)

`grammar_cards`: id, user_id, recap_id → weekly_recaps, pattern, before, answer, wrong, after, explain, from_slip, then the FSRS columns from `user_kanji_progress` (stability, fsrs_difficulty, due_at, last_reviewed_at, interval_days, reps, lapses, srs_status, introduced_at, updated_at). RLS: the learner selects and updates their own rows; only the service role inserts.

`grammar_review_log`: user_id, card_id, rating, picked (the choice tapped), correct, think_ms, reviewed_at. Same RLS as `kanji_review_log`.

### Into the 単語 session

- A small persisted store, `yugen-grammar` (like `kanjiStore`), pulled from Supabase on app open and written back on every grade, with a log row each time.
- `buildDeck()` returns a union: word cards as today, plus grammar cards that are due. New grammar cards are spread through the session by `mixNewCards`, at most **3 new a day**, so a Sunday batch reaches you over 3 days instead of all at once.
- The 単語 row's due count includes them. The row's subtitle stays as it is.
- Flashcards renders a grammar card with its own faces:
  - **Front:** the sentence with a blank, two choices under it in random order. No chevron: tapping a choice flips the card. Tapping the card elsewhere does nothing.
  - **Back:** the sentence again with the right answer in the blank, marked as the recap marks a fix (`--accent-primary`). Under it, quietly, either nothing (you were right) or "You picked で" (you weren't). Then the explanation. The grade slider along the bottom, as on every card.
- **Grading:** wrong choice → the slider starts on もう一度. Right choice → it starts from the thinking time, as now (a separate `thinkHistory('grammar')`, since reading a sentence takes longer than recognising a word). One tap moves on, as on the other cards.
- ハルカ sees the card: before the flip, only the sentence and the two choices, with "hint, don't tell". After, the answer and the explanation.

### Feeding back

Next Sunday the recap also reads the week's grammar card misses ("still picked で with 泊まる twice"), as it reads flashcard misses today. A pattern that has gone solid can say so in WHAT GOT SOLID.

## Recap list in 進捗

- A section at the very bottom of 進捗, under the word list: the kicker `WEEKLY RECAPS`, then one row per week, newest first: the date range (`OCT 19 – 25`, spaced caps) over the title in the serif. No counts, no chevrons beyond the one the recap block in the chat already uses.
- A tap opens `RecapSheet` over 進捗. Its ハルカと練習する button opens her chat with the same line the chat version sends.
- Hidden until there's at least one recap. Loads cache-first like the rest of 進捗 (#224), so it doesn't slow the page.
- Reads `weekly_recaps` (id, week_start, week_end, title) through RLS; no new table.

## Build order

1. Migration 43 + recap.ts card generation + the Haiku check. Backfill today's recap with a one-off run, and look at the cards it writes before anything reaches the deck.
2. The store, the deck union, the card faces and grading.
3. The 進捗 list (separate small PR, can go first).
4. The recap reads grammar card misses.

## Decided after the mockup (2026-10-25)

1. **Front layout:** choices under the sentence (mockup 1).
2. **A bad card:** nothing in v1. Grading it 簡単 sends it far out.
3. **進捗:** no NEW tag on an unopened recap.
4. **Old cards** stay; FSRS spaces them out.
