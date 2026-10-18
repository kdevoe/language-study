# 2026-10-18 morning: ハルカ and article issues (for a session with Supabase access)

## Confirmed from the database (2026-10-18)
1. **Opener:** there is no learner_briefs row for 10-18; the only brief is 10-17 (18:46 UTC, a manual run).
   - Cron ran and auth passed, but both dreams returned 500 (net._http_response):
     - **Nightly 08:00 UTC:** `Cannot destructure property 'lookups' of 'raw' as it is undefined`. The write_memory call came back without `brief`, and researchForBrief (#201) crashed on it before anything was written. callTool doesn't check required fields or stop_reason.
     - **Weekly 07:00 UTC** (its first Sunday): `tool_choice: type "tool" and "any" are not supported for this model`. Sonnet 5.5 rejects callTool's forced tool_choice, so weekly has never worked.
2. **Stale thread:** the server started a new thread for 10-18 at 14:16:39, as designed. The panel just kept yesterday's lines (client only).
3. **No answer to おはよう:** the request arrived, and the `<today>` note was written (07:14 Mars article).
   - Her first message (14:16:47) is [thinking, text], with no tool_use block. The text ends in a tool call written out as text (`<invoke name="get_text">…`). usage is null, so stop_reason was tool_use.
   - runTurn found no tool_use blocks, saved a user row with `content: []` (14:16:49) and sent it as the next turn. That's an invalid request, and the turn never finished; the stream died after about 4 minutes.
   - Fixes:
     - treat tool_use with no tool_use block as the end of the turn, and strip the leaked call text;
     - never save an empty tool-results row;
     - add a server timeout on the API call, and the client watchdog.
   - That assistant row still shows the raw `<invoke…>` text and needs cleaning.
4. **Mars article** (`Japan to launch-1la6tjv`): the row was created 14:13 UTC and processed once at 14:14:18 (attempts 1) from a **full** 4,578-char source. Gemini returned only 155 output tokens (2 paragraphs, 567 chars of content). So it was a short rewrite, not an overwrite from the snippet. The idempotency guard below is still worth keeping. The real problem is the thin output: add a minimum-length check and retry. "Couldn't load", then instant, fits an on-open rewrite that outlasted the client wait.

Reported on iOS PWA around 07:06–07:19 local (America/Los_Angeles), after the
app sat in the background overnight. Screenshots are in the session.

## 1. Home card opener is stale
- Card showed 「ノーベル賞の記事、読みましたね。脳の研究、どうでしたか？」, from the
  brief two nights ago, not last night's dream or the overnight news pull.
- Suspects:
  - learner-dream nightly (08:00 UTC, pg_cron → learner_dream_active_users)
    may exceed the wall-clock limit since #201. The dream now runs up to 2 web
    lookups plus a Haiku opener writer serially before upserting the brief, and
    pg_net waits 120 s. Check the learner-dream logs and whether a
    learner_briefs row exists for 2026-10-18.
  - Check cron auth too (#193): x-cron-secret / CRON_SECRET mismatch → 401.
  - Lookups failed with a 400 before #202 (the allowlist); those errors are
    caught, but check.
- Wanted: a greeting written for that morning, from the night's dream and
  news pull plus the articles waiting in the feed. Idea: write the brief first,
  run lookups in a separate invocation, and generate the morning line lazily
  on the first open of the local day (tutor-chat action), cached in the brief.

## 2. Panel still shows yesterday's thread on a new day
- History loads once per app session (historyOk), so a PWA resumed the next
  morning keeps yesterday's lines. The server starts a new thread for the new
  local day, but the panel doesn't reset or reload.

## 3. ハルカ never answered 「おはよう」
- Typing dots for ~4 minutes, then 「接続できませんでした。もう一度どうぞ。」.
- Check the tutor-chat logs around 14:15–14:19 UTC: was the request received,
  did the turn start ("today read …ms"), did the Anthropic call stall or error?
- The client has no timeout on the stream. Add a watchdog (no response headers
  in ~25 s or no event for ~60 s → abort, show an error, restore the draft).
- Possibly the iOS stale-connection problem after resume (see 4).

## 4. Mars article: "Couldn't load this article", then loaded instantly but short
- Likely chain: fetchProcessedArticleById failed on a stale connection after
  resume and returned null on error, so the app thought the article wasn't
  processed and called process-article. The news path had no "already ready"
  guard, so it re-ran the rewrite from the card's snippet and overwrote the
  good rewrite with a thin one (and paid Gemini twice).
- Check the process-article logs for a second run of that article id around
  14:14 UTC, and its sourceKind / sourceChars.
- Partial fix committed on this branch (not deployed):
  - process-article returns a ready/read news rewrite as is (cached: true)
  - fetchProcessedArticleById retries once and throws on fetch error (App shows
    the error instead of reprocessing); the long-read callers keep null semantics
- The overwritten Mars article needs regenerating, or restoring if the old
  content can be found.

## Fixed and deployed (2026-10-18)
- learner-dream: a missing brief no longer crashes the night; Sonnet 5.5 gets
  tool_choice auto (it rejects forced tool use) with the reply validated.
- callTool checks required fields at every depth: the re-run nightly brief came
  back with studyFocus/openers/ideas/lookups nested inside `editor`, which a
  top-level check let through (no Home opener, no lookups). A misnested reply
  is now regenerated; learner-dream also lifts such fields back up.
- tutor-chat: a tool call written out as text (`<invoke name="get_text">`, and
  later `add_to_deck` for 宇宙開発) is stripped; side-effect tools in it are
  carried out. Stalled Anthropic calls time out at 90 s; the stream pings every 15 s.
- Panel: history reloads on a new day and after returning from the
  background; a send that fails before any reply puts the message back in the
  box; leaked call text is hidden while streaming. streamTutor has a watchdog.
- process-article: a rewrite much shorter than the paragraph target is retried
  (the longest attempt is kept).
- Data: leaked text stripped from two assistant rows, the empty tool-result row
  deleted, today's brief re-run and its fields lifted, Mars article regenerated.
