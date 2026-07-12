# #68 — Word Intake Queue + Daily New-Word Limit: Design Doc
**Phase D, second half.** Gate words into the FSRS schedule instead of grading every word on sight. Today the app immediately seeds `difficulty` + an FSRS schedule the first time it sees any dictionary-linked word (#67), which floods a new/returning user with hundreds of "active" words at once. #68 adds a **foundation-first intake queue**: words _wait_ (unscheduled) until a **daily new-word cap** promotes them — lowest JLPT level first, most-common-in-normal-text first. The queue draws from **two sources**: words the user has bumped into while reading, **and** important common words at/below their level they haven't read yet (so the foundation gets built even when articles skip it).

> **Status:** ✅ decisions resolved (D1–D3, 2026-07-12) — ready to build.
> 
> **Depends on:** #67 (FSRS engine, ✅ shipped). Reuses `compareIntake` (already built in `_shared/wordPriority.ts:214` as the promotion comparator hook for this issue), `seedSrsFromDifficulty` / `schedule` from `src/services/srs.ts`, and the `get_unseen_common_words` RPC (`database/14`).
> 
> **Blocks:** #70 (deck reads _active_ words only), #72 (review palette pulls _active_ due words).

* * *
## 1. What exists today (grounded baseline)
- **Every dictionary-linked word is graded on sight.** In `Reader.tsx`, a read-past (`gradeWordByKey`, ~L102) fires `recordWordSeen(key, true)` then `applyDifficultyEvent(key, 'skip')`; a lookup fires `applyDifficultyEvent(key, 'click')`. There is **no gate** — first contact immediately seeds `difficulty` (`seedDifficulty`) _and_, post-#67, a full FSRS schedule (`seedSrsFromDifficulty` → `schedule`). `store.ts:419` (`applyDifficultyEvent`) is the exact choke point.
  
- `recordWordSeen` **(**`store.ts:365`**)** already records exposure only (`timesSeen++`, `lastSeenTs`, `streak`) and does **not** grade — it's the behavior we want _queued_ words to have.
  
- `user_word_progress` carries `mastery_level`, `difficulty` (1–10), `times_seen`, `streak`, `last_seen_at`, plus the #67 schedule columns (`stability`, `due_at`, `srs_status`, …). `srs_status` is the FSRS _card lifecycle_ (`new/learning/review/relearning`) — **orthogonal** to intake status; #68 needs its own `queued`/`active` concept.
  
- **#67 already treats "unscheduled" as "belongs in #68's queue."** `database/23_fsrs_scheduling.sql:16` and `srs.ts` both comment that `stability IS NULL` / `difficulty IS NULL` = _not yet on a schedule → #68's intake gate_. So the schema already anticipates this split.
  
- `compareIntake` **exists and is unused** (`wordPriority.ts:214`) — foundation-first order: easiest JLPT level first (higher number), then lowest `freq_rank`. Built in #67 explicitly "Ready for #68's daily-promotion job; not yet wired to a caller."
  
- **An "unseen important words" source already exists** — `get_unseen_common_words(p_level, p_seen_words, p_limit)` (`database/13`, perf-rewritten in `database/14`) returns the most common words at an exact JLPT level the user has **not** encountered, ordered by `freq_rank`. Called today from `Progress.tsx` via `jmdict.ts:497`. This is the natural feed for the "important words not yet read" half of the queue (D1). _Caveat: it returns `(word, reading, rank, meaning)` only — no `entry_id`/`jlpt_level` — and excludes by surface form (stale post-#39). §3 adds a purpose-built sibling that returns `entry_id` and excludes by canonical id._
  
- `freq_rank` **is reachable client-side** — `jmdict.ts:109` already reads `entry.freq_rank` into enrichment (`freqRank`), but it is **not** stored on `WordData`. Foundation-first ordering of _encountered_ words needs it, so we carry it onto the record (small enrich-time add).
  
- **Daily client passes are an established pattern** — `checkDailyKanji` (`store.ts:780`) gates on `lastRtkUpdateTs > 86400000` and is invoked from `App.tsx:337` on mount. A promotion pass mirrors this exactly.
  
- **Preferences pattern** — `readingIntensity` / `targetParagraphs` show the full loop: a `user_preferences` column (`09_user_preferences.sql`), `fetch/upsertUserPreferences` (`api.ts:630/644`), a store field + setter that fires `upsertUserPreferences`, and a Settings control. The daily cap follows this pattern verbatim.
  
- **Server palette** (`process-article`) builds three buckets via `classifyBucket` (`wordPriority.ts:159`): the **review** floor query (`index.ts:320`) filters `mastery_level IN ('hard','medium')`; the **new** bucket surfaces at/near-level words _never tracked_. Queued words (ungraded, `mastery='unseen'`) are already naturally excluded from **review** — the only server change needed is making that exclusion explicit and safe.
  

* * *
## 2. Design — decisions (RESOLVED 2026-07-12)
### ✅ D1 — Promotion runs **client-side on-open**, and the queue has **two sources**
**Resolved: client-side on-open pass** (mirroring `checkDailyKanji`), **and** the queue is fed by both words-read AND important-unread words (per c1).

- **Why client-side:** foundation-first ordering needs only JLPT level + `freq_rank`, both available client-side (`freqRank` at enrich time; the unseen-words RPC returns it). It ships without new cron/edge infra, is consistent with #67's browser-side choice and `checkDailyKanji`, and the promotion logic stays a pure, testable function.
  
- **Two queue sources (c1 — "important words the user hasn't seen in reading must still enter the queue"):**
  1. **Encountered-queued** — words bumped into while reading; stored locally as `intakeStatus='queued'` rows (exposure recorded, no schedule).
  2. **Unseen-foundation** — important common words at/below the user's level they've **never** read, sourced on demand from the unseen-words RPC (§3), ordered level↑ then freq↑. **Virtual** — not stored until promoted, so we never materialise a huge backlog; JMDict _is_ the ordered source.
  
  The daily pass **merges both**, orders by `compareIntake`, and promotes the top `cap`. So even if articles never surface a common N5 word, the foundation pull feeds it in — the queue is a real "what to learn next" curriculum, not just "what I happened to read."
  
- **Cross-device:** two devices could promote different sets on the same day. Resolved as all SRS state is — LWW sync (`syncSrsWithSupabase`) reconciles the schedule fields, and a per-day stamp (`lastIntakePromotionTs`, like `lastRtkUpdateTs`) makes the pass idempotent per device. Worst case: a rare, self-healing over-promotion, not data loss.
  
- **Server-side alternative** (a cron promotion job): stronger cross-device story, but needs a new scheduled function + RLS-safe service-role queries and can't promote an all-day-offline device until it next syncs. **Deferred** — revisit only if promotion races prove real in practice.
  

> {>>D1: OK to go client-side on-open pass (recommended)
> 
> Although one thing to consider. We still want important words that the user hasn't seen in reading to make it into the queue somehow<<}{id="c1" by="user" at="2026-07-12T01:37:41.381Z"}
> 
> {==Resolved above (@c1)==}{>>Good catch — a real gap. The queue now has a second **unseen-foundation** source drawn from the existing `get_unseen_common_words` RPC (level↑/freq↑), merged with encountered words at promotion time, so common at/below-level words feed in even if no article surfaces them. Stays client-side per your approval — the pass just makes one RPC call, like `process-article` already does.<<}{#r1}
### ✅ D2 — Migration: **grandfather** all currently-scheduled words as `active`
**Resolved (c2): grandfather.** The queue starts empty of existing words; only words encountered / pulled _after_ #68 flow through the gate.

- **Why:** yanking live schedules off hundreds of words a user is studying is destructive and confusing, and hard to reverse. Grandfathering is safe, non-destructive, and still delivers the core win — _new_ intake is paced from now on. The v6→v7 persist migration + the SQL backfill stamp `intakeStatus='active'` on every row with a schedule/grade, `'queued'` on any ungraded row.
  
- **Retroactive-queue** (move the un-established long tail back to `queued`) stays an explicit, opt-in follow-up ("Reset study pacing"), never a silent migration.
  

> {>>D2: Grandfather existing words as active (recommended, non-destructive)<<}{id="c2" by="user" at="2026-07-12T01:37:41.381Z"}
### ✅ D3 — Daily cap **starts at 3/day**; **no lookup fast-track**
**Resolved (c3, c4).**

- **Default cap = 3/day** (c3), configurable 0–50 in Settings (0 = pause new words). Small and gentle to start; the user can raise it.
  
- **No fast-track on lookup (c4).** A lookup on a `queued` word signals only "I don't recognise this," _not_ intent to learn it — so a `click` on a queued word records exposure and **leaves it queued**. Queued words leave the queue **only** via the daily cap. (While queued, `skip` and `click` are both exposure-only; the "didn't know it" signal is moot until the word is scheduled.)
  
- **One deliberate exception — explicit manual mastery-set.** If the user opens the modal and _explicitly_ classifies a queued word (easy/medium/hard via `setWordMastery`), that's a direct declaration of knowledge, not a passive signal — it promotes + applies. Distinct from a lookup, and rare. {==Manual-set is the one remaining non-cap promotion path==}{>>Say the word if you'd rather a manual set ALSO just record without scheduling until the cap promotes it — I lean toward respecting the explicit classification.<<}{#r2}
  

> {>>D3a: Start with just 3<<}{id="c3" by="user" at="2026-07-12T01:37:41.381Z"}
> 
> {>>D3b: do not let lookups bypass the fasttrack. All a user is signaling with a lookup is that they don't know it, not that they are looking to learn it.<<}{id="c4" by="user" at="2026-07-12T01:37:41.381Z"}

* * *
## 3. Schema
New migration `database/24_intake_queue.sql`:

```sql
-- 24. Word intake queue (#68). Gate words into the FSRS schedule (#67) instead of
-- grading every word on sight. `intake_status` is ORTHOGONAL to `srs_status` (the
-- FSRS card lifecycle): a word is `queued` (waiting, no schedule) until the daily
-- cap promotes it to `active` (scheduled). Applied by hand (project convention).
alter table public.user_word_progress
  add column if not exists intake_status text
    check (intake_status is null or intake_status in ('queued','active')),
  add column if not exists promoted_at timestamptz;   -- when it entered active study

-- Backfill (D2 — grandfather): every row with a schedule/grade is active; ungraded → queued.
update public.user_word_progress
  set intake_status = case when stability is not null or difficulty is not null
                           then 'active' else 'queued' end
  where intake_status is null;

create index if not exists idx_uwp_intake
  on public.user_word_progress(user_id, intake_status);

-- Daily new-word cap preference (D3 — starts at 3).
alter table public.user_preferences
  add column if not exists new_words_per_day smallint default 3
    check (new_words_per_day between 0 and 50);

-- Unseen-foundation candidates for the intake pull (D1, source #2). Like
-- get_unseen_common_words (database/14) but (a) scans the user's level AND all easier
-- levels in ONE call, foundation-first (jlpt_level DESC = easiest first, then freq_rank
-- ASC), (b) excludes by canonical entry_id (correct post-#39, vs the older surface-form
-- exclusion), and (c) returns entry_id + jlpt_level so a promoted word is canonically
-- keyed and orderable by compareIntake. Same perf shape as database/14: order+limit on
-- jmdict_entries first, LATERAL/scalar subqueries for display only.
create or replace function public.get_intake_candidates(
  p_user_jlpt smallint,
  p_seen_ids  text[] default '{}',
  p_limit     integer default 50
)
returns table (entry_id text, jlpt_level smallint, freq_rank integer,
               word text, reading text, meaning text)
language sql stable as $$
  with ranked as (
    select e.id, e.jlpt_level, e.freq_rank, e.common
    from public.jmdict_entries e
    where e.jlpt_level >= p_user_jlpt        -- user's level and EASIER (higher number)
      and not (e.id = any(p_seen_ids))       -- exclude already-tracked, by entry_id (#39)
    order by e.jlpt_level desc, e.freq_rank asc nulls last, e.common desc, e.id asc
    limit p_limit
  )
  select r.id, r.jlpt_level, r.freq_rank::integer,
         coalesce((select k.text from public.jmdict_kanji k where k.entry_id = r.id order by k.id limit 1),
                  (select a.text from public.jmdict_kana  a where a.entry_id = r.id order by a.id limit 1)) as word,
         (select a.text from public.jmdict_kana a where a.entry_id = r.id order by a.id limit 1) as reading,
         (select array_to_string(s.gloss, '; ') from public.jmdict_senses s where s.entry_id = r.id order by s.id limit 1) as meaning
  from ranked r
  order by r.jlpt_level desc, r.freq_rank asc nulls last, r.common desc, r.id asc;
$$;
grant execute on function public.get_intake_candidates(smallint, text[], integer) to anon, authenticated;
```

> Applied by hand in Supabase. `intake_status` is orthogonal to #67's `srs_status`.

* * *
## 4. Client changes
### 4a. `WordData` + persist v6 → v7 (`store.ts`)
- Add `freqRank?: number | null` (populated at enrich time from `jmdict.ts` — needed for `compareIntake`), `intakeStatus?: 'queued' | 'active'`, `promotedTs?: number | null`.
  
- **v7 migration** (mirrors the D2 SQL): stamp `intakeStatus='active'` on any word with a schedule (`stability != null`) or a grade (`difficulty != null`); everything else `'queued'`. No schedules touched.
  
- Bump `version: 6` → `7`.
  
### 4b. Intake gate in the grading path (`store.ts`)
The core behavior change. First contact no longer seeds a schedule.

- **New / queued word** encountered → ensure a record exists with `intakeStatus='queued'`, record exposure via the existing `recordWordSeen` machinery (`timesSeen`/recency/streak). **No** `seedDifficulty`**, no FSRS** `schedule()` — `difficulty` and `stability` stay null (so `classifyBucket` keeps treating it as discoverable-new, and it's excluded from review).
  
- `applyDifficultyEvent` gains an early guard: **if the word is** `queued`**, it does not grade or schedule** — `skip` and `click` alike only record exposure (D3b: a lookup does _not_ promote). If the word is `active`, it behaves exactly as today (difficulty nudge + FSRS advance).
  
- **Manual mastery-set exception (D3, `#r2`):** `setWordMastery` on a queued word promotes it first (`promoteWord(key)` → `active` + seeded schedule via `seedSrsFromDifficulty`, stamp `promotedTs`), then applies the explicit grade. Lookups never do this.
  
### 4c. `promoteIntakeQueue(now)` store action + daily trigger
- New action, gated on `lastIntakePromotionTs > 86_400_000` (mirrors `checkDailyKanji`), invoked from `App.tsx:337` alongside it. Async (it makes one RPC call).
  
- **Build the merged candidate set:**
  1. Local `intakeStatus==='queued'` words → `WordSignal[]` (carry `entryId`, `jlptLevel`, `freqRank`).
  2. `get_intake_candidates(userJlpt, seenEntryIds, cap + buffer)` → unseen-foundation `WordSignal[]` (virtual; `seenEntryIds` = every tracked entry id, so nothing double-counts).
  
- **Order + slice:** merge, sort by `compareIntake` (level↑ then freq↑), take the top `new_words_per_day`. _(Optional tiebreak at equal level+freq: prefer higher `timesSeen` so a word the user has actually met edges out a never-seen one — a small local comparator layered on the shared one.)_
  
- **Promote each:** set `intakeStatus='active'`, `promotedTs=now`, seed via `seedSrsFromDifficulty(seedDifficulty(jlpt, userLevel), now)`. For a virtual unseen word, first materialise its `WordData` (entry_id key per #39, from the RPC's word/reading/meaning + level + freqRank, `timesSeen: 0`). Upsert the row — promotion is an initial schedule, **not** a review, so no `srs_review_log` write.
  
- Stamp `lastIntakePromotionTs=now`.
  
### 4d. Daily cap preference (follow the `readingIntensity` pattern exactly)
- Store: `newWordsPerDay: number` (default 3) + `setNewWordsPerDay(n)` setter firing `upsertUserPreferences({ new_words_per_day: n })`; hydrate in `syncSrsWithSupabase` from `remotePrefs.new_words_per_day`.
  
- `api.ts`: map `new_words_per_day` in `fetchUserPreferences` / `upsertUserPreferences`.
  
- `Settings.tsx`: a stepper (0–50) near the reading-intensity section — "New words per day", defaulting to 3.
  
### 4e. Sync (`api.ts` / `jmdict.ts`)
- Extend `upsertWordProgressToSupabase` / `…Batch` payloads + `fetchUserWordProgress` mapping with `intake_status` ↔ `intakeStatus` and `promoted_at` ↔ `promotedTs`. Pagination unchanged.
  
- Add a thin `fetchIntakeCandidates(userJlpt, seenIds, limit)` wrapper around the `get_intake_candidates` RPC (mirrors the existing `get_unseen_common_words` wrapper in `jmdict.ts:510`).
  

* * *
## 5. Server changes (`process-article`) — minimal
The acceptance "the deck/LLM never see a word before promotion" is _mostly already satisfied_: queued words are ungraded (`mastery='unseen'`), so they never enter the **review** floor and never rank as **known**. One explicit guard:

- **Review floor query** (`index.ts:320`): add `intake_status = 'active'` (or `is null` for legacy safety) so a queued word can never be pulled as a review target.
  
- **New bucket:** leave as-is. Re-surfacing a queued (or unseen-foundation) word as a discovery ("new") word in an article is _good_ — it drives the exposure that reading contributes — and it never grants active scheduling. (Optional later: dedupe against the queue; deferred.)
  

_(The flashcard deck (#70) and due-word feed (#72) don't exist yet; they'll read_ `intake_status='active'` _from day one — this design just guarantees the column is there and correct.)_

* * *
## 6. Acceptance criteria + verification
| Criterion (from the issue) | Verification |
| --- | --- |
| New words enter active study only at the daily cap | Read an article with >cap new words → after the daily pass, exactly `cap` new `active` words; the rest stay `queued`. |
| Promotion is lowest-level-most-frequent first | Unit-test `promoteIntakeQueue` fixture: N5-common promotes before N5-rare before N4 before N3. |
| Important **unread** words still enter the queue (c1) | With an empty local queue, the daily pass still promotes `cap` unseen-foundation words from `get_intake_candidates`, lowest-level-most-common first. |
| The LLM never sees a word before promotion | Queued word never appears in the review palette (server query filters `intake_status='active'`); confirmed via a process-article dry-run. |
| Backlog waits in a visible, ordered queue | Encountered-queued words persist with exposure counts; the unseen-foundation preview is queryable (surfaced in #73's dashboard later). |
| Reading a queued word records exposure but starts no interval | Read-past OR lookup a queued word → `timesSeen++`, `lastSeenTs` bumped, but `stability`/`due_at` stay null, no `srs_review_log` row, still `queued` (D3b). |
| Existing schedules preserved (D2) | v7 migration + SQL backfill leave every already-scheduled word `active` with its schedule intact. |

**Tests:** `promoteIntakeQueue` (with an injected candidate-fetch stub) and the intake gate are pure over `(wordDatabase, candidates, now, cap)` → a standalone `scripts/` runner in the spirit of `test-srs.mjs`: foundation-first ordering across both sources, cap respected, queued-word read/lookup = exposure-only (no promotion, D3b), manual-set promotes.

* * *
## 7. Build order
1. `database/24_intake_queue.sql` — columns + backfill + index + `new_words_per_day` + `get_intake_candidates` RPC (authored; applied by hand).
  
2. `wordPriority.ts` — no change (`compareIntake` exists); add a `WordData → WordSignal` mapper if not already present.
  
3. `store.ts` — `WordData` fields, persist v7, the intake gate in `applyDifficultyEvent`, `promoteWord`, async `promoteIntakeQueue` (merges local queue + RPC candidates), `newWordsPerDay` + setter.
  
4. `api.ts` / `jmdict.ts` — extend upsert/fetch payloads (`intake_status`, `promoted_at`, `new_words_per_day`) + `fetchIntakeCandidates` wrapper.
  
5. `App.tsx` — `await promoteIntakeQueue` alongside `checkDailyKanji`.
  
6. `Settings.tsx` — "New words per day" control (default 3).
  
7. `process-article` — `intake_status='active'` guard on the review query.
  
8. Standalone `scripts/` test runner; browser-test the encounter/pull → queue → daily-promote → schedule loop end to end.
  

* * *
## 8. Out of scope (explicit handoffs)
- **Flashcard deck reading the active/due set** → #70.
  
- **Feeding _due_ active words into article generation** (rewiring `compareStuck` → `compareByDue`) → #72.
  
- **Queue-health dashboard** (queued/active/due counts, daily-goal, unseen-foundation preview) → #73.
  
- **Retroactive queueing of the existing long tail** (D2 alternative) → optional opt-in follow-up, not this PR.
  

* * *

---
comments:
  c1:
    by: user
    at: "2026-07-12T01:37:41.381Z"
  c2:
    by: user
    at: "2026-07-12T01:37:41.381Z"
  c3:
    by: user
    at: "2026-07-12T01:37:41.381Z"
  c4:
    by: user
    at: "2026-07-12T01:37:41.381Z"
  r1:
    body: "Resolved D1's gap — added an unseen-foundation queue source (get_unseen_common_words / new get_intake_candidates), merged at promotion time. Stays client-side."
    by: AI
    at: "2026-07-12T02:00:00.000Z"
    re: c1
  r2:
    body: "D3b applied — no lookup fast-track. Manual mastery-set flagged as the one remaining non-cap promotion path; open to gating it by the cap too if preferred."
    by: AI
    at: "2026-07-12T02:00:00.000Z"
    re: c4
</content>
