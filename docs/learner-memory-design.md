# Learner Memory: one agent across tutor, curation and content
Status: **proposal, 2026-10-17.** Ties together `docs/tutor-agent-design.md` (branch `docs/tutor-agent`) and the web-search / curation spikes (`docs/spikes/web-search-spike.html`, `docs/spikes/curation-e2e.html`). Nothing built yet.

The idea: Yugen has **one agent** that knows the learner. It is the same "person" whether it is chatting as the tutor, picking tomorrow's news, or researching a podcast. What makes it one agent is not one process but **one memory**: everything it does reads from the same picture of the learner, and everything the learner does (reading, listening, studying, talking to it) writes back into that picture.

* * *
## 1. Why one memory
Today each feature keeps its own small view of the learner:

| Feature | What it knows about you |
| --- | --- |
| News (Groq clustering + Gemini) | selected topics, word list; nothing about what you read or skipped |
| Podcasts | the source you picked |
| Songs | nothing |
| Flashcards | your word and kanji schedules |
| Tutor (proposed) | its own notes (§6 of the tutor doc) |

The spike showed what a shared view buys. Given 30 days of opened and skipped titles, Haiku removed repeats, noticed food had not appeared in a month, and wrote a fair profile of your taste. The tutor needs the same picture, plus more: what you struggle with, what you told it last week. If each feature builds its own, they drift apart; if they share one, every feature gets better when any of them learns something.

**Examples of the loop working:**
- You tell the tutor you're going to Kyoto next month → a Kyoto story and a podcast on 京都の祭り show up that week.
- You read the BOJ article and looked up 物価 twice → the tutor can bring it up: 「今朝の日銀の記事、どうだった？」, and 物価 gets a nudge in review.
- You keep mixing up は/が in chat → tomorrow's article is asked to use contrastive は a few times, and the recap points to it.
- You finish a long read on fusion → the editor stops offering fusion explainers and the tutor can ask what you thought.

* * *
## 2. Memory layers
Long-horizon memory works by keeping raw history cheap and complete, and giving the model **compressed layers** on top. Each layer is rebuilt from the one below, so nothing is lost if a summary is wrong.

| Layer | What | Size in context | Updated |
| --- | --- | --- | --- |
| **L0 Event log** | everything that happened: article shown / opened / finished / skipped, podcast and song plays, lookups, reviews, chat messages | never loaded whole; searched | live |
| **L1 Daily digest** | one short paragraph per day: what was read and heard, words struggled with, conversation highlights, notable moments | last 7 days, about 1k tokens | nightly (Haiku) |
| **L2 Learner profile** | one structured document: level, interests with evidence and recency, struggles (grammar patterns, words), topic coverage, preferences, personal notes ("works in tech", "trip to Kyoto in Nov") | 1.5–2.5k tokens | nightly consolidation + live tool writes |
| **L3 Retrieval** | search over L0 + L1 for specifics: "the article about the breakfast street", "what did we talk about last Tuesday" | on demand, via a tool | — |

