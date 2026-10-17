# RTK kanji deck: plan
**Status (Oct 16 2026):** built, all three phases. Migration applied and your Anki deck imported: 726 kanji and 3,506 reviews, every due date matching Anki's.

A second study deck in Yūgen for Remembering the Kanji. It starts from your Anki cards and review history, then runs on Yūgen's own scheduler. The existing vocabulary deck stays exactly as it is.
## What the data says
Read from a copy of `collection.anki2` (Anki was open; the original was not touched).

|     |     |
| --- | --- |
| Deck | Remembering the Kanji 1, 6th edition, 2,200 notes, one card each |
| Card direction | "Recall": keyword on the front, kanji on the back |
| Fields | Kanji, Alternative Kanji (6 notes), Keyword, Story (empty on every note), Stroke Count, Heisig Number, Lesson Number |
| Since the reset (Feb 15 2026) | 726 kanji learned, exactly Heisig #1–726, at 2.99 a day |
| Reviews since the reset | 3,506. Again 0, Hard 144, Good 1,636, Easy 1,726 |
| Anki scheduler | SM-2 (ease factors 1900–3100), not FSRS |
| Due in Anki | 0 overdue, 80 in the next week, 241 in the next 30 days. Median interval 114 days |

Earlier history (a full pass of all 2,200 in Jun 2024 to Feb 2025, then a reset of the whole deck on Jul 4 2025) is left out, as you asked.

Yūgen already has what the deck needs:

- **The scheduler.** The vocab deck runs FSRS-6 through `ts-fsrs` (`src/services/srs.ts`), with a target retention of 0.85.
  
- **The kanji list.** `src/data/rtkKanji.ts` holds all 2,200 RTK 6th-edition kanji in order, with keywords. It matches your Anki deck.
  
- **The card UI.** `Flashcards.tsx` already has the flip card, the four grade buttons and the finish card.
  
## The key decision: keep Anki's schedule at import
I replayed your 3,506 reviews through Yūgen's FSRS settings to see what the deck would look like on day one:

|     | Due in next 30 days | Median interval | 一 (5 reviews, all Easy) | 掲 (1 review, Easy) |
| --- | --- | --- | --- | --- |
| Anki today | 241 | 114 days | 377 days | 4 days |
| FSRS replay, retention 0.85 | 9   | 509 days | 4 years | 16 days |
| FSRS replay, retention 0.9 | 34  | 267 days |     |     |

With zero failures and half the presses on Easy, FSRS's default model concludes you almost never forget, and it pushes cards years out. If you did start forgetting a kanji, the deck wouldn't find out until then.

**Recommendation:** import each card with Anki's current schedule.

- **Due date:** taken straight from Anki. What's due in Anki tomorrow is due in Yūgen tomorrow.
  
- **FSRS memory state:** stability is seeded from Anki's interval, and difficulty is mapped from the ease factor (2500 → 5; each 200 above or below moves it one step, clamped 1–10).
  
- **From then on:** FSRS schedules each card from its next review.
  

This keeps continuity on the first day, and the schedule moves to FSRS gradually rather than in one jump.

**Grading going forward.** Decided: the four pills are replaced in **both decks** by the slider toggle used elsewhere in the app, treated as a setting rather than a button (S2 + S3 in the mockup):
- **Starting grade:** the slider starts from how long you looked at the keyword before flipping: quick means 簡単, normal 正解, slow 難しい. It never starts on もう一度; that one is always your call. The thresholds adapt to your own pace (your Anki median is 9 seconds a card) rather than staying fixed.
- **Changing it:** you nudge the slider only when the guess is wrong.
- **Moving on:** tapping the card moves on, the same gesture that flipped it. There's no 次へ button.
- **Teaching it:** "tap the card to move on" isn't obvious, so it needs a first-run hint. That's part of a future tutorial mode (docs/task.md).

What the grades mean:
- **正解 (Good)** is the normal "I remembered it right away".
- **簡単 (Easy)** is for kanji that are trivial for you.
- **難しい (Hard)** is "I got it, but with effort".
- **もう一度 (Again)** is "I couldn't picture it within a few seconds, or pictured it wrong".

Once there are a few hundred honest reviews in Yūgen, we can fit FSRS parameters to your own history.
## Data model
A separate table, not `user_word_progress`. Kanji are keyed by character, have no JMDict entry, and shouldn't show up in vocab queries, the Progress word list, or Policy F pacing. Migration `database/NN_kanji_deck.sql`, applied by hand in Supabase like the others.

