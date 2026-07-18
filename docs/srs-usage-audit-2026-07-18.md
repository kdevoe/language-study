# SRS & Flashcard Usage Audit — 2026-07-18

Read-only audit of `srs_review_log`, `user_word_progress`, `study_history`, and
`processed_news` for the single active user (kpdevoe@gmail.com), covering the
last 7 and 30 days. Scripts used are throwaway (session scratchpad); every query
was read-only.

**Context**: the FSRS engine is one week old — the first `srs_review_log` event
is 2026-07-12. The 30-day view comes from `study_history` (the older UX log) and
`processed_news`. Preferences at audit time: JLPT N4, RTK 350, 3 new words/day,
balanced study mode.

---

## Headline answers

| Question | Answer |
|---|---|
| Are study words surfaced? | **Yes, strongly.** 526 of 839 active words (63%) were encountered in articles within 7 days, median 3 encounters each. Targeting is correct: every reader-sourced SRS event hit a scheduled word. |
| Are they *actively* learned? | **Mostly not.** 98% of all SRS events are passive `reader_skip` credit (auto-"Good"). Only 28 flashcard grades and 10 lookup-clicks all week. |
| Are the right words in the flashcard deck? | **No — two separate problems.** The deck is starved (0 cards due now), and what does land in it is ultra-common N5 vocabulary, while your demonstrated struggle words sit unscheduled in the intake queue. |
| Are the right words in articles? | **Yes for the active set.** Weak evidence on the pre-due floor specifically (only 8 near-due words existed; 0 appeared in the 2 currently-ready articles — sample too small to judge). |
| Improving over time? | **Reading ease: yes. Vocabulary growth: it has nearly stalled.** Known vocab (easy+medium) grew ~500/week in mid-June but only ~70 last week and ~35/week reached "easy". Retention of what was learned looks genuinely good (12% fall-back, 5% re-lookup after "easy"). See Finding 5. |

---

## Usage overview

- **Reading is consistent and heavy.** 355 articles generated in 30 days
  (~12/day); 181 read, 169 dismissed, 3 failed. `study_history` shows activity
  every single day of the month (12,085 `seen`, 536 `lookup`, 8,097
  `mastery_change` events).
- **SRS used every day since launch.** 7/7 active days, 1,685 review events
  over 548 distinct words.
- **Word-tracking inflow is large**: 1,483 new `user_word_progress` rows in 30
  days (449 in the last 7 → ~64/day).

## Finding 1 — Passive reader credit is doing 98% of the work and starves the deck

Last 7 days of `srs_review_log` by source:

| source | events | notes |
|---|---|---|
| `reader_skip` | 1,647 | always rating 3 ("Good"), avg **+5.1 days stability each** |
| `flashcard` | 28 | 24 of these are the one-time first grade of newly promoted intake words |
| `reader_click` | 10 | click rate on scheduled words ≈ 0.6% |

Each passive skim of a sentence containing a scheduled word counts as a
successful review. With a median of 3 encounters per word per week, the entire
active set got pushed out fast:

- Due now: **0**. Due within 7 days: **11 of 839**.
- Due-date horizon: 175 words in 7–30d, 435 in 30–90d, 218 in 90–365d.
- Median stability is already 32 days (p90 = 67d) after one week.