**Rules that keep it healthy over months:**
- **The profile has a size budget.** Consolidation must merge and drop, not append. Each item carries a last-seen date; stale interests fade unless re-confirmed.
- **Evidence, not vibes.** Every profile line cites what supports it (e.g. "opened 6 of 7 AI stories", "said so on Oct 12"). This is what stopped the spike's editor from deciding "dislikes SpaceX" from two skips once we asked for it.
- **Skips are weak signals; finishes and conversations are strong ones.** (See [variety-first rules](#5-curation-on-top-of-memory).)
- **The learner can see and edit it.** A "what Yugen knows about you" page in Settings shows the profile in plain language, with delete on any line. This is a trust feature, not an extra.

* * *
## 2a. Dreaming: how the layers get rebuilt
"Dreaming" is the name the field has settled on for **offline memory consolidation**: a background pass, between sessions, that rereads recent raw history and rewrites the agent's memory. No model weights change; it's maintenance of external memory, done while nobody is waiting. Research and products that shape this design:

| Source | Idea we take |
| --- | --- |
| Anthropic **Dreams** (Managed Agents, research preview) | Reads a memory store + up to 100 past sessions, writes a **new** store: duplicates merged, stale or contradicted entries replaced with the latest value, new insights surfaced. **The input is never modified**, so the output can be reviewed or discarded. Steered by high-level instructions, not line edits. |
| Letta **sleep-time agents** (sleep-time compute paper) | The chatting agent **can't edit its own core memory**; a background agent does, during idle time. Also: use idle time to **precompute** what the next session will need. A slower, stronger model can do the sleep work since nobody waits on it. |
| **Auto-Dreamer** (2026) | Fast per-session writes, slow cross-session consolidation. The consolidator reads a region of memory plus the **raw trajectories it came from**, and **replaces** it with a smaller set. Memory 6–12× smaller and better task results than append-style memory. |
| **SCM** (sleep-consolidated memory, 2026) | Explicit **forgetting**: keep score = importance × recency, with the cut-off rising as memory grows. Log what was forgotten and give the user control. Its "REM" step links related memories into new associations. |
| Claude Code **Auto Dream** | The practical version: every day or so, tidy memory files, remove duplicates and stale notes, turn relative dates into absolute ones. |

**What changes in our design:**

1. **Two speeds of writing.** During the day, everything is a cheap, append-only *observation*: an event, a tutor `save_note`, an editor pick reason. Nothing live edits the profile. Only the nightly dream rewrites L1 and L2. (Letta's split. It stops a chat from bloating or contradicting the profile mid-conversation.)
2. **Every dream writes a new version.** `learner_profile_versions` keeps each night's profile; the app reads the latest. A dream can be rolled back, and the "what Yugen knows about you" page can show **what changed last night** ("new: planning a trip to Kyoto · faded: fusion energy").
3. **Guards instead of review.** Anthropic's Dreams expect a human to review the output; a learner won't. So a dream is auto-accepted only if it passes checks: within the size budget, every line cites evidence, no more than a few items dropped in one night. Otherwise keep yesterday's version and flag it.
4. **Provenance.** Each profile line keeps ids of the events behind it (Auto-Dreamer), so a later dream can re-check the evidence, and the learner can tap a line to see why.
5. **Forgetting on purpose.** Items carry importance (said in chat > finished > opened > skipped) and a last-confirmed date. When the profile nears its budget the weakest go first. Forgotten items are logged, not lost, since L0 still has them.
6. **Precompute tomorrow (the sleep-time compute idea).** The dream doesn't only tidy; it plans:
   - an **editor brief** for tomorrow's batch: topics due for variety, angles that fit current interests, stories to follow up
   - a **study focus**: two or three words or grammar points to weave into articles and chat
   - **tutor openers**: things worth bringing up ("you finished the fusion read — what did you think?")
   - **content ideas**: a podcast or long read the learner might want, offered not created

   The editor and tutor start each day from this brief instead of working it out on every call.
7. **Associations, carefully.** SCM's "REM" step links memories into new connections. For us that means cross-interest ideas (Kyoto trip + food → a Kyoto food story). Useful for curation, but kept as *suggestions in the brief*, never written into the profile as facts.
8. **Light nightly, deep weekly.** Nightly on Haiku: digest the day, apply notes, write the brief. Weekly, a deeper pass on a stronger model rereads the week's digests and conversations, re-checks the evidence and prunes. Nobody waits, so the stronger model is affordable (about $0.05–0.10 per learner per week on Sonnet).
9. **Measure whether dreaming helps** (Auto-Dreamer trains on task results; we can at least track them): open and finish rates, the variety of what's actually read, review recall on the study-focus words, whether tutor corrections recur less. If a change to the dream prompt doesn't move these, it isn't helping.

**Build or buy?** Anthropic's Dreams API is the closest off-the-shelf version, but it doesn't fit yet: it's a research preview, it takes **Managed Agents sessions** as input (our app calls the Messages API from edge functions), it runs on Sonnet or Opus only, and it takes minutes to hours per run. We'd build the same shape ourselves: a nightly edge function per learner, Haiku, writing to Postgres. Revisit if the tutor ends up on Managed Agents.

* * *
## 3. Signals: what we have and what's missing
Most of L0 already exists, spread across tables. A few signals are missing or too weak.

| Signal | Today | Gap |
| --- | --- | --- |
| Articles shown / opened / skipped | `processed_news.status`, `read_at`, `dismissed_at` | **"read" means opened, not finished.** Add `finished_at` (reached the end) and time on article. |
| Article topic | `metadata.category` | **mostly "Recent News"**, so topic coverage can't be computed. Store the feed topic id. |
| Article content summary | Japanese `content` only | store the English source title + a one-line summary, so memory and dedupe don't need to read Japanese |
| Long reads | `long_form_works.reading_position`, `status` | fine |
| Podcasts | `podcast_episodes.listen_position_ms`, `listened_at` | fine |
| Songs | `songs.last_played_at` only | no play history or count; add a small play log |
| Word lookups | `study_history` (`lookup`) | **no article id**, so we can't say "looked up 物価 in the BOJ article". Add it to metadata. |
| Reviews | `srs_review_log`, `kanji_review_log` | fine |
| Grammar struggles | `grammarProgress` (#43): your EASY / MEDIUM / HARD rating per grammar point, set in the reader's grammar panel | already the base. The tutor adds evidence from conversation (points you get wrong or avoid), so the two together say what's actually hard |
| Tutor conversations | — | new: `tutor_threads`, `tutor_messages` (tutor doc §6) |

Rather than one giant new events table, L0 can be a **view** (`learner_events`) unioning these, so existing features keep writing where they do now.

* * *
## 4. One agent, several jobs
Same memory, same persona and voice, different job prompts. Each job assembles its context in the same cache-friendly order:

1. tools (job-specific)
2. system: who Yugen is + the job's rules
3. **L2 profile** (changes once a day → cached across all of that day's calls)
4. **L1 last 7 digests**
5. today's raw events (L0, today only)
6. the job's input: chat thread, RSS pool, topic request

| Job | Trigger | Model | Input | Writes back |
| --- | --- | --- | --- | --- |
| **Tutor chat** | learner opens the sheet | Sonnet or Haiku (measure; tutor doc §8) | screen context + thread | messages, notes (`save_note`), word usage (`record_usage`) |
| **News editor** | buffer refill / overnight cron | Haiku | RSS pool + recent shown titles | picks + reasons (so the tutor knows why something was chosen) |
| **Content on request** | tutor tool or "describe a topic" box | Haiku + web search | topic + profile | a long read or podcast research pack ($0.04–0.05 each in the spike) |
| **Nightly dream** (§2a) | cron | Haiku | today's L0 + the day's notes + current profile | L1 digest, new L2 version, tomorrow's brief |
| **Weekly deep dream** | cron | Sonnet | the week's digests + conversations + profile | re-checked, pruned L2 version |

The tutor gets two more tools on top of its design-doc list:
- `search_history(query)` → L3 retrieval ("that article about breakfast")
- `request_content(kind, topic)` → queues a long read or podcast through the content job ("I'd like to read more about this" → it appears in 本棚)

* * *
## 5. Curation on top of memory
The spike's editor read 30 days of raw titles. With memory it reads the profile instead, plus a short **recently shown list** for the hard no-repeat check. The rules are the ones agreed on Oct 17:

1. **No repeats** (hard): never re-show a story, opened or skipped, unless there's a real new development.
2. **Variety first:** span at least 4 topics per batch and include one topic that's been rare lately (computed from the profile's coverage, not guessed).
3. **Taste, lightly:** interests choose *which* story within a topic and the angle, never whether a topic appears. A skip is about that story, not its subject.
4. **Fetch before choosing:** full text is extracted for the shortlist before the final pick, with lengths visible; the writer can return INSUFFICIENT instead of padding.

New with memory:
- **Struggles shape the text, not just the vocab.** The rewrite prompt already takes the word list; it can also take one or two grammar points from the profile to use naturally.
- **Conversations count as interests.** Things said to the tutor are strong evidence (stronger than opens).
- **The editor explains itself.** Each pick stores a one-line reason, which the tutor can use ("I picked this because you mentioned Kyoto").

* * *
## 6. Cost (per active learner, per day)
| Item | Estimate |
| --- | --- |
| Nightly dream (Haiku: digest, profile, brief) | about $0.005 |
| Weekly deep dream (Sonnet) | about $0.01 a day, averaged |
| News editor (Haiku, 4 articles, from the spike) | about $0.02 |
| Gemini rewrites (unchanged) | about $0.016 for 4 |
| Tutor chat | depends on use; cached profile keeps turns cheap (tutor doc §8) |
| Content on request | $0.04–0.05 each, only when asked |

Memory itself is a rounding error; the tutor's chat turns and voice will dominate.

* * *
## 7. Build order
Each step ships on its own and is useful without the next.

1. **Signals.** `finished_at` + time on article, real topic on articles, English title/summary on article rows, article id on lookups, song play log. Small, and everything after depends on it.
2. **Haiku editor in production.** Replace Groq clustering in the buffer refill with the spike's pipeline (shortlist → fetch → pick → optional write), reading raw history directly for now. Keyed Jina first, web fetch fallback.
3. **Memory layer and nightly dream.** `learner_events` view, the nightly dream (digest, versioned profile with guards, tomorrow's brief), the "what Yugen knows about you" page with last night's changes. Switch the editor from raw titles to the profile and brief. Weekly deep dream once the nightly one is stable.
4. **Tutor steps 1–2** (tutor doc §12) built on the profile from day one; chat summaries flow into digests, `save_note` writes into the profile.
5. **Tutor tools for content.** `search_history`, `request_content`; topic → long read and topic → podcast research pack.
6. **Voice** (tutor doc §9).

* * *
## 8. Open questions
1. **One profile or two?** A single profile for everything, or a learner profile plus per-persona relationship notes (tutor doc §6)? Proposal: one profile, with a small per-persona section for personal chat details.
2. **How strong is a chat signal?** If you say "I love space" once, how far should the editor lean? Proposal: it counts like several opens, fades over a few weeks unless repeated.
3. ~~Where do grammar struggles come from?~~ Settled: the grammar panel's EASY / MEDIUM / HARD ratings (`grammarProgress`) are the base, paired with what the tutor sees in conversation. The tutor can suggest changing a rating ("you've used 〜わけじゃない right five times, mark it MEDIUM?") but doesn't change it silently.
4. **Privacy defaults.** Chat transcripts kept verbatim for how long before only digests remain? Proposal: 30 days verbatim, digests indefinitely, all deletable.
5. **Should the editor's picks be visible?** e.g. a quiet "選んだ理由" line on the card. Nice for trust; might be noise.
6. **Which model for the tutor?** Measure Haiku vs Sonnet on real transcripts before choosing; memory jobs stay on Haiku either way.