```sql
user_kanji_progress (
  user_id uuid, kanji text, heisig_no smallint,
  stability double precision, fsrs_difficulty double precision,
  due_at timestamptz, last_reviewed_at timestamptz, interval_days double precision,
  reps int, lapses int, srs_status text,
  introduced_at timestamptz, source text,  -- 'anki' | 'yugen'
  primary key (user_id, kanji)
)
kanji_review_log (
  id uuid, user_id uuid, kanji text, rating smallint, reviewed_at timestamptz,
  source text,  -- 'anki_import' | 'flashcard'
  interval_days double precision, stability_after double precision
)
```

Both tables get the usual own-row RLS policy.

**Client storage.** The store gets a `kanjiDatabase` holding only introduced kanji (726 now, 2,200 at most, roughly 150 bytes each). The review log stays server-side only, so it can't grow the localStorage blob.
## Import
A one-off script, `scripts/import-anki-rtk.mjs`:

1. Reads a copy of `collection.anki2`.
  
2. Takes cards and reviews since the reset.
  
3. Builds the rows as above.
  
4. Writes them for your user id.
  

The script is idempotent (upsert by kanji), so it can be re-run if you do more reviews in Anki before switching over.

**Checks after import:**

- 726 progress rows, Heisig 1–726.
  
- 3,506 log rows.
  
- Every due date matches Anki's to the day.
  
- Due counts for the next 7 and 30 days match the table above.
  

An in-app "import from Anki" (uploading an `.apkg` and parsing it in the browser) is possible later, for other users. It's not needed for v1.

**After the import, stop reviewing RTK in Anki**, or the two schedules drift apart.
## Daily new kanji
- **Pace:** new kanji arrive in Heisig order, 3 a day by default, with a setting like the vocab one. They come once per calendar day, using the same calendar-day gate as vocab intake.
  
- **Your Yūgen kanji level follows the deck:** `rtkLevel` becomes the highest Heisig number introduced (726 today). It's synced to `user_preferences.rtk_level`, so article rewriting targets the kanji you're actually on.
  
- **The old timer goes:** this replaces `checkDailyKanji()`, the blind +3 a day. That timer also seems to be overwritten by the server value on every sync (from reading the code; I'll confirm before removing it).
  
## Card faces

- **Front:** the keyword, large and serif, with a small Heisig number kicker.
- **Back:**
  - the kanji, very large in Shippori Mincho, with the keyword
  - on/kun readings and components, from `reference_files/heisig-kanjis.csv`
  - up to three words you know that use the kanji, from your vocab deck, each with furigana and a short meaning
- **Keep the words section clean:** no rule above it, no title, no stroke count.
- **Not in v1:** stories (the Anki field is empty) and stroke-order animation.

## Where it lives in the app

Decided: **option B**, shown in `docs/mockups/kanji-deck.html`.
- **復習 | 進捗 stays as it is.** 復習 opens on two deck rows:
  - 単語: due count, plus today's new words
  - 漢字: due count, plus today's new Heisig range
- **Sessions:** tapping a row opens that deck's session, with ‹ back to the rows. Finishing kanji offers 単語へ.
- **Home:** the 復習 card shows both counts (12 単語 · 3 漢字), and 始める opens the deck rows.
- **進捗:** unchanged, no kanji line.

## Phases
1. **Data:**
  
  - migration
    
  - `src/services/kanjiDeck.ts`: pure deck selection, reusing `schedule()`
    
  - `scripts/test-kanji-deck.mjs`
    
  - the import script
    
  - the import checks above
    
2. **UI:**
  
  - mockup of A, B and C
    
  - then the kanji deck in the 復習 tab, the daily new-kanji drip, and `rtkLevel` derived from the deck
    
3. **Surfaces:** the Home card counts.
  
## Open questions
1. **Target retention for kanji.**
  
  - I'd use **0.9** for kanji and leave vocab at 0.85. Recalling a kanji from its keyword gets no help from reading, whereas vocab is also reinforced every time you read it.
    
  - At 0.9, intervals stay close to Anki's. At 0.85 they'd be roughly 1.9 times longer.
    
2. **Placement:** Decided: B.
  
3. **Back of the card:** Decided: kanji, keyword, on/kun readings, components, and up to three words you know with furigana. No rule, title or stroke count.
  
4. **Anki:** Decided: stop reviewing RTK in Anki once the import checks pass.

---
comments:
  c1:
    body: Yes, readings and words you know would be good. Yes, ok for number 4
    by: user
    at: 2026-10-17T02:16:30.263Z
  c2:
    body: "Thanks. I've marked 3 and 4 as decided above. Next I'll mock up placements A, B and C. I'll go with 0.9 retention for kanji unless you'd rather match vocab at 0.85."
    by: AI
    at: "2026-10-17T02:20:00.000Z"
    re: c1