This is Policy F working as designed ("reading pushes cards out before they hit
the deck") — but the balance is extreme: a word can accrue +25d of stability in
a week from passive exposure without a single recall test. The one active-recall
signal we have points the other way: the small flashcard sample has a **21%
Again rate** (6/28), on mostly ultra-common N5 words. Passive credit is likely
overestimating recall.

## Finding 2 — The deck gets easy foundation words; your struggle words never reach it

What landed in the flashcard deck (last 30d): 26 of 28 words are **N5**, median
frequency rank 3 (top frequency band). 15 of 28 first grades were "Easy" (54%).
For an N4 reader, most of the deck is words you already know — which is what
foundation-first intake (easiest JLPT, most frequent first) is designed to
produce.

Meanwhile, the words with the clearest struggle signal — looked up **3–6 times**
in 30 days — are almost all stuck in the queue with no schedule and no
flashcards:

| word | lookups | status |
|---|---|---|
| 奴隷 | 6 | queued, unscheduled, seen 10× |
| 権利 | 5 | queued, unscheduled, seen 12× |
| 遺伝子 | 5 | queued, unscheduled, seen 6× |
| 機関 / 救助 / 支援 / 警告 / 基地 / 疑問 / 役に立つ | 3–4 | all queued, unscheduled |
| 共和 | 4 | active — but due in **143 days** (S=76) after 3 passive skips |
| 活動 | 4 | active — due in 67 days |

23 words hit the ≥3-lookups threshold; ~19 are unscheduled. These are exactly
the words a flashcard deck exists for, and the current pipeline can't reach
them: the queue holds 1,994 words, promotes 3/day in foundation order (N5-first),
and grows by ~64 tracked words/day. At current settings the N3-ish struggle
words are effectively **years** away from promotion.

Where grading does happen, rescheduling behaves correctly: Again-rated cards
(珈琲, 警官, 弟, 大勢) came back due in 1–3 days. So the FSRS mechanics are
fine — the deck's *intake* is the problem, not its scheduling.

## Finding 3 — Article injection works for breadth, unproven for urgency

- Articles are saturated with scheduled vocabulary: 63% of the active set
  appeared in articles within a week. As a "keep known words warm" mechanism,
  injection is working.
- The pre-due review floor couldn't be evaluated meaningfully: because skips
  keep pushing due dates out, only 8 words were due/near-due at audit time, and
  none appeared in the 2 `ready` articles. Not necessarily broken — there is
  simply almost no due inventory to inject, which is itself a symptom of
  Finding 1.

## Finding 4 — Improvement signal (30 days)

Lookups per 100 words seen, weekly:

| week | seen | lookups | rate |
|---|---|---|---|
| 06-20 → 06-27 | 3,139 | 172 | 5.5 |
| 06-27 → 07-04 | 1,450 | 59 | 4.1 |
| 07-04 → 07-11 | 2,270 | 116 | 5.1 |
| 07-11 → 07-18 | 3,306 | 91 | **2.8** |

Reading volume held steady while the lookup rate roughly halved — consistent
with real comprehension gains. Caveat: the controlled-vocab lexicon (#111-era
work) landed inside this window and deliberately makes articles easier, so this
can't be fully attributed to learning. The flashcard record is too young and too
small (28 grades) to measure retention trends yet.

## Finding 5 — Vocabulary growth is real but has nearly stalled; retention is good

Follow-up question: forget reading ease — is the *vocabulary* growing, and does
it stick? Full `study_history` goes back to 2026-04-15 (real activity starts
~05-27), so this can be answered over the whole lifetime by replaying
`mastery_change` events per word.

**Growth curve** (cumulative words whose latest mastery is easy/medium):

| as of | easy | medium | known (e+m) | weekly Δknown |
|---|---|---|---|---|
| 06-10 | 77 | 239 | 316 | +316 |
| 06-17 | 294 | 544 | 838 | +522 |
| 06-24 | 535 | 756 | 1,291 | +453 |
| 07-01 | 604 | 900 | 1,504 | +213 |
| 07-08 | 670 | 977 | 1,647 | +143 |
| 07-15 | 706 | 1,009 | 1,715 | **+68** |
| 07-18 | 709 | 1,008 | 1,717 | +2 in 3 days |

Vocabulary genuinely grew — ~1,700 words classified known, ~700 easy — but the
growth rate collapsed from ~500 known-words/week in mid-June to ~70 last week,
and "easy" additions fell from ~240/week to ~35/week. Two drivers, both
deliberate design choices from the last month of work:

1. **New-word exposure dropped**: weekly first-encounter cohorts went
   686 → 560 → 251 → 203 → 121. The controlled-vocab lexicon keeps articles
   inside the known list, and stretch/new words are rationed — so reading no
   longer delivers hundreds of new words a week.
2. **The intake gate became the only growth lane**: post-#68, new vocabulary
   formally enters study at 3 promotions/day (~21/week), and Finding 2 shows
   those slots are spent on N5 words already known (54% first-graded "Easy").
   Net effect: near-zero genuinely-new vocabulary acquisition this week, versus
   250–500/week in June.

**Caveat on June's numbers**: 808 of 810 transitions into "easy" came from the
`skip` auto-bump (3 no-click sightings), not deliberate grading — June's fast
growth was largely passive credit and some of it is soft. But the retention
evidence says the labels are mostly honest:

- Of 732 words that ever reached easy, only **12%** were ever downgraded and
  only **5%** were looked up again afterwards.
- Re-lookup rate is falling: of words looked up in late June, 19–22% needed
  another lookup ≥3 days later; for the last two weeks it's 7% and 0% (recent
  weeks have had less time to accumulate re-lookups, so read the tail gently).
