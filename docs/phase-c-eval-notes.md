# Phase C — Article-rewrite eval notes

Running log of **concrete rewrite failures** observed in real `process-article` output, to
seed the eval harness (#65) and guard the prompt restructure (#66). Each case should
become a regression check: feed the source + profile, assert the failure does **not**
recur.

Part of the **Word Mastery Loop** plan — see [`word-mastery-loop-plan.md`](./word-mastery-loop-plan.md) Phase C.

**How to use:** when you spot a bad rewrite in the app, add a case below. When #65's harness
exists, port these into its golden set. When #66 edits the prompt, every change is measured
against these (no blind prompt edits).

**Severity:** 🔴 grammatically wrong / misleading to a learner · 🟡 unnatural but understandable · 🔵 nitpick.

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
"a certain future" reading must be preserved.

---

<!-- Add new cases above this line. Next id: EVAL-002. -->
