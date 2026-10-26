# Offline mode (機内モード): investigation and plan

*Oct 25, 2026. Status: phases 1 (offline launch, #232), 2 (offline dictionary, #231), 3 (outbox, #233) and 4 (offline pack, `feat/offline-pack`) built; the rest is a proposal.*

## Goal

Before a flight, the learner turns on one setting. The app downloads a sensible bundle while it's still online: unread news, the next parts of the long reads they're in, recent episodes, songs. In the air they can read with word lookup and furigana, listen to podcasts and songs, and do their flashcards. When they land, everything they did syncs and nothing is lost.

## What already works offline

| Piece | State today |
|---|---|
| App shell (JS, CSS, code-split chunks such as `kanjiReadings`) | Precached by the service worker (`vite.config.ts`, workbox `globPatterns`). |
| Kuromoji dictionary (17 MB) | `CacheFirst` runtime cache, so it's there once it has been used once. |
| Word, kanji and grammar decks | Live in persisted Zustand (`yugen-storage`, `yugen-kanji`, `yugen-grammar`). Card faces, meanings and schedules are local, so reviewing works with no network. |
| Song and episode audio | `audioCache.ts`: whole files in the Cache API, LRU (music 50 files / 150 MB, podcasts 5 / 30 MB). Only filled when a track is played. |
| Song covers | Cache Storage (`songs.ts`). |
| List pages (本棚, 番組, 音楽, 今日's news) | `listCache.ts` shows the last-loaded cards right away, but opening any one of them needs the network. |
| Activity seconds | `activity.ts` keeps unsent counts in memory and retries them. They're lost if the app is killed. |

## What breaks offline (in the order you'd hit it)

1. **Launching blocks you at the beta gate.** `App.tsx:329` calls the `check_is_approved` RPC on every launch. Offline it errors, `status` comes back null, and `setApprovalStatus(status || 'not_joined')` puts up the waitlist screen. **The app can't be used offline at all until this is fixed.** The fix is small: remember the last `'approved'` result, and on a network error use it instead of `'not_joined'`.
2. **Session refresh.** `getSession()` is wrapped in an 8 s timeout and the session isn't cleared on failure, which is good. Still to confirm on a device: when the access token has expired and the refresh fails for lack of network, supabase-js should keep the stored session rather than emit `SIGNED_OUT`.
3. **Opening an article.** The Reader gets articles from the server (`fetchProcessedArticleById`, `fetchReadyBufferArticles`, `fetchWorkResumeArticle`). After that, `enrichArticle()` needs **JMDict in Supabase** (`lookupLemmasBatch`) to attach meanings to the tokens. Enriched blocks are never saved, because full articles were taken out of the persisted blob after the quota incident. Offline, the article doesn't load, and if it did, it would have no word links.
4. **Word taps.** Once an article has been enriched, the meaning travels on the token, so the WordModal opens without a network call. These still need the network: the **grammar insight** (a Haiku call, contextual, fetched on every tap), **sentence translation** (Haiku), and `lookupWordAt` for tokens without a meaning (JMDict query, then the dictionary-lookup function).
5. **Podcasts and songs.** `fetchEpisode` and `fetchSong` (transcript turns, alignment, lyrics, timing) are always fetched fresh from Postgres. The audio may already be on the device, but the player can't open without that metadata.
6. **Progress writes.** Grading words calls `upsertWordProgressToSupabase` with one retry, then gives up. `logSrsReviewToSupabase`, the kanji and grammar review logs, `saveWorkReadingPosition`, `saveListenPosition`, `markArticleConsumed` and `recordPlay` are all fire-and-forget. Offline:
   - **Word schedules** stay correct on the device. The rehydrate merge is last-write-wins on `lastSeenTs`, so the local copy wins. But nothing pushes newer local rows back to the server (the reconcile at `store.ts:~1600` only pushes rows whose server `difficulty` is null). The server stays stale until each word is touched again, so overnight daily-prep, ハルカ's dream and other devices all see old state.
   - **Kanji and grammar schedules** do push local-newer rows on `sync()`, so they're fine.
   - **Review logs, reading positions, listen positions, consumed marks and play counts are lost.**
7. **Things that need a server by nature:** ハルカ chat, creating podcasts or songs, importing URLs, a fresh news feed, generating new long-read parts. Offline, these should say so quietly rather than fail.

## Proposal

### The setting

Add a row to Settings: **オフライン用に保存 / Keep content for offline**, using the existing slider toggle, with a one-line status under it: `準備済み · 12記事 · 6話 · 40曲 · 310 MB` or `保存中… 4/12`.

- **On:** builds the offline pack now, and refreshes it on each launch while on Wi-Fi. "On Wi-Fi" uses `navigator.connection` where the browser exposes it. On iOS it doesn't, so there the pack refreshes on launch, at most once every 6 hours.
- **Off:** deletes the pack and frees the space.
- **The toggle doesn't switch behaviour on or off.** Offline behaviour runs whenever the device is actually offline (`navigator.onLine` plus failed requests), with or without the pack. That way a dead spot on the train behaves the same as a flight, and nobody has to remember to turn "airplane mode" on and off.

That's the only new UI. Per the "UI additions must be necessary" rule, the offline states below are small changes to existing UI, not new screens.

### The offline pack (what to download)

All of this comes from content that already exists. **Nothing in the default pack costs extra LLM spend.**

| Content | Default amount | Source |
|---|---|---|
| News | Up to 10 unread articles from the ready buffer | `fetchReadyBufferArticles(userId, 10)`. Call `ensureBuffer` first so the server tops it up within its existing caps. |
| 本棚 long reads | For each in-progress work (most recent 3): the current part plus parts already generated after it | `fetchWorkParts` / `fetchProcessedArticleById`. Parts that don't exist yet: see open question 1. |
| Podcasts | Unfinished episodes, newest 5 | `fetchEpisode` + `saveAudio('podcast', …)` |
| Songs | Songs in the user's lists plus the 30 most played, capped at about 150 MB | `fetchSong` + `saveAudio('music', …)` + covers |
| Dictionary | JMDict shards, an estimated 4–6 MB (see Offline word lookups) | static files, `CacheFirst` |
| Decks | Already local | Warm the kuromoji dictionary and reading tables so card furigana works |

**Articles are stored already enriched.** The pack runs `enrichArticle()` while online and saves the result, so word meanings, JLPT tags and furigana are all baked in, and the Reader skips enrichment for packed articles. This also makes those articles open faster when online.

**Storage.** Add a new `services/offlinePack.ts`, modelled on `audioCache.ts`: the Cache API, one index entry, everything best-effort. Keep it out of localStorage (the quota incident). Packed audio is **pinned**, meaning the LRU eviction in `audioCache.ts` skips paths the pack holds, and packed paths don't count toward the play-cache caps. Call `navigator.storage.persist()`, as `saveAudio` does now. Rough size: an enriched article is tens of KB, a 5-minute episode about 5 MB, a song about 4 MB, so the defaults land around **200–350 MB**. That's acceptable for an installed PWA, but iOS can still clear storage. The status line should show when the pack has gone missing, rather than the app failing mid-flight.

**Reading from the pack.** `fetchProcessedArticleById`, `fetchEpisode`, `fetchSong`, `fetchWorkParts` and the list loaders look in the pack first when offline, and fall back to it on a network error when online. A small `offlineFirst(key, loader)` wrapper keeps this in one place rather than spread across components.

### Offline word lookups

Today a tap reaches the network in three places:

- `fetchWordDefinitionQuick` queries JMDict in Supabase. Its comment says "no network needed", but that's wrong.
- When there are several candidates, `disambiguateWithLLM` picks between them.
- When JMDict has no gloss, the `dictionary-lookup` function writes a definition.

`enrichArticle()` also needs JMDict for every article, episode transcript and song lyric, and `fetchHeteronymReadings` makes an LLM call for ambiguous readings.

Taps fall into three groups, from most to least common:

1. **Tokens enriched before the flight** (packed articles, episodes, songs). The meaning is already on the token, so the modal opens instantly with no lookup. The pack must store **enriched** blocks for episodes and songs too, not just the raw metadata.
2. **Tokens without a meaning**, plus anything enriched while offline. These need a dictionary on the device. See below.
3. **Words JMDict doesn't have** (names, new coinages). These fall back to the LLM today. Offline, the modal says 「オフラインでは辞書にない語です」 and still records the lookup for SRS.

**A dictionary on the device.** Build it from the Supabase tables with a script, keeping only what the modal uses. `summarizeSenses` reads the first gloss of up to 4 senses, so keep at most 4 senses, plus readings, POS, JLPT, `freq_rank`, `common`, and the small `kanji_jlpt` table for derived JLPT. It would be served the way the kuromoji dictionary is: static files under `public/`, cached `CacheFirst`, and downloaded when the pack is built rather than on install.

- **Size (built Oct 25):** 216,173 entries in 11 shards, **7.5 MB gzipped** (20 MB of JSON). That's more than the 4–6 MB first estimated, but still under half the kuromoji dictionary.
- **Recommendation: the full dictionary.** It's about a third of the kuromoji dictionary we already ship, and the common-only version misses exactly the rarer words a learner looks up.
- **Storage (as built):** the shards are imported once into IndexedDB (`yugen-jmdict`), which has multi-value indexes on the kanji and kana forms. A lookup, or a whole article's `lookupLemmasBatch`, is then one transaction, and nothing large sits in memory. The import resumes per shard if it's interrupted.
  - **Import time:** WebKit (iPhone) takes about 6 s. Chromium is slow with multi-value indexes, about 80 s in headless Chrome, but the import runs once in the background.
  - **When it downloads:** after the start-up syncs, with no UI, skipped when Data Saver is on. Once the pack exists it can download as part of it instead.
- **One interface.** `jmdict.ts` gets a local backend behind the same functions (`lookupWord`, `fetchEntries`, `lookupLemmasBatch`). Offline, or on a network error, it reads the shards. Online it keeps using Supabase, so the server stays the source of truth and the shards only need rebuilding when JMDict or the JLPT tags change (the shards carry a version stamp, like `TOKENIZER_VERSION`).
- **Choosing between candidates offline.** Use `pickBestEntry` (POS match, then kana-primary, common, frequency), as enrichment already does, instead of the LLM. For a kana tap, first narrow to entries whose main reading is that word (はし → 橋, not 嘴 read くちばし). The same rule now replaces "first candidate" when the LLM call fails online.
- **Checks:** `node scripts/test-local-dict.mjs` compares every entry's word-panel details and 86,955 homograph picks against the full tables (all match). I also checked it in Chromium and WebKit: offline, with Supabase unreachable, and with gzipped shards served the production way.
- **Readings.** Without `fetchHeteronymReadings`, ambiguous words keep the tokenizer's reading. The existing failure path already does this.

**What a lookup does offline.** The local dictionary returns the meaning. The SRS bookkeeping (`recordWordSeen`, the `'click'` difficulty event, `saveWordDefinition`) is all local already, and the reconcile below syncs it on reconnect. The grammar insight shows the "needs a connection" line.

### Sync when back online (needed even without the setting)

Add a **write outbox** (`services/outbox.ts`), stored in the Cache API or IndexedDB rather than localStorage. Writes that fail with a network error are queued:

- **Append-only rows** (SRS / kanji / grammar review logs, `song_plays`, `study_history`): queued as they are and replayed in order. Give each row a client-generated id so a replay can't double-insert.
- **Latest-state rows** (word progress, reading position, listen position, consumed marks): no queue needed. Replay is a **reconcile**: on reconnect, push every local word whose `lastSeenTs` is newer than the last successful sync. This generalises the existing "difficulty is null" reconcile.
- **Order on reconnect:** flush the outbox and the reconcile **before** the rehydrate pull. Otherwise the overnight daily-prep promotions merge against a half-synced state.
- **Triggers:** the `online` event, app launch and `visibilitychange`. Add `activity.ts`'s pending counts to the outbox so they survive the app being killed.

This also fixes the grades that are lost today on a weak signal.

**As built (`services/outbox.ts`):**
- **What goes through it:** `send(op)` is called by word progress (single, batch and pacing reset), the SRS / kanji / grammar review logs, kanji progress, the grammar schedule, `study_history`, `record_article_reading`, `bump_daily_activity`, reading positions, work status, preferences, podcast listen positions, and song plays and counts. `markArticleConsumed` replays as a `call` op, because it has logic.
- **What gets queued:** a write made while offline, or one that fails with status 0, 401, 408, 429 or 5xx. While anything is queued, new writes queue behind it.
- **Inserts:** each carries a client UUID and replays as `on conflict (id) do nothing`. Checked under RLS against the real tables in a rolled-back transaction.
- **Coalescing:** keyed ops replace one another (reading and listen positions, grammar schedule).
- **Server failures:** an op is dropped after 5 server-side failures. Network failures don't count toward that.
- **Sign-out:** clears the queue.
- **User id offline:** `sessionUserId()` (supabase.ts) replaces `getSession()` where writers need the id. Offline with an expired token, `getSession()` reports null, which skipped every write on a long flight.
- **Not queued, still online-only:** playlist edits (they roll back in the UI on failure), ハルカ, creating content.

### Offline states in existing UI

- **WordModal:** meaning, reading and JLPT tag come from the token as now. The grammar insight line reads "接続が必要です" in muted text, with no spinner that never ends. The grammar panel's static catalogue text still works.
- **Sentence translation:** if a packed translation exists (open question 2), show it. Otherwise show the same muted line.
- **Create buttons** (podcast, song, import) and **ハルカ's edge:** shown dimmed, and a tap explains why, instead of starting a request that will fail.
- **News feed:** only packed articles. When those run out: "オフライン — 新しい記事は接続後に".
- **Due counts and decks:** unchanged.

### Cost and security

- The default pack makes no new paid calls. It reads rows that were already generated, and `ensureBuffer` is already capped server-side.
- Any optional pre-generation (open questions 1–2) goes through the existing edge functions and their per-user caps. Add a daily pack cap (e.g. 1 pre-translation batch per article, at most 10 articles a day), enforced on the server, not by the toggle.
- Pack data belongs to one user. `clearListCaches()` on sign-out must also delete the pack and the outbox (same reasoning as the list cache: another account must never see these cards).
- The beta-gate cache stores only `'approved'` and the user id it was for, so it can't let a different signed-in account in.

## Phases

1. **Survive an offline launch** (built, #232). Cache the approval status, confirm session behaviour, warm kuromoji and the reading tables. Small, and valuable even without the rest.
2. **Offline dictionary** (built). A build script for the shards, a local backend in `jmdict.ts`, and a `pickBestEntry` fallback for choosing between candidates. This is independent of the pack and could ship first.
3. **Outbox and reconnect reconcile** (built). Fixes lost grades and positions today. Do this before the pack, so offline study can't lose data.
4. **Offline pack and the Settings toggle** (built). Articles (enriched), long-read parts, episodes, songs, audio pinning, `offlineFirst` readers.
   **As built:** `services/offlinePack.ts` builds it, `services/packStore.ts` stores it (IndexedDB `yugen-pack`, keys `article:<id>`, `parts:<workId>`, `episode:<id>`, `song:<id>`, `news`).
   - Contents: up to 10 ready news articles (enriched), up to 6 existing parts from the reading position of the 3 newest active works, the 5 newest unfinished episodes, and songs in lists then by plays up to about 150 minutes (at most 40). Audio is pinned in the audio cache (`pinAudio`), covers stored (`keepCovers`), kuromoji and the dictionary warmed.
   - Built when the toggle goes on; refreshed after start-up, on return to the app and on reconnect once it's over 6 hours old or another account's (not on cellular or Data Saver). New records land first and stale ones go last, so a failed refresh keeps the last pack. Cleared on toggle off and sign-out.
   - Loaders: `fetchProcessedArticleById`, `fetchWorkParts`, `fetchEpisode` and `fetchSong` read the pack first offline and fall back to it when the server fails (`offlineFirst`). `fetchReadyBufferArticles` returns the packed news offline, and `loadHub` skips the headline fetch and filters it by local read/dismissed marks.
   - Settings: オフライン after 表示, "Keep for offline" Off/On, status in the label's small text (size, `done / total` while saving, 再保存待ち when the OS cleared it). Mockup `docs/mockups/offline-pack.html` variant 1.
   - Open question 1 settled for now: only parts that already exist are packed, so packing never spends on generation.
5. **Offline UI states.** WordModal insight line, translation, create buttons, ハルカ, feed end state.
6. **Optional: pre-translated sentences.** One Haiku call per packed article returns all sentence translations together, cached with the article and capped server-side.

## Verifying it

- Desktop: Chrome DevTools → Network → Offline, and Playwright `context.setOffline(true)`. Script: build the pack, go offline, reload, read an article and tap words, grade 10 cards, play an episode and a song, go back online. Then check `user_word_progress`, the review logs and the positions on the server.
- Device: the installed PWA on an iPhone in real airplane mode, including a cold launch more than 1 h after the last online use, so the token has expired. Memory says device-only behaviour (PWA cache, localStorage quota) doesn't reproduce locally, so this step is required.

## Open questions

1. **Long-read parts that haven't been generated yet.** Should the pack ask the server to write the next 1–2 parts of each in-progress work? It costs a rewrite each, but a flight is exactly when you'd read ahead. My suggestion: yes, the next 2 parts of the single most recent work, under the existing caps.
2. **Pre-translated sentences** (phase 5): worth one Haiku call per article, or is offline reading fine without translation?
3. **Pack size defaults:** about 10 articles, 5 episodes and about 150 MB of songs. Or one "small / large" choice in the status line?