- Of 814 words seen ≥5 times, 666 (82%) carry a recognition streak of 5+.

So the system is currently tuned for *consolidation* (retention is working;
comfort while reading is way up) at the cost of *acquisition* (the vocabulary
frontier has all but stopped moving). If the goal is a growing vocabulary, the
levers are the ones in Suggested directions: a bigger/smarter intake lane
(struggle words first), and letting articles carry more genuinely-new stretch
words again.

## Data-hygiene issues found along the way

1. **236 rows with `intake_status = NULL`** — all created in the last 30 days
   (post-migration-24), all JMDict-keyed, mostly `unseen`. New rows aren't being
   classified at insert; the client presumably treats NULL as queued, but the
   migration's invariant (every row classified) is drifting.
2. **Ungraded Again**: 大西洋 was rated Again via flashcard but has
   `srs_status = NULL` and no schedule — a grade that didn't persist. Worth a
   look at the flashcard→store→sync path.
3. `study_history.mastery_change` metadata records only the *new* state
   (`{event, mastery, difficulty}`), not from→to, so mastery direction can't be
   audited historically.

## Suggested directions (not implemented)

1. **Struggle-signal fast-track into intake**: promote words with ≥2–3 lookups
   (or `mastery = hard` + high times_seen) ahead of foundation order. This
   single change puts 奴隷/権利/支援-class words into the deck this week
   instead of 2027.

   These are *not* more N5 words — the fast-track cohort is mostly **N3**, i.e.
   one step above your N4 level, and all of it is top-band frequency vocabulary
   that news articles keep serving you regardless of what the curriculum thinks
   you're ready for: 権利 N3 (freq band 2, looked up 5×), 機関 N3 (band 1),
   疑問 N3 (band 2), 救助/警告 N3, 基地 N2, 役に立つ N4, plus unrated-but-common
   words like 支援 (band 1) and 遺伝子. The current foundation-first order sorts
   easiest-JLPT-first, so N5 words you already know outrank N3 words you've
   demonstrably failed to retain across 5–12 encounters. The fix isn't to
   abandon foundation order — it's a second intake lane: keep the 3/day
   foundation drip, and add ~2/day from the struggle list (lookup count desc).
   Demonstrated need should beat curriculum order; the lookup log is the single
   most honest signal in the system, since each lookup is you telling the app
   "I met this word in real text and couldn't read it."
2. **Dampen passive credit**: diminishing stability growth for repeated
   `reader_skip`s (e.g. only the first skip per day counts, or scale the boost
   down with each consecutive no-click exposure). Keeps Policy F's spirit while
   letting some cards actually reach the deck.
