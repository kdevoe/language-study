# Long-Form Content — Shared Design for BYOC (#38) and Magazines (#58)
Status: **approved 2026-08-08** — review complete, all open questions resolved (§9). Ready for implementation, starting with Phase A (§8).

Both issues run full-length external content (a pasted blog post, a Guardian feature) through the same personalization pipeline. Their cross-comments already agree the long-form foundation should be designed once. This doc is that design: the content model, the chunking pipeline, the long-form reading interface, and the selector interface. The news path is untouched.

Interactive mockups accompany this doc:

- `docs/mockups/longform-reader.html` — the long-form reading interface (chrome-free like today's Reader; invisible resume via pre-scroll, section breaks, JIT part preparation)
  
- `docs/mockups/longform-library.html` — the selector interface (書庫 Library tab: filter pills + one flat news-feed-style card list, + button import sheet)
  

* * *
## 1. Content model: works and parts
A **work** is one long-form piece (imported blog post, magazine feature, book passage). A work is split into **parts**; each part is processed independently through the same pipeline as a news article, but longer — about 10 output paragraphs (§3).

**Key decision: each part is a regular** `processed_news` **row.** The Reader, on-demand fetching, article caching, word tracking, and SRS wiring all work on parts with zero changes — a part _is_ an article. Grouping lives in new columns:

```sql
-- new table: the source of truth for a long-form piece
create table long_form_works (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null,
  title text not null,
  source_type text not null check (source_type in ('import', 'magazine')),
  origin_url text,                -- null for pasted text
  raw_text text not null,         -- the unchunked original (needed for JIT part processing)
  char_count int not null,
  part_count int not null,
  continuity jsonb default '{}',  -- rolling summary + proper-noun map (see §4)
  reading_position jsonb,         -- { part_index, block_index } (see §5)
  status text not null default 'active',  -- active | finished | archived
  created_at timestamptz default now()
);

-- new columns on processed_news
alter table processed_news add column source_type text not null default 'news';
alter table processed_news add column work_id uuid references long_form_works;
alter table processed_news add column part_index int;
```

The JIT news buffer adds `where source_type = 'news'` to its count query, so works never consume the news buffer cap. RLS mirrors the existing per-user policies. The Feed query likewise filters to `news` — long-form lives in the Library (§6), not the swipe feed.

Anything at or under 10,000 chars is a **single-part work** — same model, `part_count = 1`, no chunking. This makes short BYOC (an email, lyrics, most blog posts) trivially cheap and lets Phase A ship before chunking exists.
## 2. Ingestion paths
| Path | Phase | Mechanism |
| --- | --- | --- |
| Paste text | A   | Raw text straight into `long_form_works` |
| URL | B   | Existing Jina `extractFullText` path in `process-article`, then same as paste |
| Magazines | C   | New `fetch-magazines` source function: Guardian Open Platform (`show-fields=body`), full-text RSS (MIT TR, Ars) with teaser items filtered out — writes works with `source_type = 'magazine'` |

Input guards: reject under 300 chars (that is a dictionary lookup, not an article), soft warning at 20,000, hard cap 40,000 chars per import (about 4 parts). File upload (.txt/.md/PDF) and Japanese-input graded-reader mode stay out of scope, as issue #38 proposed.
## 3. Chunking
Split the raw source at **paragraph boundaries** into parts targeting 8,000 to 10,000 source chars. That is deliberately _above_ the news path's `TOTAL_SOURCE_CHAR_CAP = 7000` — long-form gets its own raised cap so parts come out long (see length profile below), and the raised cap + prompt variant are validated together through the eval harness. Never split mid-paragraph; if the source has headings, prefer starting parts at headings. This is deterministic string work in the edge function, not an LLM call.

**Processing is lazy.** Part 1 is processed eagerly on import (the user waits once, exactly like tapping an unprepared feed card today). Part N+1 is JIT-processed when the reader passes roughly 60% of part N — the same pattern as the existing feed pre-processor. An abandoned work stops costing anything. A failed part gets `status = failed` and a retry affordance in the reader (the buffer already models this state).

**Length profile (decided in review 2026-08-08):** the news prompt compresses to about 3 paragraphs; that is wrong for content the user chose. Long-form parts target **about 10 output paragraphs** with a fidelity-leaning prompt variant ("adapt, don't summarize"). The point of long parts is that section breaks stay _rare_ — a break should feel like a chapter break, not an interruption of the reading experience. This variant must go through `scripts/eval-article-rewrite.mjs` before shipping, per the standing rule that the eval harness is the rewrite yardstick.
## 4. Continuity across parts
Independent part generations would drift: a person's name rendered three different ways, tone shifting between parts. Each work carries a `continuity` object, updated after each part is generated and injected into the next part's prompt:

```jsonc
{
  "summary_ja": "前の部の2〜3文の日本語要約",          // so part N+1 can open coherently
  "proper_nouns": { "OpenAI": "オープンAI", "Sam Altman": "サム・アルトマン" },
  "style_note": "です/ます調、科学記事のトーン"
}
```

Cheap (a few hundred tokens), and it is the difference between "a series" and "five unrelated articles."
## 5. The long-form reading interface
_(mockup:_ `longform-reader.html`_)_

**Decided in review (2026-08-08): the reading page looks exactly like today's Reader — everything but the text disappears.** No sticky header, no progress bar, no mode toggles. Continuous scroll only; paged mode is dropped. All long-form structure lives _inside the text flow_:

- **Structure:** work → parts → blocks. A part opens with today's exact chrome: the small meta chip row (source + a quiet 第2部 / 全5部 indicator, where category + read time sit today), the large serif title, the 40px hairline. Then pure text.
  
- **Resume is invisible:** `reading_position` (part_index + block_index) persists to the work row on scroll (debounced) and via the existing preference sync. Reopening a work opens **pre-scrolled to the saved position** — the first unread block sits mid-screen so a little of the already-read text shows above for context. No marker, no chrome. The Library shows percent complete per work; no in-page progress bar.
  
- **Section break** at the end of a part, replacing the 完了 capsule: a quiet 第2部・完 line with overall percent, the words-met recap (the SRS data already supports this — the #116 finish card generalizes here), then the next part's title with a 続きを読む button in the existing finish-button style. If the next part isn't ready, the existing spinner treatment. Part N+1 prepares JIT while reading (§3).
  
- Everything inside a part is the existing Reader: furigana modes, word lookup, sentence translation, grammar boxes, mastery controls — unchanged, because a part is an article.
  
## 6. The selector interface: the Library
_(mockup:_ `longform-library.html`_)_

The swipe feed is built for disposable news triage; long-form is a **persistent collection you return to**. Different mental model, different surface — the user's second point.

**Decided in review (2026-08-08): keep it uncluttered — header + filter tabs + one long flat list, in the same card language as the news feed.** No shelves or sub-sections.

- **New bottom-nav tab: 書庫 (Library)** — home for all long-form. The news Feed is untouched. This also answers #58's "new tab" question: magazines are a filter in the Library, not their own tab.
  
- **One flat list** below the filter pills (すべて / インポート / 雑誌), cards styled exactly like today's news cards: uppercase source tag, serif title, status in the corner (READY / preparing spinner / 第3部・全4部). In-progress works sort to the top and carry a thin progress line along the card's bottom edge. Tapping resumes at the reading position.
  
- **Import entry point:** a single + button opening an import sheet — Paste / URL tabs, live character count with a part estimate ("約12,400字 → 全3部"), and a note that part 1 prepares now and the rest prepare while reading. This is the whole BYOC UI.
  
- **Magazines (Phase C)** appear in the same list under the 雑誌 filter with the existing FULL TEXT badge; a feature only processes when the user opens it.
  
- **Persistence:** works are a library, not a feed — no swipe-to-dismiss. Explicit archive/delete (long-press or in-card, TBD). Finished works stay re-readable.
  
## 7. Cost and guards
- One part costs somewhat more than one article today (bigger source window, about 10 output paragraphs vs 3), but a max-size 40k import is only about 4 generations, strictly user-triggered and lazily processed. #127's token logging gives the real per-part number in week one.
  
- Daily guard: 3 imports or 15 parts per user per day (server-side, in the edge function). #127's token logging gives real production numbers to tune this after launch.
  
- Testing without polluting SRS: do the minimal slice of #6 — a dev-mode "sandbox" flag that skips word-progress writes — before Phase B testing.
  
## 8. Rollout
| Phase | Scope | Ships |
| --- | --- | --- |
| **A** | Schema (§1) + paste-only BYOC capped at 10,000 chars (single-part works) + Library tab with imports list + import sheet | BYOC value immediately, no chunking risk |
| **B** | Chunking + continuity (§3–4), multi-part reader with section breaks, resume, JIT parts, URL import, long-form prompt variant through the eval harness | The real long-form experience |
| **C** | `fetch-magazines` sourcing + Magazines section in the Library (#58); close #11 as absorbed | Content breadth without new UX |
## 9. Resolved questions (all decided 2026-08-08)
1. **Paged mode — dropped.** The reading page mirrors today's Reader; continuous scroll only, everything but the text disappears.
  
2. **Level drift — accepted.** If the user's JLPT/vocab level changes mid-work, later parts generate at the new level; it reflects real progress. Earlier parts regenerate only on explicit re-import. No mid-work regeneration logic.
  
3. **Retention — keep indefinitely.** Works are just rows; no auto-archive. The `status = 'archived'` state exists for explicit user archiving only. Revisit only if storage becomes a real concern.
  
4. **Magazine raw caching — yes, per user.** A magazine feature's raw fetched text is stored in `long_form_works.raw_text` at the moment the user opens it, same as an import. No shared cross-user cache in v1 (processed output is personalized per user anyway).

## 10. Implementation pointers (for the Phase A session)
- **DB migrations are applied manually** in the Supabase dashboard — add a numbered file under `database/` (next number after the existing 00-26 sequence); merging a PR deploys frontend only.
- **Edge functions**: `supabase/functions/process-article/index.ts` already accepts `{ userId, articleId, title, snippet, sources }` — Phase A is a new input path, not an engine change. Deploy via `supabase functions deploy process-article`.
- **Frontend entry points**: `processArticleOnDemand` in `src/services/api.ts`; tab routing lives in `App.tsx`; bottom nav in `src/components/BottomNav.tsx`; Zustand store in `src/services/store.ts` (mind the localStorage bounds from #54).
- **Prompt changes** (Phase B length profile) go through `scripts/eval-article-rewrite.mjs` before shipping; the prompt lives in `supabase/functions/_shared/rewritePrompt.ts`.
- **Styling**: match the mockups — they use only existing CSS variables from `src/index.css` and the news-card/Reader idioms. No new UI frameworks.
- **Testing**: use `VITE_DEV_MODE=true`; before Phase B, add the #6 sandbox flag so long-form testing doesn't pollute real SRS state.

---
comments:
  c1:
    body: Go with all you suggestions on the open questions
    by: user
    at: 2026-08-08T23:36:51.755Z
  c2:
    body: Done — all four resolved as recommended in §9 (paged mode dropped, level drift accepted, indefinite retention, per-user raw caching). Doc marked approved and §10 implementation pointers added for the fresh-context Phase A session.
    by: AI
    at: "2026-08-08T23:45:00.000Z"
    re: c1
