# Article-rewrite eval fixtures (golden set)

Each `eval-*.json` is one **golden case** for the `process-article` rewrite eval
harness (`scripts/eval-article-rewrite.mjs`, issue #65). A fixture freezes
everything the rewrite depends on — the English **source**, the reader
**profile**, and a **frozen vocabulary palette** — so the only variable the
harness measures is the *prompt + model*. The harness makes **no Supabase/Groq
calls**; the palette is supplied here rather than computed live, which keeps runs
reproducible.

## Schema

```jsonc
{
  "id": "EVAL-001",                     // stable id; matches docs/phase-c-eval-notes.md
  "note": "why this case exists",       // optional, human-only
  "source": {
    "title": "English headline",        // -> prompt `Topic:`
    "text": "English article body...",  // -> prompt `Sources:` block (the frozen sourceText)
    "sources": []                        // reserved; harness uses `text` directly
  },
  "profile": {                          // stand-in for user_preferences
    "jlptLevel": 4,                     // 1-5 (drives complexity)
    "rtkLevel": 300,                    // studied Heisig kanji count (drives kanji palette)
    "studyMode": "balanced",           // natural | balanced | study
    "vocabMode": "balanced",           // natural | balanced | study
    "readingIntensity": "balanced",    // leisure | balanced | intensive (known/review/new ratios)
    "targetParagraphs": 4              // article length
  },
  "palette": {                          // the frozen known/review/new lists (surface forms)
    "known": ["世界", "未来"],
    "review": ["人工知能", "経済"],
    "new": ["支配"],
    "targetReview": 2,                 // ~how many review words the prompt asks to weave in
    "targetNew": 1
  },
  "assertions": {
    "mustNotContain": ["インターネットである"]  // regexes/strings that must NOT appear in output
  }
}
```

## Scoring (what the harness measures per fixture)

- **Deterministic** (no API): JSON validity, markup cleanliness (no `[]`/`()`),
  paragraph count vs `targetParagraphs`, ≥1 yugen-box, palette adherence
  (kuromoji-tokenized hit counts vs the frozen lists), and `mustNotContain`
  regression assertions.
- **LLM judge** (Gemini 3.1 Pro, configurable): factual fidelity, JLPT
  appropriateness, naturalness — each 1–5.

## Adding a case

When you spot a bad rewrite in the app:

1. Add a row to `docs/phase-c-eval-notes.md` (the running failure log).
2. Copy an existing fixture, give it the next `EVAL-00N` id, paste the real
   source + profile, and encode the failure as a `mustNotContain` assertion.
3. Re-run `node scripts/eval-article-rewrite.mjs --fixture EVAL-00N` and confirm
   current output fails (red), then that a fix makes it pass (green).

The set is intentionally small and **growable** — start with these, grow toward
~15–20 real cases as failures surface.
