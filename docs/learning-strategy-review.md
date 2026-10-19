# How Yugen introduces new material: strategy review (2026-10-18)

New words and grammar reaching the learner is the core loop of the app. It has also been the most bug-prone part. This review looks at why, what the strategy should be, and where to go next.

## 1. Why new-word introduction keeps breaking

The issues so far, roughly in order:

| When | Symptom | Cause |
|---|---|---|
| Jun | Every word seen got graded on sight | No intake step; reading = studying (#68 added the queue) |
| Jul | 1,206 cards due on first open | FSRS seed anchored to last-seen date; the whole back-catalog came due at once |
| Jul | Policy F (#98) fixed the flood… | …by pushing ~1,900 medium+ words back into the queue, where they sat for 3 months |
| Jul | Mornings with no new cards | Rolling 24h gate drifted later each day; per-device stamps |
| Jul | Promoted words vanished | Rehydrate dropped schedule fields (#75) |
| Jul | Audit: deck starved, reader credit = 98% of reviews | Spec written, **never shipped** |
| Aug | Wrong JLPT levels on 800+ words | Tags retagged in #130 |
| Sep | Taps silently failing | localStorage quota (whole word DB in the persist blob) |
| Oct | Articles at N2/N1 | Lexicon silently fell back to the loose prompt (#210) |
| Oct | Not advancing | Intake fed the rare N5 tail; a third of slots wasted; no new-word slot in articles (#211) |

The pattern underneath:

1. **No single owner of "what you know and what's next".** Six systems each decide part of it, with their own definitions:
   - reader auto-credit;
   - Discover;
   - flashcards;
   - the lexicon (what articles may use);
   - Policy F;
   - ハルカ.

   A fix in one moves the problem to another. Policy F's flood fix created the parking problem.
2. **Proxy signals stand in for knowledge.** "Easy" can mean:
   - you read past it once;
   - an FSRS difficulty nudge;
   - a kanji-guessed JLPT level;
   - you actually recalled it.

   Garbage in compounds. 98% of "reviews" were read-past credit.
3. **The client is the source of truth.** The word DB lives in localStorage and syncs both ways. That one choice caused:
   - quota failures;
   - rehydrate drops;
   - cross-device gate bugs;
   - 577 local-only words;
   - the 1,000-row cap.
4. **No outcome measurement.** Every stall was found months later by an ad-hoc SQL query. Nothing in the app answers "how many new N4 words did I learn this week?", so drift is invisible.
5. **Symptom patches, not design.** The July audit diagnosed most of October's problem; the spec sat unimplemented while point fixes shipped.
6. **Generation and study don't talk.**
   - Articles don't know what you're learning.
   - ハルカ notices struggles but can't act on them.
   - The deck doesn't know what you met today.

## 2. What the strategy should be

**One learning plan, many sources, one measuring stick.**

```
 sources (nominate)              planner (decides)            delivery (teaches)
 ─────────────────               ─────────────────            ──────────────────
 reading: met / looked up   ┐                                 ┌ flashcards (new + due)
 ハルカ: struggles, asks     ├─▶  candidate pool + evidence ─▶ ├ articles (target words)
 Discover: triage           │    working level, lanes, cap    ├ podcasts / songs (targets)
 grammar panel: first meets ┘    one definition of "solid"     └ ハルカ (practise targets)
                                           │
                                  outcome metrics ◀── everything above
```

Principles:

- **Sources only nominate; one planner decides.** Each source adds evidence to a candidate: met, looked up, got wrong in chat, asked for. Only the planner spends the daily budget. #211 is the first version of this planner.
- **Evidence beats curriculum position.** Words you meet and stumble on come first, ordered by how common they are, at your working level. Bottom-up filling is a minority lane, not the engine.
- **One honest definition of "known".** Only recall counts toward "solid": a flashcard grade or correct use in chat. Exposure is evidence of *familiarity*, not knowledge.
- **Content follows the plan.** Whatever the planner picked this week shows up in articles, podcasts and ハルカ's conversation. A new word is met in context within days.
- **Measure outcomes, in the app.** Show new solid words per level per week, plus planner health (refund rate, junk rate, target usage). Look at them weekly.
- **Server owns the state.** The client is a view and a cache.

## 3. Where we are against that

| Piece | State |
|---|---|
| Planner with lanes + working level | **#211** (merge pending) |
| Easy refund, junk gate | **#211** |
| Articles use target words | **#211**: articles only, newest cards only |
| Words you choose (Discover, ハルカ tap) actually get promoted | **#211**: they lead the struggle lane. Before this, a tapped ハルカ word never got promoted |
| ハルカ nominates from conversation | **Missing**: `record_usage` misses go to notes; the dream's "study focus" only shapes ハルカ's own prompts |
| Grammar in the plan | **Missing**: points are detected and shown; none rated, none scheduled |
| Honest "known" | **Missing**: read-past credit still counts as a review |
| Outcome metrics in 進捗 | **Missing** (data exists: `intake_level_progress`) |
| Server-side state | **Partial**: rows sync, but promotion and grading run client-side |

## 4. ハルカ adding words and grammar from conversation

What she can do today:
- `add_to_deck`: an offer you tap.
- `record_usage`: notes right/wrong use of a word.
- `suggest_grammar_rating`: you confirm.

None of these feeds the planner automatically.

**Proposal: struggle → queue, by rule, not by model whim.**

1. **Evidence.** Every time she records a word or grammar point you got wrong, or that you asked about ("what's the word for…?"), it's logged with the item, kind and thread. `record_usage` already does this.
2. **Rule (server, deterministic).** The nightly dream counts the evidence:
   - an item missed **twice across separate conversations**, or asked about and then missed, is queued automatically as a *chosen* word, so it leads the struggle lane;
   - a grammar point is moved to *hard*.

   No tap needed: it only enters the queue, and the daily cap still governs what becomes a card.
3. **Visible, reversible.** 今日 shows "ハルカ added 3 words from your conversations" with an undo per word. Her next chat practises them.
4. **One-off words** (a single miss, an asked-about word) stay as today's tap offer in the recap.

**Security.** CLAUDE.md requires state changes to come from the learner's own words and cost-bearing ones to need a tap. This stays inside those rules:
- the evidence is your own Japanese;
- the rule runs server-side over counted events, not on a model's say-so;
- queueing spends nothing (promotion is capped);
- every add can be undone.

Article or transcript text must never count as evidence. Only your messages do, so `record_usage` keeps its "only the learner's own messages" rule. The PR will state this reasoning, as the security section asks.

**Grammar, the same way:**
- the panel's first-meet tap (spec Change 5) gives the signal;
- ハルカ's evidence moves points to hard;
- a small grammar lane puts one point a day into the plan: an example sentence card, and articles and ハルカ asked to use it.

## 5. Roadmap

**Now**
1. Merge #211, apply migration 39, deploy process-article, raise new words/day to 5.
2. Re-audit Nov 1 against the spec's acceptance criteria.

**Next (measurement first)**

3. 進捗: per-level solid line + weekly "new words learned" (mockup first).
4. ハルカ struggle → queue rule (section 4), with the 今日 notice and undo.
5. Grammar first-meet tap, and ハルカ evidence moving ratings.
6. Honest "known": read-past credit stops graduating words never recalled (own spec).

**Later**

7. Planner server-side, as one edge function or RPC. Client promotion and grading become calls. That removes the cross-device and rehydrate bug classes.
8. Grammar lane in the planner; target grammar point in articles and podcasts.
9. Targets in podcasts and songs, not just articles.
10. Fit FSRS parameters to your own review log once there are enough real recalls.

**Standing practice:** a weekly automated audit (a cron writing a small report row) so the next stall shows up in days, not months.

## 6. Decisions for you

1. ハルカ auto-queue threshold: **two misses across conversations** (proposed), or one miss plus a lookup?
2. Should auto-added words appear in 今日 with undo (proposed), or silently?
3. Priority order for "Next": I'd do metrics (3) first so the rest can be measured, then ハルカ (4). OK?
