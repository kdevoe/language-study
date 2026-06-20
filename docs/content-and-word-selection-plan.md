# Content Quality & Word-Selection Plan

**Theme:** Improve (1) article content quality and (2) word-level tracking → how it drives vocab selection for the rewrite LLM.

**How to use this doc:** Steps are ordered. Each has a goal, the issue it closes, the files it touches, and an acceptance check. Work top-to-bottom; the early steps are deliberately cheap and unblock the later ones. Check boxes as we land each.

**Legend:** 🟢 cheap / high-leverage · 🟡 medium · 🔴 large

**📍 You are here (2026-06-19):** Tier 0 + Tier 1 fully landed (#49, #57, plus off-plan #61 article-length and #62 buffer re-rank — all merged & deployed). **Next up: Step 2 (#25)**, the keystone of the Tier 2 palette refactor.

---

## Tier 0 — Land what's already built

### Step 0 — Deploy #49 (source-fullness tracking) 🟢 — ✅ DONE
The work on this branch (`becf1be`) is done; it's the measurement instrument for all content-quality work below.

- [x] Apply `database/20_source_fullness.sql` in the Supabase SQL editor. *(user applied)*
- [x] `supabase functions deploy process-article`. *(deployed)*
- [x] Merge the frontend for the FULL TEXT badge. *(PR #59 merged; auto-closed #49)*
- [x] Close/repoint **#18** (topic-clustering) — closed as superseded by `clusterArticles` + #49.

**Acceptance:** the reporting query in #49 returns a `source_kind` breakdown over recent articles; FULL TEXT badge appears on full-text cards.

---

## Tier 1 — Cheap wins, both themes

### Step 1 — #57: Raise the 800-char teaser cap 🟢 *(content quality)* — ✅ DONE (PR #60 merged, both fns deployed)
Full-text feeds (Ars ships whole bodies in `content:encoded`) are truncated to 800 chars and misclassified `partial`; this also blocks the "prefer full-text" strategy.

- [x] Split the cap by path in `fetch-raw-news`: `FULLTEXT_BODY_CAP = 2500` for `content:encoded`/Atom `content`, `TEASER_CAP = 800` for `description`-only (Jina backfills).
- [x] Trim card preview to `PREVIEW_CHARS = 400` (body rides in `sources[].teaser`) so persisted `articlesCache` doesn't bloat (#54).
- [x] `process-article`: classify `full` for full-text feeds, not just Jina — `buildSourceBlock` tracks `fullBody` (Jina success **or** teaser ≥ `FULL_SOURCE_CHARS`).

**Acceptance:** with #49 deployed, Ars (and other full-text feeds) move `partial → full` in the `source_kind` breakdown; `avg_chars` rises. No extra Jina latency.
**Verify (needs ~1 day of new articles):** re-run the #49 reporting query and confirm Ars rows show `full` with higher `avg_chars`.

**Shipped alongside (off-plan, same full-text thread):**
- ✅ **Source-fullness-driven article length** (PR #61, deployed) — paragraphs follow fullness (defaults 5/4/3), JLPT drives complexity, vocab budget scales with length. Configurable in Settings → Article Length. Migration `database/21`.
- ✅ **Buffer re-rank by richness** (PR #62, merged & deployed) — `fetch-raw-news` orders cards full → partial → snippet (round-robined by outlet) so the buffer prefers full-text. Closes the #49 "prioritize full-text" follow-up.

---

## Tier 2 — Word-selection palette refactor (one coherent series)

> #25, #22, #51 all rewrite the `process-article` palette construction (`index.ts:191-253`). Build them as a series around a shared `priorityScore(word, user)` function, not three disconnected PRs. Order matters: #25 widens the data select that #51 depends on.

### Step 2 — #25: Prefer confirmed-familiar over assumed-from-level words 🟡 *(keystone)*
Verified-easy words (you've interacted, `mastery='easy'`) should anchor the KNOWN backbone ahead of never-seen below-level guesses. Currently both collapse into one frequency-sorted bucket capped at 30.

- [ ] Widen the server-side `user_word_progress` select to include numeric `difficulty` and `times_seen` (not just `mastery_level`). **This same widened select is the prerequisite for Step 4 (#51).**
- [ ] Rank confirmed-familiar ahead of assumed-from-level in the backbone; frequency becomes only a tiebreaker.
- [ ] Decide fetch-server-side (cheap, widen existing query) vs pass-from-client — prefer server-side.

**Files:** `supabase/functions/process-article/index.ts:185,192-213`.
**Acceptance:** a word the user confirmed easy is no longer pushed out of the 30-word backbone by a common below-level word they've never seen.

### Step 3 — #22: Prioritize unknown vocab by JLPT proximity 🟡
Replace hard `>`/`===`/`<` bucketing with a distance score so stretch words one level up actually surface.

- [ ] Introduce `priority ∝ -abs(word_jlpt - user_jlpt)` with a mild upward tilt (slightly-harder favored over much-easier).
- [ ] Widen `jmdict_vocab_candidates` RPC (`database/10_reading_intensity.sql`) so it no longer filters out words 1–2 levels harder than the user — the proximity ranker needs them available.
- [ ] Handle `NULL` jlpt_level explicitly (lowest priority).

**Decisions to confirm:** asymmetry tilt; reach cap (+1 only, or +2 with steep falloff); how `mastery` interacts with proximity; NULL = lowest vs excluded.
**Files:** `process-article/index.ts:191-215`, `database/10_reading_intensity.sql`, `database/07_jmdict_jlpt.sql`.
**Acceptance (N4 user):** an unknown N3 word ranks above an unknown N2 word; an unknown N4 word ranks near the top; N5 words don't crowd out at-level words.

### Step 4 — #51: Topic-independent review slot 🟡 *(best reinforcement ROI)*
Review is topic-keyed, so ~36% of mature words never recur (topic lottery). Reserve 1–2 of the ~8 review slots for the most-stuck words regardless of article topic. **No new SRS engine needed** — generalize the existing freq-ranked fallback.

- [ ] Always blend a topic-independent slice into `reviewPalette` (currently the fallback at `index.ts:234-253` runs only when the topic-keyed pool is empty).
- [ ] Pick a simple staleness score from the now-available fields (oldest `last_seen_at`, highest `difficulty`, lowest `times_seen`).
- [ ] Decide whether the rewrite prompt should distinguish "topic-relevant" vs "forced" review words (prose naturalness tradeoff).

**Files:** `process-article/index.ts:203-220,234-253`.
**Acceptance:** stuck/orphaned hard-medium words resurface in new articles even when the article topic is unrelated; the day-one-only orphan rate drops.

---

## Tier 3 — Tracking integrity (the data feeding Tier 2)

> **Shipped 2026-06-19 (cheap interim, from the Progress-page アメリカ/こども investigation):**
> - **Seed no longer "assumes hard"** — `seedDifficulty` null-JLPT default 9 → neutral 6 (`store.ts`). Frequency already feeds seeding via `derivedJlpt` upstream, so a null means *no signal*, not "hard".
> - **No grading off un-enriched tokens** — `gradeWordByKey` (`Reader.tsx`) defers until a word is dictionary-linked, killing the race that seeded read-past words to Hard with no entry id.
> - **Re-seed migration (persist v4)** repairs already-corrupted passively-graded "Hard" rows.
> Remaining deeper work folded into #39 (canonical entry-id keying) and #41 (hydrate remote-only/orphaned rows) — see comments on each.

### Step 5 — #39: Unify entry resolution (displayed vs stored JLPT) 🔴
Pass 3 stores the *first* matching entry_id with no disambiguation, so mastery can accrue against the **wrong word** for homographs, and the client's smart kanji-first + LLM disambiguation never reaches the server.

- [ ] **Cheap interim first:** stop the fast-path override — when a server-linked entry has `jlpt_level IS NULL` or multiple candidates, fall through to `lookupWord`/disambiguation instead of trusting blindly; prefer the `common` entry on ties. (`api.ts:180-184`)
- [ ] **Full fix:** extract the client's "kanji-first + common-flag + disambiguation" into shared logic; use it in Pass 3 (it has full-sentence context). Fixes both displayed-vs-stored mismatch and client-improvements-not-reaching-server.
- [ ] Align NULL-JLPT handling between client ("hard") and server palette ("ignored").
- [ ] Persist the resolved entry_id + jlpt onto the saved token so badge / SRS seed / palette all read one entry.

**Files:** `api.ts` (`fetchWordDefinitionQuick`), `jmdict.ts` (`lookupWord`, `disambiguateWithLLM`, `fetchEntries`), `store.ts` (`seedDifficulty`), `WordModal.tsx`, `Reader.tsx`, `process-article/index.ts` (Pass 3), `database/07`, `database/10`.
**Acceptance:** a homograph shows the same correct N-badge across articles and tracks mastery against one consistent entry_id.

### Step 6 — #41: Sync gap — remote progress doesn't hydrate locally 🟡
Progress page reads local Zustand `wordDatabase`, which diverges from the server ("547 rows show as 1 N2 word").

- [ ] **Option B (quick win, do first):** add a query/RPC joining `user_word_progress` → `jmdict_entries.jlpt_level`, return counts per (jlpt_level × mastery_level); render those in `Progress.tsx` instead of deriving from `wordDatabase`.
- [ ] **Option A (correctness across devices, follow-up):** on sync, resolve `{surface, reading, jlpt_level}` for every remote `word_id` via `fetchEntries`, create/refresh local entries, replace strict last-write-wins with per-field reconcile.
- [ ] Minor: seed the ~82 `difficulty = NULL` graded rows from bucket midpoints.

**Files:** `store.ts` (`syncSrsWithSupabase`), `api.ts` (`fetchUserWordProgress`), `jmdict.ts` (`fetchEntries`), `Progress.tsx`.
**Acceptance:** a cleared-storage device shows full tracked vocabulary after sync; JLPT grouping matches JMDict tags.

### Step 7 — #37: JMDict sense miss (手当て → "salary") 🟢
Self-contained lookup-quality bug; slot in anytime.

- [ ] Prefer the entry whose kanji form exactly matches the surface (手当て over 手当) before fallback.
- [ ] Consider surfacing top-N glosses across senses, or context-disambiguating the sense (reuse the dictionary-lookup edge fn like the heteronym `type:'readings'` mode).

**Files:** `src/services/jmdict.ts` (`lookupLemmasBatch`, `pickBestEntry`).
**Acceptance:** tapping 手当て in a medical context shows treatment/first-aid, not "salary; pay; compensation".

---

## Tier 4 — Larger bets (after Tier 1 proven)

- **#58 Magazines tab** 🔴 — biggest content-quality lever (full-length MIT TR / Guardian-API bodies). Depends on #57. Multi-PR: new tab, long-form reader with resume, separate sourcing/storage/prompt. Great near-term *theme* once Tier 1 lands.
- **#43 Grammar DB + recognition** 🔴 — high value, adjacent to word tracking (same kuromoji pass, same SRS). Large standalone build; natural "next big thing."
- Later: #8 (FSRS engine), #38 (BYOC), #54 (localStorage bounding), #6/#7/#9/#10/#11/#12.

---

## TL;DR sequence
**#49 (deploy) → #57 → #25 → #22 → #51 → #39 → #41 (Opt B) → #37**, then #58 / #43.

Front-loads two cheap content wins, delivers word-selection as one coherent palette refactor, then shores up the tracking-integrity layer those selections depend on.
