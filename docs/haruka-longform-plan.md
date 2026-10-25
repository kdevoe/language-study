# ハルカ's long reads

**Status:** built 2026-10-25 (branch feat/haruka-longreads). Decisions settled with the user.

## The idea

ハルカ writes the learner long reads in two ways:

- **On her own, twice a week.** She writes one right after the nightly dream on the nights that were Tuesday and Friday in the learner's timezone, so it's waiting the next morning. She picks the topic from what she knows about the learner: their conversations with her, what they read and finished or skipped, and her profile of them. She knows every past long read, and she uses judgement: a topic comes back only when there's something worth adding to it, and then the new piece builds on the old one rather than retelling it.
- **When asked.** The learner asks her in chat ("write me a long read about X"), taps her offer, and she starts writing right away. It arrives a few minutes later, and she says so in the chat.

Either way she researches the topic on the web, writes an English source, and the long-form pipeline we already have turns it into Japanese at the learner's level.

The learner finds out about a scheduled piece in two ways: her greeting the next morning mentions it, and it's the long read shown on the 今日 home page. A requested piece is announced in the chat where they asked, and it also shows on 今日.

Most of the parts already exist:

| Needed | Already there |
|---|---|
| Who the learner is | the learner profile + nightly digests + thread summaries (`learner-dream`) |
| Topic ideas | the nightly brief already produces `ideas: [{kind: 'longform', topic, why}]`, though nothing uses them yet |
| Facts from the web | the quarantined search (renamed `lookup()` below), which a new deep `research()` sits beside |
| Japanese at the right level, in parts | the long-form import path in `process-article` (chunking, lexicon, continuity, JIT parts, resume) |
| Long jobs in stages | `generate-podcast`: each stage in its own invocation, retry from the stage it stopped at |
| Offering something in chat | the `request_content` → `content_offer` chip (podcasts today) |
| Telling the learner later in chat | background lookups land as a note in the thread, and her followup turn shares it |

## One job, two ways in

```
scheduled                                     requested
─────────                                     ─────────
learner-dream nightly (08:00 UTC)             learner asks ハルカ in chat
  finishes (or fails) for a learner             → request_content kind 'longform'
  → was last night Tue/Fri in their tz?           (past-topic check, cap check)
    yes → POST write-longread                   → offer chip 「書いて: X」
          { userId, trigger: 'scheduled' }      → tap → POST write-longread
          (service role)                            { trigger: 'requested', topic, angle, threadId }
                                                    (the learner's own JWT)
              │                                       │
              └──────────────┬────────────────────────┘
                             ▼
write-longread (new edge function; stages like generate-podcast)
  gate (code): one job in flight per learner; weekly caps
  insert longread_jobs row → 202 at once; the rest runs in the background
  stage 1  topic     requested: the learner's topic + angle
                     scheduled: choose (Sonnet, structured, no side-effect tools)
                       reads (fenced): profile, 14 days of digests + thread summaries,
                       articles finished / skipped, brief.ideas, EVERY past long read
                       → { topic, angle, why, title, questions[4-6],
                           revisits?: workId, whatsNew? }
                       → overlap check: a close match without revisits/whatsNew → choose again once
  stage 2  research  research(topic, questions) → checked dossier (~6-10k chars)
  stage 3  write     Sonnet, no tools: English source, ~8-16k chars (1-2 parts),
                     specifics only from the dossier → output checks
                     → create the work via process-article's import path
                       (source_type 'haruka'); part 1 prepares in the background
  done     scheduled: add an opener to this morning's brief
           requested: append a note to the thread → her followup turn says it's ready
```

Each stage runs in its own invocation (a self-call with the service key, as `generate-podcast` does), so deep research and writing don't share one wall-clock budget. The job row records the stage, the topic, the dossier and any error, so a failed job retries from the stage it stopped at.

### Scheduled: chained after the dream

The dream runs at 08:00 UTC. When it finishes for a learner (successfully or not), it checks their `user_preferences.timezone` (UTC if none is set). If the night that just ended was a Tuesday or Friday there, it starts `write-longread` in the background.

- **Fresh information.** The dream has just summarised yesterday, so she chooses with the day's chats already digested.
- **One schedule.** No new cron. The greeting is simple: the dream has already written that morning's brief, and the job adds its opener to it when it finishes.
- **The dream failing doesn't cost the piece.** The chain runs either way, and the topic step reads the last accepted profile.
- **The hour is the dream's.** 08:00 UTC is 01:00 Pacific now and 00:00 from November 1, so it's still that night. The learner's timezone decides which night counts. If the dream later moves to each learner's local clock, this follows it for free.
- If a requested piece arrived in the last 20 hours, that night's scheduled piece still runs. They are separate pieces, and the weekly cap covers both.

### Requested: right away

