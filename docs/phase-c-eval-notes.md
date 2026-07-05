# Phase C — Article-rewrite eval notes

Running log of **concrete rewrite failures** observed in real `process-article` output, to
seed the eval harness (#65) and guard the prompt restructure (#66). Each case should
become a regression check: feed the source + profile, assert the failure does **not**
recur.

Part of the **Word Mastery Loop** plan — see [`word-mastery-loop-plan.md`](./word-mastery-loop-plan.md) Phase C.

**How to use:** when you spot a bad rewrite in the app, add a case below, then port it into
the harness golden set (`scripts/eval-fixtures/`, one JSON per case — schema in that folder's
README). When #66 edits the prompt, every change is measured against these (no blind prompt edits).

**Severity:** 🔴 grammatically wrong / misleading to a learner · 🟡 unnatural but understandable · 🔵 nitpick.

---

## The eval harness (#65)

`scripts/eval-article-rewrite.mjs` scores the Pass-1 rewrite on the frozen golden set in
`scripts/eval-fixtures/` and prints a per-model scorecard. It builds the prompt with the SAME
shared module the edge function ships (`supabase/functions/_shared/rewritePrompt.ts`, extracted
so the harness tests the exact prompt production sends), and **freezes the palette per fixture**
so the only variable measured is *prompt + model* — no Supabase/Groq calls.

**Scored axes:** deterministic (JSON validity, markup cleanliness, paragraph count, ≥1 yugen-box,
palette adherence via kuromoji, `mustNotContain` regressions like EVAL-001) + an LLM judge
(Gemini 3.1 Pro, configurable) for factual fidelity, JLPT-appropriateness, naturalness — plus
cost + latency.

```bash
node scripts/eval-article-rewrite.mjs --print-prompt EVAL-001   # offline: print the built prompt, no API key
node scripts/eval-article-rewrite.mjs --list-models            # print the model ids your key can call
node scripts/eval-article-rewrite.mjs --fixture EVAL-001        # one case (needs GEMINI_API_KEY)
node scripts/eval-article-rewrite.mjs --models flash,pro        # the flash-vs-pro scorecard
node scripts/eval-article-rewrite.mjs --judge off              # deterministic scores only
```

Requires `GEMINI_API_KEY` (or `VITE_GEMINI_API_KEY`); makes real paid Gemini calls. Reports land
in `scripts/eval-reports/` (git-ignored).

### Model landscape (July 2026)

The flash-vs-pro decision (decision #2, 2026-06-20) is now answerable with numbers. Ids below
are **confirmed via `--list-models`** against the project key (July 2026):

| Alias      | Model id                  | Notes                                              | Price /1M (in/out) |
|------------|---------------------------|----------------------------------------------------|--------------------|
| `flash`    | `gemini-3.5-flash`        | GA, stable — **current pin**                       | $1.50 / $9         |
| `pro`      | `gemini-3.1-pro-preview`  | newest Pro tier the key exposes — flash-vs-pro target | ~$4 / ~$20 (est.) |
| `pro-3`    | `gemini-3-pro-preview`    | prior 3.x Pro                                      | ~$4 / ~$20 (est.)  |
| `pro-2.5`  | `gemini-2.5-pro`          | GA 2.5 Pro                                          | $1.25 / $10        |
| `flash-lite`| `gemini-3.1-flash-lite`  | cheapest tier                                      | ~$0.30 / ~$2.50 (est.) |

There is **no `gemini-3.1-pro` or `gemini-3.5-pro` id** — the 3.1 Pro ships only as
`-preview`, and a 3.5 Pro was never released. So the real flash-vs-pro target is
`gemini-3.1-pro-preview` (also the default judge). Aliases/prices live at the top of the harness
(`--list-models` refreshes them); "est." prices lack a confirmed public row — verify before
quoting. Groq tasks (keyword extraction, clustering) stay on Groq — out of scope here.

### Flash-vs-pro verdict (2026-07-05) → **stay on `gemini-3.5-flash`**

First full-coverage run (7 fixtures, judge = `gemini-3.1-pro-preview`, 7/7 judged both):

| Axis                              | `gemini-3.5-flash` | `gemini-3.1-pro-preview` |
|-----------------------------------|:------------------:|:------------------------:|
| JSON valid / markup / paras / assertions | 100%        | 100%                     |
| factual fidelity (1–5)            | **4.00**           | 3.57                     |
| JLPT fit (1–5)                    | 5.00               | 5.00                     |
| naturalness (1–5)                 | **4.86**           | 4.57                     |
| latency (avg)                     | **11.3 s**         | 20.4 s                   |
| cost / article                    | **$0.0039**        | $0.0085                  |

**flash ties or beats pro on every axis, at ~half the latency and ~46% the cost.** pro is a
*thinking* model (~2.7k thought tokens/call); on this tight schema-and-palette rewrite the
overhead buys nothing and its freer prose slightly *lowers* fidelity. The judge is pro grading
both, and it scored *itself* below flash — so no self-serving bias inflates the flash win.
Decision #2 is settled: keep `gemini-3.5-flash` (`_shared/models.ts`) as the pinned rewrite
model; revisit only if a future model beats this scorecard. flash's fidelity 4.00 (not 5.00) is
the headroom #66 targets.

---

## EVAL-001 — `で + ある` (rentaikei) fused into the copula `である` 🔴

- **Observed:** 2026-06-21 · model `gemini-3.5-flash` · profile N4
- **Source/topic:** speculative think-piece about a 2031 world where the US and China
  dominate AI and Europe falls behind (European workers offload clerical work to "Claude").

**Output (first sentence):**
> 今週、インターネット**である**未来の話が話題になっています。

**Problem:** the intended parse is `インターネットで、ある未来の話` — "on the internet, a story
about *a certain* future." The model fused the location particle `で` with the
noun-modifying `ある` (rentaikei, "a certain") into the copula `である` ("is"), so the
sentence now reads *"a story about the future, which **is** the internet."* Grammatically
wrong and actively misleading to a learner trusting the grammar.

**Expected:** `今週、インターネットで、ある未来の話が話題になっています。`
(or `インターネット上で、ある未来の話が…`).

**Rule to enforce (#66):** never let the noun-modifying `ある` ("a certain ~") collapse
into the copula `である`. When `で` is a location/means particle, keep it separate from a
following `ある`. Watch the general failure mode of **merging two grammatical tokens into a
homographic third** (で+ある → である; に+ある, と+ある, etc.).

**Eval assertion (#65):** the rewrite must not contain `インターネットである` (or, more
generally, `<place/means noun>である<noun>` where the source meant "a certain"); the
"a certain future" reading must be preserved. **Implemented** as
`scripts/eval-fixtures/eval-001-ai-europe.json` (`mustNotContain: ["インターネットである"]`).

---

<!-- Add new FAILURE cases above this line. Next id: EVAL-008.
     (EVAL-002–007 are baseline fixtures spanning N5–N2 in scripts/eval-fixtures/,
     not observed failures, so they aren't logged here.) -->
