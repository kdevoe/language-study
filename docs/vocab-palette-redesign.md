# Vocabulary Palette Redesign — Input-Side Difficulty Control
**Status:** Approved — implementing **Goal:** Stop articles from being littered with above-level words by fixing what vocabulary we feed the LLM _before_ generation — not by filtering after.

## Decisions (open questions resolved)

1. **Counts** — 8 topics + 8 actions, ≤3 synonyms each.
2. **Universal glue seed** — none; trust the model at-level, keep the existing thin-palette fallback text.
3. **Variety** — offer ≤3 synonyms/concept + "vary your choice" instruction; **defer** cross-article rotation (add only if still samey).
4. **Difficulty contract** — "simpler beats precise" made explicit, subordinate to the facts golden rule.
5. **Scope** — ship nets + clusters + prompt together, then run the eval harness before done. The RPC change lands as a manual migration file.

## Implementation notes (as built)

- **No SQL migration.** Instead of a new cluster-returning RPC, the pipeline calls the *existing* `jmdict_vocab_candidates` once per concept (parallel `Promise.all`), which keeps each synonym cluster grouped. Zero DB changes to apply by hand; the whole-word-match tweak is deferred (mitigation #2, not core).
- **Additive prompt.** `RewriteInput.clusters?` is optional. Present → new DIFFICULTY CEILING + concept-cluster block; absent → the legacy flat palette renders byte-for-byte, so the eval harness's frozen fixtures stay a valid baseline (verified via `--print-prompt`).
- **Cluster contents.** Per concept: keep only `known` (backbone) + `new` (at/below-level) words, easiest-first (`compareKnown` then `compareByProximity`), cap 4, deduped across clusters. `review` (hard/medium) words are excluded from clusters — the topic-independent SRS floor still surfaces them for reinforcement.
- **Files:** `_shared/rewritePrompt.ts` (clusters field + block), `process-article/index.ts` (two-net `extractConceptsWithGroq` + cluster builder), `scripts/eval-article-rewrite.mjs` (clusters passthrough).
- **Not yet run:** the paid eval harness (real Gemini calls) and a live regenerate for this user — both need a deploy + API budget; awaiting the go-ahead.

* * *
## The problem
Generated articles use vocabulary well above the reader's level (e.g. 導入する, 監視, 罰金, 特定する, 取り締まる in an N3 article), forcing constant lookups. That defeats the app's core promise.

The cause is **input-side**, not the model being disobedient:

1. **JLPT level is prose, not a lexicon.** The prompt tells Gemini "the reader understands everyday Japanese" (`rewritePrompt.ts:50`). There's no word list to anchor to.
  
2. **The vocab palette is topic-noun-shaped and thin.** Groq extracts ~12 _English topic nouns_; those are substring-matched against JMDict English glosses (`database/22_vocab_candidates_stretch.sql:45-48`). A Japanese word only surfaces if its gloss contains the exact keyword string.
  
3. **The words that actually make news hard are verbs/abstract nouns** — 導入する, 特定する, 取り締まる, 引き起こす — which Groq is explicitly told _not_ to extract ("concrete nouns and topic terms preferred", `process-article/index.ts:133`). They're never candidates, so the model is never told an easier way to say them.
  
4. **The known-word backbone is topic-gated**, so the general connective vocabulary the reader actually knows (使う, 続ける, 場所, 出す) is invisible to the palette. When the backbone comes back thin, the prompt falls back to "(rely on natural N-level vocabulary)" (`rewritePrompt.ts:104`) — pure guessing.
  
5. **Zero post-generation validation** (`const processedBlocks = rawBlocks`, `process-article/index.ts:416`) — out of scope here by choice; we're fixing the input.
  
## What we are NOT doing
- No post-generation filtering, tokenizing, or regeneration passes.
  
- No new dataset (no WordNet import) in the first cut. English-synonym expansion is done by the LLM in-context.
  
- No static global top-N backbone list (rejected — see "Variety" below).
  

* * *
## Core insight: two nets, one mechanism
A readable article needs two kinds of non-topic vocabulary, and both should be **derived from the article itself** and **filtered to words the reader knows**:

| Net | What it captures | Example (fireworks/drone article) |
| --- | --- | --- |
| **Topic net** (exists today) | Concrete nouns of the story | ドローン, 花火, 消防局 |
| **Action/relation net** (new) | Verbs, adjectives, abstract nouns describing what _happens_ | 導入する, 監視する, 撮影する, 特定する, 引き起こす, 警告する, 広がる |

The action/relation net is the missing "filler that fits this particular article." It varies story to story (a flood article yields different verbs), so it never makes articles sound alike.

**One mechanism serves both nets: the concept cluster.**

```
English keyword/action
  → in-context English synonyms (LLM)
  → gloss-match each → Japanese candidates
  → filter to words the reader knows, rank by ease
  → labeled cluster handed to the LLM
```

Example clusters:

```
«identify / locate»    → 特定する · 見つける · わかる
«crack down / stop»    → 取り締まる · 止める · 捕まえる
«surveillance / watch» → 監視 · 見張り
```

The cluster does **double duty**:

- **Difficulty downgrade** — the model picks the easiest member the reader knows.
  
- **Variety** — offering 2–3 known synonyms per concept (and rotating which leads across articles) means recurring news actions ("said," "announced") don't always resolve to the identical Japanese word.
  

* * *
## Why English-synonym expansion (not Japanese-side)
We have **no thesaurus data** — JMDict here stores only `gloss` (English) + POS (`database/06_jmdict_schema.sql:31-39`). Deriving synonyms Japanese-side means noisy gloss-overlap self-joins. Expanding on the **English** side is cleaner:

- English synonym generation is something the LLM is genuinely reliable at (unlike Japanese level judgments).
  
- It's a **recall booster on the existing gloss match**: 監視's gloss is "surveillance," but 見張り's is "watch / lookout" — same concept, no string overlap, so 見張り never surfaces today. Expanding "surveillance → {monitoring, watching, oversight}" pulls the whole cluster.
  
- **Near drop-in**: `extractKeywordsWithGroq` already runs on the source in-context. We extend that one call; the `jmdict_vocab_candidates` RPC is unchanged.
  
### Polysemy mitigation
English is ambiguous and we're compounding it ("fine" → 罰金 but also 元気/細かい; "watch" → 見張り but also 時計). Three cheap guards:

1. **Expand in context** — Groq already sees the sentence; ask for sense-appropriate synonyms ("fine" as _penalty_). Kills most of it.
  
2. **Whole-word gloss match** instead of substring (`%fine%` currently hits "define/confine").
  
3. **Labeled clusters + existing freq/JLPT ranking** — a bad synonym only pollutes its own cluster, and frequency ranking sinks the junk.
  
### Honest limit
Sometimes the whole cluster is above level (罰金 · 反則金 · 過料 are all hard). When no easy synonym exists, the concept is just hard — the right answer is an inline gloss (yugen-box), which the prompt already supports. We keep that as the fallback, not a word swap.

* * *
## Proposed pipeline changes
### 1. Widen keyword extraction → two nets + synonyms
Change `extractKeywordsWithGroq` (`process-article/index.ts:132-161`) to return, in one call and in-context:

```jsonc
{
  "topics":  [{ "concept": "surveillance", "synonyms": ["monitoring", "watching", "oversight"] }, ...],
  "actions": [{ "concept": "identify",     "synonyms": ["locate", "pinpoint"] }, ...]
}
```

- `topics` = concrete nouns (today's behavior).
  
- `actions` = verbs / adjectives / abstract nouns describing the events (new net).
  
- Each concept carries 2–3 sense-appropriate English synonyms.
  

**Open question:** target counts — e.g. ~10 topics + ~10 actions, ~3 synonyms each? (See "Sizing" below.)
### 2. Candidate query → group by concept
Flatten `{concept + synonyms}` into gloss patterns, run the existing RPC, but **keep the concept grouping** instead of flattening into one bag (today: `process-article/index.ts:277-300`). Each concept becomes a cluster of Japanese candidates.

Also: switch the RPC's gloss match from substring `ILIKE ANY` to whole-word matching.
### 3. Bucket + known-filter per cluster
Reuse `classifyBucket` / `wordPriority.ts` per cluster. Within each cluster, rank by ease-for-this-reader (confirmed-known → below-level → frequency). Drop clusters that end up empty after the known-filter, or mark them "needs gloss."
### 4. Prompt: hand over labeled clusters + a difficulty contract
Replace the flat palette block (`rewritePrompt.ts:102-107`) with concept clusters:

```
VOCABULARY GUIDANCE — prefer the reader's known words for each concept:
- «identify»:   特定する / 見つける / わかる
- «crack down»: 取り締まる / 止める / 捕まえる
- «surveillance»: 監視 / 見張り
Vary your choice across the article; do not reuse the same synonym every time.
```

And strengthen the difficulty contract (currently "guide, not quota" + "facts override everything", `rewritePrompt.ts:107,120`):

> Do not use vocabulary above N{level}. When a precise term is above level, use a simpler everyday phrasing from the clusters above, or gloss it once in a yugen-box. **Simpler wording beats precise wording.** (Facts still override style — never distort the story to hit a word.)
### 5. Variety / rotation
Across a reader's articles, rotate which cluster member is listed first (or shuffle the 2–3 offered) so recurring concepts don't always resolve identically. Deterministic seed per (article, concept) so it's reproducible.

* * *
## Sizing (replaces the "15–20 is too small" problem)
Old palette was thin because it was `{topic-keyword-matched} ∩ {known}`. New sizing:

- **Topics:** ~10 concepts × cluster of up to ~4 known Japanese = richer topic pool.
  
- **Actions:** ~10 concepts × cluster of up to ~4 known Japanese = the new per-article filler layer.
  
- Function-word glue (する/いる/ある/こと…) is left to the model at-level — it repeats in all real text and needs no palette.
  

**Open question:** do we still want a small universal "safe verbs/adjectives at N-level" seed for when both nets come back thin, or is the LLM-at-level fallback enough?

* * *
## What this fixes
| Root cause | Fix |
| --- | --- |
| Thin, topic-noun-only palette | Second (action/relation) net |
| Hard concepts, no easier alternative offered | English-synonym → Japanese clusters, easiest-known surfaced |
| Same backbone → articles sound alike | Backbone is article-derived + cluster rotation |
| Soft "guide not quota" contract | Explicit N-level ceiling + "simpler beats precise" + gloss fallback |
## Live-check findings (2026-07-13, real Groq + real JMDict, N3)

Eval A/B (same fireworks article, hand-curated clusters vs legacy thin palette):
**jlptFit 2/5 → 5/5**, fidelity + naturalness stayed 5/5. Judge on legacy: *"advanced Sino-Japanese (事案, 科される, 犠牲者, 継続) → closer to N2."* Judge on clusters: *"perfectly targeted for N3, with helpful glosses."* → the mechanism works.

But running the REAL cluster query (not hand-curated) exposed quality gaps the eval couldn't:

1. **Polysemy leaks through, incl. the concept word itself.** «fine» (penalty) → 大丈夫 / 結構 / 立派 (the "fine = good" sense). We match the concept word AND its synonyms as `%substring%` against glosses, so the wrong sense slips in. Needs whole-word match + POS filter (a monetary fine is a noun; drop verb/adj matches).
2. **Proper-noun topics are noise.** «California» → 意味 / 1月 / 右; «Sacramento» → 電気 / 石. Entities have no JMDict equivalent — the topic net should skip proper nouns (the ACTION net carried the real value: «warning» → 注意(N4)/警告(N3), «filming» → 記録(N3), «publishing» → 発表(N3)).
3. **The `jlpt_level IS NOT NULL` gate removes the BEST easy synonyms.** «monitoring» surfaced only 監視(N1)/追跡(N1) — 見張り (the easy downgrade we wanted) is untagged, so the RPC drops it, leaving the cluster with *only hard words*. This deferred item is more load-bearing than expected: without an untagged-word fallback, many concepts can't be downgraded at all.
4. **Recall gaps.** «pinpointing» → 特定(N2) only; 見つける missed because its gloss is "to find", not "locate/identify".

Net: the difficulty ceiling + good action-net clusters help (matching the eval), but topic-noun noise and the tag gate dilute it. The LLM shrugs off obviously-wrong suggestions (it won't say 大丈夫 for a fine), so the deployed version is not worse — but it's below the eval's ceiling until the noise filters land.

### Recommended follow-up pass (turns the eval's 5/5 into the real-pipeline result)
- **Concept↔SRS strong-matching phase (#103) — do this first.** Reverse-query the reader's `user_word_progress` per concept (gloss ⋈ synonym set) so the article prefers words the reader is actually studying, ranked due-first (reinforce, glossed) then mastered-first (backbone). This is the *principled* version of the untagged-word fallback below — the reader's SRS is the authority on "known", not JLPT tags — and it bypasses the tag gate (finding #3) while closing the reader⇄flashcard loop (#71/#72). Synonyms are load-bearing here: they raise the concept↔SRS hit rate (見張り matches «watch», not «surveillance»).
- **Whole-word gloss match** + **POS filter** (match action concepts to verb/adj entries, topic to nouns) — kills polysemy junk.
- **Untagged-word fallback** — when a concept's tagged candidates are all above level, allow common untagged entries (by `freq_rank`/`is_common`) so 見張り-type downgrades survive even for concepts the reader hasn't studied. (RPC change → manual migration. Largely subsumed by #103 for studied words.)
- **Skip proper-noun topic concepts** — ask Groq to flag entities, or drop concepts whose candidates are all low-frequency noise.
- **Commonness floor** on cluster members so easy-but-irrelevant junk (何, 意味) can't be promoted by the known-filter.

## Deferred (not in first cut)
- WordNet / real thesaurus import (upgrade to cluster recall if English-synonym coverage proves thin).
  
- Any post-generation validation.
  
- Eval-harness updates to measure per-cluster known-coverage.
  

* * *
## Questions for review
1. **Extraction counts** — ~10 topics + ~10 actions, ~3 synonyms each? Too many / too few?
  
2. **Universal glue seed** — keep a tiny always-on safe-word set, or trust the model at-level?
  
3. **Variety** — is per-article rotation worth the complexity, or is the natural per-story variation of the action net enough on its own?
  
4. **Difficulty contract wording** — comfortable making "simpler beats precise" an explicit rule, given the existing "facts override everything" golden rule?
  
5. **Scope of first cut** — ship nets + clusters + prompt together, or land the action-net extraction first and measure before the prompt rewrite?

---
comments:
  c1:
    body: use your best judgement on the questions. overall this looks good
    by: user
    at: 2026-07-13T00:09:35.321Z
  c2:
    body: "Resolved all five in the new Decisions section: 8+8 concepts / ≤3 synonyms, no glue seed, variety via multi-synonym + vary-instruction (rotation deferred), explicit simpler-beats-precise, ship together + eval-harness gate. Implementing now."
    by: AI
    at: 2026-07-13T00:12:00.000Z
    re: c1
