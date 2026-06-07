# Implementation Plan — Client-Side Morphological Tokenization
Replace the LLM-based tokenization/furigana/JMDict-linking with a real dictionary-based analyzer (kuromoji.js) running in the browser. Fixes wrong furigana, wrong dictionary meanings, and missing JLPT levels in one move, and _removes_ two server passes.
## Licensing (cleared)
- **kuromoji.js** (atilika original) and **@sglkc/kuromoji** fork: **Apache-2.0** — commercial use fine.
  
- **IPADIC dictionary** (mecab-ipadic 2.7.0, bundled in the package): permissive **BSD-style license**, commercial use allowed, with one obligation — **retain the copyright notice crediting the Nara Institute of Science and Technology (NAIST)**.
  
- **Action:** add both notices to a `THIRD_PARTY_LICENSES` / `NOTICE` file (or an "Acknowledgements" line in Settings/About). No copyleft, no per-seat terms. Verified via `npm view` — confirm the exact IPADIC notice text from the package's `dict/` or upstream `COPYING` before shipping.
  
## Architecture: before → after
**Today** (all server-side, in `process-article`):

```
Gemini Pass 1 (rewrite → plain JP text)
  → Gemini Pass 2 (tokenize + furigana)        ← buggy, DELETE
  → Pass 3 (exact-surface JMDict link)         ← buggy, DELETE
  → store enriched content[] in processed_news
```

**Proposed** (server simplified, client enriches):

```
SERVER  Gemini Pass 1 only → store plain paragraph text in processed_news
CLIENT  on article open:
          kuromoji.tokenize(text)              → segments + lemma + reading
          merge inflections                    → display tokens (鎮めて, not 鎮)
          align okurigana                      → furiganaMap (鎮→しず)
          batch JMDict lookup by lemma         → jlptLevel + meaning + entryId
          render; cache enriched blocks back
USER    read / click / mastery → existing store sync → user_word_progress
```

Furigana (kana) comes **straight from kuromoji — no DB**. Only JLPT + meaning need the `jmdict` query the client already makes today.
## Server changes — `supabase/functions/process-article/index.ts`
1. **Delete Pass 2** (the `prompt2` "morphological analyzer" Gemini call, ~lines 354–374) and **Pass 3** (JMDict linking block, ~lines 376–417).
  
2. Change the stored shape so each paragraph keeps its **raw text** instead of a tokenized `content[]`:
  
  - `{ type: 'paragraph', text: '<full japanese string>' }`
    
  - yugen-box blocks unchanged (`keyword`/`reading`/`description` from Gemini stay — that path is reliable).
    
3. Net effect: one fewer Gemini call + no linking queries → faster, cheaper article prep. Keep the `responseMimeType: 'application/json'` Pass-1 contract.
  

> Old cached articles already have a Pass-2 `content[]`. The client auto-heals them (see Migration) by re-tokenizing from the joined text, so no backfill job is required.
## New client module — `src/services/tokenizer.ts`
Single responsibility: text → display tokens with furigana + lemma. No network except the one-time dict load.

- **Loader / singleton.** `kuromoji.builder({ dicPath }).build(cb)` wrapped in a memoized `getTokenizer(): Promise<Tokenizer>` so the dictionary builds once per session. Browser uses kuromoji's XHR+pako loader (works out of the box — no Deno fs problem).
  
- **Dictionary hosting.** Self-host the 12 `*.dat.gz` files (~18 MB) under `public/kuromoji-dict/` and set `dicPath: '/kuromoji-dict/'`. Served as static assets, HTTP- and service-worker-cached (PWA → effectively one download per device, offline after). Avoids a hard runtime dependency on jsdelivr.
  