1. **She offers, the learner taps** (per CLAUDE.md, a side effect that costs money needs the learner's confirmation). `request_content` gains `kind: 'longform'` alongside `'podcast'`, and the existing offer chip appears under her reply.
2. **Before offering**, the tool handler checks:
   - **Past topics.** If X is close to an earlier piece, the tool tells her which one and when. She can mention it naturally ("前に〜について書いたね。今度は…") and the new piece builds on it. The learner's request always goes ahead.
   - **Caps.** If the learner is over the cap, or a piece is already being written, the tool says so and she tells them, with no offer.
3. **The tap starts it.** The client POSTs `write-longread` with its own JWT; `actingUserId` means a learner can start one only for themselves. The function enforces the caps again and returns 202 at once.
4. **While it's written** (a few minutes), she can say so in her reply ("書いてるね。数分でできるよ"). No progress UI.
5. **When it's ready**, the job appends a note to the thread, the same way a background lookup does, and her followup turn tells the learner ("できたよ！本棚にあるよ"). If the chat is closed by then, 今日 shows the piece and the note is there next time. If it fails, the note says so and she can offer to try again.
6. **The note opens the piece.** Under her line sits a work block (the title and part count, like the weekly recap's `RecapBlock`), and tapping it opens part 1 in the Reader. The block comes from the job's `work_id` in the note's context, not from her text, so nothing clickable is built from model output. A scheduled piece's morning opener carries the same block, the way Sunday's opener carries the recap.

## Lookup and research: two separate functions

Today's `research()` is a quick lookup: 3 searches, 5 one-line facts, at most ~1.2k chars. That's right for a chat reply but too little for a long read. The writer would fill the gap from memory, and one-line facts lose the why, the sequence of events and the stories that make a long read worth reading.

| | `lookup()`: today's `research()`, renamed | `research()`: new |
|---|---|---|
| For | ハルカ in chat, the dream's openers, topic podcasts | long reads (and later, perhaps, topic podcasts) |
| Reading | ~3 searches, snippets | ~10-15 searches, plus fetching and reading 4-6 full pages |
| Output | ≤5 one-line facts + source | a dossier: background, timeline, key people and places, a few stories; notes of several sentences, each with its source |
| Size | ≤1.2k chars | ~6-10k chars |
| Checks | `researchFilter.ts` as today | the same checks for links, contact details, text aimed at an AI, tool names, and the rule that each source is a page the search actually returned. Notes may be longer, and "you" is allowed inside attributed quotes |
| Who reads the result | ハルカ, fenced | only the writer, which has no tools. ハルカ never sees the dossier, only the finished title |

Both are quarantined the same way: Haiku with web search (plus page fetching for `research`), no other tools, and code checks on what it reports. The rule "never give a model with side-effect tools raw search results" holds for both.

**The rename is code only:** ハルカ's chat tool keeps the name `research`, because old threads contain `tool_use` blocks under that name and her prompt teaches it. Its handler calls `lookup()`.

### Why ハルカ writes an English source rather than Japanese directly

The rewrite step is what makes a text readable for this learner: the ALLOWED-list lexicon, level, furigana, tokens, grammar marks and continuity across parts. Writing in English and passing it through `process-article` keeps all of that, and the eval harness stays the yardstick. Writing Japanese directly would skip all of it.

## Choosing the topic (scheduled pieces)

- **Revisit with judgement, never retell.** The chooser sees every past long read: ハルカ's and the learner's own imports, with no time window, each with a short `topic` line and a few-sentence `summary` in `meta`. Imports get both from Haiku when they're created, and a one-off backfill covers existing works. Coming back to a topic is fine when it's worth it, for example:
  - the story has moved on since the last piece (research can confirm that);
  - the learner kept talking about it with her, or finished it and asked more;
  - a side of it the earlier piece only touched on.

  When she revisits, she names the earlier piece (`revisits`) and says what's new (`whatsNew`). The writer gets the earlier piece's summary, so the new one builds on it ("last time… since then…") instead of retelling it. When nothing is new, she picks something else.
- **A light check, not a ban.** Code compares the chosen topic with past ones (keyword overlap, plus a cheap Haiku "same subject?" against the closest few). It only catches a revisit she didn't declare: a close match with no `revisits` / `whatsNew` sends her back to choose again once. A declared revisit goes ahead. A guideline in the prompt keeps revisits the exception: most pieces should be new ground.
- **Variety first** ([news curation]): spread across areas. Lean toward things the learner keeps returning to in chat, but every few pieces, bring in a neighbouring interest ("Kyoto trip + food → a Kyoto food story", learner-memory-design §7).
- **Longer arcs than the news**: history, how something works, a place, a person, the background to a story they've been following. Not breaking news, which the feed already covers.
- **Feedback**: a ハルカ long read that was left unfinished counts against similar topics. One that was finished, or talked about with her, counts for them.

## Home page (今日)

Today's 本棚 card shows only a work already in progress (`pickContinueWork`: reading position > 0). The change: **a new, unopened ハルカ piece takes that slot** until it's opened, then the slot goes back to the work in progress. It's the same card with the title and part count, and the corner reads 新着 instead of the part count. No new section is added. Tapping it opens part 1, the same as 続きを読む.

If the learner never opens it, it gives the slot back after 7 days so a stale piece doesn't sit on the home page.

## Security (per CLAUDE.md)

- **Who can start a job.** `write-longread` accepts the service role (the dream's chain) or a signed-in user acting for themselves (`resolveCaller` + `actingUserId`); the anon key alone gets a 401. A user caller can only start `trigger: 'requested'`.
- **Requests come only from the learner.** `request_content` offers a long read only when the learner asked in their own words, never because of text in an article, a transcript or a lookup result (her existing rule for podcasts). The tap is the confirmation.
- **Untrusted input.** Transcripts, article text, notes and request topics are fenced (`fence`/`dataRule`). The choosing and writing models have no side-effect tools; their only output is a structured topic or a text.
- **Web.** Only through `research()` / `lookup()`. Raw pages never reach the writer.
- **Output checks before saving.** The source must fall within length bounds and contain no links or contact details. It's also checked for anything addressed to the reader or to an AI (reusing the `researchFilter` patterns). `scrubLinks` still runs on the rewrite.
- **Cost caps, server-side**, in `write-longread` and backed by the database:
  - one job in flight per learner (unique partial index on `longread_jobs`);
  - at most 2 requested pieces and 4 pieces in all per 7 days;
  - one scheduled piece per night;
  - 15 searches and 6 page fetches per job.
- **Per user, not shared.** Each piece is written for one learner, so nothing reaches anyone else.

## Changes

| Where | What |
|---|---|
| `database/42_haruka_longform.sql` | `source_type = 'haruka'` allowed on `long_form_works` + `processed_news`; `meta jsonb` on works (topic, summary, why, trigger, revisits, cost) + a backfill of `meta.topic` / `meta.summary`; `longread_jobs` (user_id, trigger, status/stage, topic, angle, thread_id, dossier, work_id, error, timestamps) with RLS (learners read their own rows) and a unique in-flight-per-user index |
| `_shared/lookup.ts`, `_shared/research.ts` | rename today's `research()` to `lookup()` (tutor-chat, learner-dream, generate-podcast callers); new deep `research()` |
| `_shared/researchFilter.ts`, `scripts/eval-research-filter.mjs` | a dossier profile for the checks, plus eval cases |
| `write-longread/` (new function, `verify_jwt = false`) | auth + caps → job row → stages topic / research / write as self-calls → hand off to `process-article` → opener (scheduled) or thread note (requested); retry from the failed stage |
| `learner-dream/index.ts` | after the nightly pass (in `finally`), on a learner's local Tue/Fri night, POST `write-longread`; `ideas` feed the chooser |
| `process-article` | accept a service-caller import with `sourceType: 'haruka'` and `meta`, exempt from the 3-imports/day guard (it has its own) but still counted in the parts guard; imports get `meta.topic` + `meta.summary` (Haiku) |
| `tutor-chat` | `request_content` `kind: 'longform'` with the related-piece and cap checks; prompt lines on when to offer and what to say while it's being written; the ready/failed note triggers her followup; `<today>` note includes new ハルカ works |
| `src/` | offer chip handles `kind: 'longform'` (POSTs `write-longread`); a `WorkBlock` under her line (from `context.work`) opens the piece, as `RecapBlock` does; `Today.tsx` gives the 本棚 slot to an unopened ハルカ piece with a 新着 corner; 本棚 card source label reads ハルカ |
| `docs/design-system.md` | note the 新着 corner on the 今日 本棚 card |

## Cost

Per piece, roughly: choosing (Sonnet) ~$0.04 (scheduled only), `research()` ~$0.30-0.50 (searches at $0.01 each plus page text read by Haiku), writing (Sonnet, ~4k tokens out) ~$0.08, rewrite (Gemini, 1-2 parts) ~$0.02. That's **about $0.50-0.70 a piece**: $1-1.40 a week for the two scheduled pieces, at most $2.80 a week with two requests.

## Build order

1. Split `lookup()` / `research()` and add the dossier filter + eval cases. No behaviour change for chat.
2. Migration 42 (applied by hand), `write-longread`, and the `process-article` changes. Test with a service call for my user and read the piece.
3. Chain from the dream + the morning opener.
4. Chat requests (tool, chip, thread note + followup).
5. 今日 slot + 新着 corner.

## Still open

- **Length:** aim for two parts and let the writer stop at one when the dossier is thin, unless you'd rather fix it at one.
