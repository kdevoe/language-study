# 2026-10-18 morning: ハルカ and article issues (for a session with Supabase access)

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