- `tokenizeToDisplay(text): DisplayToken[]` with three steps:
  
  1. `tokenizer.tokenize(text)` → raw tokens (`surface_form`, `basic_form`, `reading`, `pos`).
    
  2. **Inflection merge** — fold trailing `助動詞` (ます/た/ない/れる/られる/せる/させる…) and conjunctive `助詞 て/で` into the preceding `動詞`/`形容詞` head, keeping the head's `basic_form` as the lemma. (Optionally also merge a following auxiliary verb after て — いる/しまう/くる — into one unit; make this a tunable flag.) Produces `鎮めて` as one token with lemma `鎮める`.
    
  3. **Okurigana alignment** → `furiganaMap`. Split the surface into alternating kanji-runs / kana-runs; anchor each kana-run inside the reading; assign each kanji-run the reading span between anchors. (Robust generalization of the spike's leading/trailing-kana stripper — also handles internal kana like 入(い)り口(ぐち).) Replaces the broken even-split heuristic.
    
- **Unknown-word fallback.** When `basic_form === '*'` or `reading === '*'` (proper nouns like ヴァンス): emit the token with **no furigana** and no lemma link. Katakana needs none anyway; an unknown kanji name simply renders bare. No LLM call in the hot path.
  
- `DisplayToken` shape maps 1:1 onto the existing `ArticleBlock.content[]` item (`src/services/api.ts:4`): `{ text, furigana?, jmdict_entry_id?, details? }` — so Reader rendering barely changes.
  
## JMDict enrichment — extend `src/services/jmdict.ts`
- Add `lookupLemmasBatch(lemmas: string[]): Promise<Map<string, JMDictResult>>`: one query over `jmdict_kanji`/`jmdict_kana` with `text IN (lemmas)`, then `fetchEntries` for the union. Reuses existing helpers; collapses N per-word lookups into one round-trip per article.
  
- **Disambiguation when a lemma has multiple entries:** rank by `common` desc → `freq_rank` asc → **POS match** against kuromoji's POS (verb/noun/adj), take the top. Reserve the existing `disambiguateWithLLM` (`jmdict.ts:112`, currently unused by the pipeline) for genuinely ambiguous high-value cases only.
  
- **JLPT fallback ladder** in `jmdictToWordDetails`: if the matched entry's `jlpt_level` is null, fall back to (a) max JLPT of its kanji via the existing `kanji_jlpt` table (`database/08_kanji_jlpt.sql`), else (b) a coarse bucket from `freq_rank`. Mark these as derived so the badge can read "≈N3" vs a tagged "N3" if you want the distinction.
  
- Keep the per-tap path (`fetchWordDefinitionQuick`, `api.ts:175`) but feed it the **lemma** the token already carries, not the surface string — so taps and the batch agree and conjugated forms stop falling through to Groq.
  
## Reader integration — `src/components/Reader.tsx`
- In `loadArticle` (line 68), after obtaining the article, run an async `enrichArticle(blocks)`: for each paragraph block, `tokenizeToDisplay(rawText)` → batch `lookupLemmasBatch` over all unique lemmas → attach `details`/`jmdict_entry_id`/`furigana` to each token → set `block.content`.
  
- **Render unchanged.** `renderParagraph` (line 325) already maps `content[]` with `furigana`/`details`/`jmdict_entry_id`. The `Intl.Segmenter` fallback branch (line 365) can stay as a safety net for any block that failed tokenization.
  
- **First-load UX:** if the tokenizer isn't ready yet, render the raw paragraph text immediately (no furigana, sentence-tap still works), then swap in enriched tokens when ready — a sub-second flash on the very first session only. Add a tiny "preparing readings…" state reusing the existing `loadingStep` pattern if desired.
  
- **Cache enriched blocks** via the existing `saveProcessedArticle` (line 102) so re-opens skip tokenization and the dict isn't even needed on subsequent views.
  
## Read-but-not-clicked sweep — `Reader.tsx:135` (`handleFinishArticle`)
Works as-is, and more accurately: because `enrichArticle` ran over the **whole** article, every token already carries a correct lemma + `jlptLevel`. The sweep keeps iterating all tokens with furigana, seeds never-seen words with their real entry, and applies the `'skip'` difficulty event with a correct JLPT level (it was frequently null before). No structural change — just better inputs.
## Migration / backward compatibility
- Articles cached before this change have a Pass-2 `content[]`. `enrichArticle` should **reconstruct raw text** as `block.text ?? block.content.map(t => t.text).join('')` and re-tokenize — auto-healing old articles with correct furigana/links on next open. No DB migration, no backfill (consistent with this repo's manual-migration norm).
  
- Gate with a `tokenizerVersion` stamp on the cached block so a future tokenizer/dict upgrade can invalidate and re-enrich.
  
## Rollout phases
1. **Phase 1 — tokenizer module + dict hosting.** Add `tokenizer.ts`, vendor dict into `public/kuromoji-dict/`, unit-check segmentation/lemma/furigana on a fixture set (incl. the `鎮めて` case and a few conjugations). No UI wiring yet.
  
2. **Phase 2 — client enrichment + Reader wiring.** `lookupLemmasBatch`, `enrichArticle`, render swap, first-load fallback. Verify the screenshot article end-to-end.
  
3. **Phase 3 — server simplification.** Delete Pass 2/3, switch stored shape to raw paragraph text. (Client already handles both shapes from Phase 2, so this is safe to ship after.)
  
4. **Phase 4 — disambiguation + JLPT fallback ladder + licenses/NOTICE.**
  
## Risks & mitigations
- **18 MB first-load.** Self-host + SW cache; render text-first, furigana-on-ready. One-time per device.
  
- **IPADIC proper-noun gaps.** Unknown kanji names render bare; acceptable, optional narrow LLM fallback later.
  
- **Inflection-merge edge cases** (compound auxiliaries, ～ておく/～ていく). Start with a conservative ruleset; tune against real articles. The `Intl.Segmenter` fallback covers any un-tokenized block.
  
- **Bundle weight of kuromoji JS** (the code, not the dict) — modest; lazy-import the module so it doesn't bloat initial app load.
  
## Decisions (resolved 2026-06-07)
1. **Dict hosting → self-host** under `public/kuromoji-dict/` (reliable, offline, no third-party runtime dependency). *[chosen]*
  
2. **Enrichment caching → persist back to `processed_news`.** Heals the stored article for every device/session and makes re-opens instant (dict not needed on subsequent views). *[best judgment]*
  
3. **JLPT fallback → show derived levels, visibly marked** (`≈N3` from kanji `kanji_jlpt` / freq rank vs. a clean `N3` for a real JMDict tag). Better signal than blank, honest about the source. *[best judgment]*
  
4. **Inflection merge → inflectional suffixes + て-form only** (`鎮めて`); auxiliary verbs stay separate, so `鎮めている` = `鎮めて` + `いる` and the `〜ている` grammar stays independently tappable. Auxiliary-merge kept as a tunable flag, off by default. *[best judgment]*

---
comments:
  c1:
    body: Do self host. For all other decisions use your best judgement
    by: user
    at: 2026-06-07T17:48:39.256Z