3. **Adaptive promotion rate**: 3/day against a 1,994-word queue growing
   64/day is not a steady state. Either raise the cap, gate tracking inflow, or
   make the cap scale with queue pressure.
4. Fix the `intake_status` NULL classification on insert and the 大西洋-style
   unpersisted grade; add from→to to `mastery_change` metadata for future
   audits.

## Appendix — strict bottom-up vs frequency-balanced intake

Question raised in review: should intake stay strictly lowest-JLPT-first, or be
balanced by frequency so common N4/N3 words can arrive before N5 is exhausted?

Queue composition says bottom-up has already inverted against marginal utility:

| segment | count | of which top-10 freq band | mastery=hard |
|---|---|---|---|
| queued N5 | 103 | 35 | 41 |
| queued N4 | 142 | 69 | 5 |
| queued N3 | 583 | **376** | 152 |
| queued N2/N1 | 339 | 175 | 303 |
| queued no-JLPT | 827 | 129 | 361 |

Plus, ahead of all queued N4/N3 words in strict order, sit the **untracked**
dictionary candidates at easier levels: 256 N5 + 403 N4 words never once
encountered in ~2 months of daily news reading. At 3/day, strict bottom-up
spends **~10 months** promoting those (~900 words) before the first common N3
word arrives.

Two structural problems with pure level-ordering at this stage:

1. **The residual tail is rare by construction.** The N5/N4 words still
   unlearned after two months of daily reading are precisely the ones news text
   doesn't use (that's why they're still unseen). Level was a good frequency
   proxy at the start; for the *remainder* of a mostly-absorbed level it
   selects for rarity.
2. **The blocking words are one level up.** 376 queued N3 words are top-band
   frequency, 152 of them already marked hard from real encounters — these are
   the words currently interrupting comprehension (all top repeat-lookups are
   in this cohort).

Suggested blend (keeps the foundation guarantee, fixes the inversion):

- **Rank by encounter-weighted need, not level**: struggle signal first
  (lookups, mastery=hard, times_seen), then frequency band across N5–N3, with
  level as tie-break only. Or simpler: lanes — e.g. per day 2 struggle-list +
  2 frequency-first (any level ≤ N3) + 1 foundation fill.
- **Don't spend slots on known words.** The Discover-Easy path already does
  this correctly for triaged words: an Easy triage activates the word straight
  onto the SRS schedule with `promotedTs: null`, consuming no slot — 103 words
  took that free path since 07-14. The leak is the promotion lane: slots are
  stamped at promotion time, and 14 of the 24 slot-consuming promotions were
  then first-graded "Easy" in the deck with no refund. Half of those 24 were
  never Discover-triaged at all (virtual foundation candidates go straight to
  promotion). Fix: require candidates to pass triage before they can win a
  slot, and/or refund the day's slot when a promoted card's first grade is
  Easy.
- **Never-encountered dictionary words get lowest priority**, regardless of
  level: if two months of reading never surfaced it, it can wait for the
  frontier to reach it naturally.

---

Overall: the reading loop and word-surfacing are genuinely working, daily
engagement is high, and comprehension is trending the right way. The flashcard
half of the system, one week in, is mostly idle — starved by passive credit and
fed the wrong words by foundation-first intake.

---
comments:
  c1:
    body: Explain to me more the proposed change to the flashcard deck. Are those
      words you want to put in there still N5, or a higher level?
    by: user
    at: 2026-07-18T21:45:28.080Z
  c2:
    body: Higher level — mostly N3 (権利, 機関, 疑問, 救助, 警告), one N2 (基地), one
      N4 (役に立つ), plus unrated-but-top-band words like 支援 and 遺伝子. All are
      high-frequency words your articles keep serving you. I expanded suggestion 1
      in the doc with the full breakdown and the proposed two-lane intake (keep the
      3/day foundation drip, add ~2/day from the struggle list ranked by lookup
      count).
    by: AI
    at: "2026-07-18T21:52:00.000Z"
    re: c1
