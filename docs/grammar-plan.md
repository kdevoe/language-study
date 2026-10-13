# Grammar plan (#43)
Status: draft for review, 2026-10-12 (revised: matches the real reader; tap model added). Mockup: `docs/mockups/grammar.html`.
## Goal
Make grammar a first-class thing to learn, the way words are now. Vocabulary has a full loop: spotted in what you read, looked up, tracked, reviewed, and fed back into the article rewrite. Grammar today is one AI-written sentence per tapped word (`fetchWordGrammarInsight`), with nothing tracked. The aim is the same loop for grammar points: **see it in the text → understand it → review it → meet it again in new articles.**
## What the reader sees
See the mockup for all four screens. It matches the reader as it is today:

- plain serif text with no furigana on the page (a long press peeks the reading)
  
- tap a piece to open the bottom panel (WordModal) with EASY / MEDIUM / HARD
  
- tap 。 to open the sentence translation
  
### The tap problem
The tokenizer already cuts every sentence into tap targets, and grammar points don't line up with them. 〜なければならない spans three taps and starts inside a word:

```
住む | 前 | に | 直さ[なけれ] | [ば] | [なりません] | 。
住み | [始め][て] | [います]        ← 〜始める and 〜ている overlap inside 始めて
```

So grammar can't have its own tap target without re-cutting words, and two targets would fight over the same few millimetres. The mockup weighs four options:

| Option | Verdict |
| --- | --- |
| **A · The tap decides.** One tap, one panel; what you tapped decides what leads | **Yes** |
| **B · The sentence lists it.** The 。 sheet lists every point in the sentence | **Yes, with A** |
| C · Separate underlined grammar targets (the first mockup) | No: doesn't fit the real token cuts |
| D · A 文法 lens toggle in the reader header | Maybe later, if A feels crowded |
### A + B in detail
1. **A word leads with the word.** A tap on a content word (直さなけれ, 住み, 寒い) opens the word panel as now. Its AI insight stays as it is, relabelled from GRAMMAR INSIGHT to **INSIGHT**: it explains the word in context, and the grammar now has its own place in the PATTERNS rows. (The grammar panel keeps GRAMMAR INSIGHT, because there it is about the point.) Below the insight, in the same box, a PATTERNS list shows the catalogue points the word takes part in, one row each (pattern, level, meaning). A row opens the point, and ‹ goes back to the word. **The panel opens taller when there's grammar.** Today WordModal sizes to its content up to 52% of the screen (`getDynamicMaxHeight`). When the word has PATTERNS rows, or a grammar point is open, that cap rises to about 70%, so the insight and the rows show without scrolling. A plain word opens at the usual height. The collision rule still applies: the panel never covers the tapped word, so near the edge of the screen it gets whatever room is left.
  
2. **A grammar piece leads with the grammar.** A tap on a piece that is only grammar (ば, なりません, ので, ながら, います, そう, です) opens the point first. The rule: a piece leads with grammar when it has no content word, or when the whole piece sits inside the point (前 in 〜前に, できる in 〜ことができる). If the piece is also a dictionary word (なりません is なる), a quiet "As a word: なる ›" link sits at the bottom.
  
3. **The whole point lights up.** While a point is open, its full span gets a soft band in the text, across token boundaries, so you see what it covers.
  
4. **The grammar panel** shows:
  

- the pattern, its JLPT level and a one-line meaning
  
- the same EASY / MEDIUM / HARD slider as words
  
- an AI GRAMMAR INSIGHT about the point in this sentence (see 7); it leads
  
- how it's built (slots like 動詞 ない形)
  
- this sentence, with the point marked and translated
  
- a usage note, two examples, and the SEEN / STREAK / RANK row
  

5. **The sentence sheet (。)** keeps the translation and adds "GRAMMAR · n IN THIS SENTENCE" rows below it. It's the sure way to reach a point whose pieces are small or awkward to hit.
  
6. **Marks only on a first meeting.** The page stays plain. Taps don't depend on marks, and the 。 sheet already shows what a sentence holds. There are two exceptions:
  

- the lit span while a point's panel is open
  
- a faint dotted underline on a point the first time you ever meet it, as a quiet "this is new"
  

After that first article, the point is never marked again. Most articles would carry zero to two marks. "Met" means the point has a `user_grammar_progress` row. The mark is set from that row, so it holds across devices.

7. **AI for this sentence, catalogue for the pattern.** The AI GRAMMAR INSIGHT (`fetchWordGrammarInsight`, Claude Haiku) stays. It does what a catalogue can't: it explains this word in this sentence of this article. The two halves split the job:
  

- **AI:** the in-context explanation. It shows in the word panel as now, and the grammar panel gets its own insight about the point in this sentence.
  
- **Catalogue:** what should be the same every time: the name, level, how it's built, examples, and tracking.
  
- **Kept consistent:** when the sentence matches catalogue points, their names and meanings go into the insight prompt. The AI then names the same pattern the rows show instead of inventing its own label or level.
  
- **Cost:** not a concern. The grammar-panel insight runs on the same Claude Haiku call as the word insight, once per point per sentence when a grammar panel opens. It's cached like the word insight.
  
- **No match:** words with no catalogue point (京都, 庭) get the insight alone, as now. It is also the fallback until the catalogue covers N3 and above.
  

8. **復習 grammar cards.** Points you've opened, or left at MEDIUM or HARD, join the deck as cloze cards. Each card is a sentence from an article you read with the point blanked and its meaning as the hint. Grading is Again / Hard / Good / Easy on the same FSRS scheduler as words.
  
9. **進捗 › 文法** comes later: a list of points by level, with mastery and how often you've met each one.
  
## The catalogue
A `grammar_points` table, small enough to sit in one table and ship to the client (about 100 rows at first, about 700–800 eventually).

```sql
create table grammar_points (
  id text primary key,            -- 'nakereba_naranai'
  jlpt_level int not null,        -- 5..1
  pattern text not null,          -- '〜なければならない'
  meaning_en text not null,       -- 'must, have to'
  formation jsonb not null,       -- ["動詞 ない形", "－ ない", "＋ なければならない"]
  note_en text,                   -- usage / nuance, 1–2 sentences
  examples jsonb not null,        -- [{ ja, en }] x2–3
  rule jsonb not null,            -- the matcher rule (below)
  related text[],                 -- e.g. nakya, naito (casual forms), te_wa_ikenai
  source text,                    -- where the entry came from (licence trail)
  sort int                        -- teaching order within a level
);
```
### Where the entries come from
A blend, all CC BY 4.0 (attribution only, the same kind of line we already carry for JMdict); see "Sources" below.

- **Spine: NINJAL 日本語文型データベース.** The point list, the sense split and the connection forms (`Vている`, `Ｖます＋ながら`), which become the matcher rules. It also supplies Japanese usage notes and real example sentences.
  
- **English: written by us for the first about 100 points.** We draft from NINJAL's senses and check against Hanabira's English entries. Hanabira has errors (〜ている filed at N3; 〜ばかりだ given the wrong formation), so we don't import it wholesale. The N5–N4 core is well settled across textbooks, and writing about 100 entries carefully is a few days, with a native-level review pass.
  
- **Levels:** NINJAL's 1–5 scale (5 = easiest) mapped to N5–N1, checked against the classic JLPT lists. There has been no official grammar list since 2010, so this is our call per point.
  
- **More examples:** Tatoeba sentences (CC BY 2.0 FR) where NINJAL's examples are too hard for the level.
  
## Spotting points in the text
### Approach: rules over the token stream we already have
The reader already splits every paragraph with kuromoji (IPADIC) on the phone (`services/tokenizer.ts`). Each token carries surface, dictionary form, part of speech and conjugation form. A grammar rule is a short pattern over that sequence. It runs in the same enrichment pass (`services/enrich.ts`), with no extra network and no AI call, and the same sentence always gives the same answer.

The rules run on the **raw** kuromoji tokens, before `mergeInflections` folds auxiliaries into the verb (直さ + なけれ → 直さなけれ). A match is stored as a character range over the paragraph. The reader then maps each display token to the points whose ranges overlap it; that map drives what a tap opens (see A + B above) and the lit span.
### What the tokens look like (checked with the app's dictionary)
```
直さ[動詞|未然形|直す] なけれ[助動詞|特殊・ナイ|仮定形|ない] ば[助詞/接続助詞] なり[動詞/非自立|連用形|なる] ませ[助動詞|ます] ん[助動詞|ん]
住み[動詞|連用形|住む] 始め[動詞/非自立|始める] て[助詞/接続助詞] い[動詞/非自立|いる] ます[助動詞|ます]
見[動詞|連用形|見る] ながら[助詞/接続助詞]
飲む[動詞|基本形] こと[名詞/非自立] が[助詞] できる[動詞|基本形]
選ん[動詞|連用タ接続] だ[助動詞|特殊・タ] そう[名詞/特殊] です[助動詞]      ← hearsay そうだ
降り[動詞|連用形] そう[名詞/接尾] だ[助動詞]                                ← looks-like そうだ
寒い[形容詞|基本形] ので[助詞/接続助詞]
```

The two 〜そうだ are told apart by the tokens alone (名詞/特殊 vs 名詞/接尾), which is the kind of case that makes rules worth it. Note also that kuromoji read 降り as 降りる here, not 降る: rules should lean on part of speech and form, not on the head word's lemma.
### Rule format
```jsonc
// 〜なければならない
{
  "steps": [
    { "pos": "動詞", "cform": "未然形", "mark": false },          // context: the verb, not marked
    { "lemma": "ない", "pos": "助動詞", "cform": "仮定形" },
    { "surface": "ば" },
    { "lemma": "なる" },
    { "any": [ { "lemma": "ない" }, { "seq": [ { "lemma": "ます" }, { "surface": "ん" } ] } ] }
  ]
}
```

- **Steps** match consecutive tokens on surface, lemma, part of speech (two levels), conjugation type and conjugation form. They also support `any` (alternatives), `seq`, `optional` and `mark: false` for context that must be there but isn't underlined.
  
- **Overlaps:**
  
  - Longer matches win where two rules claim the same tokens: 〜なければならない over a bare 〜ば.
    
  - Some points suppress others: 〜ている suppresses the bare て-form note.
    
  - Separate points stack: 住み始めています is both 〜始める and 〜ている.
    
- **Hard cases left for later:**
  
  - discontinuous points (〜ば…ほど)
    
  - points that need meaning to tell apart (で as place vs means)
    
  
  These either get a narrower rule or wait for the AI fallback.
  
### Testing the rules
- **Fixtures:** each rule ships with positive and negative example sentences. `scripts/grammar-rules-test.mjs` tokenizes them with the app's dictionary and checks matches. It runs in CI-less fashion like the eval harness.
  
- **Coverage audit:** a read-only pass over stored articles (`processed_news` paragraphs). It reports how often each rule fires, and samples hits for a by-eye check of false positives. Following [[pressure-test-spec-against-data]]: run it before building UI.
  
### AI fallback (later)
For points the rules miss, especially N3 and above, a Gemini pass can name which catalogue IDs appear in a sentence, constrained to the catalogue. It would run once per article and be cached with the enrichment. Not part of the first phases.
## Tracking and review
- `user_grammar_progress (user_id, grammar_id, mastery, seen_count, last_seen_at, fsrs fields)` mirrors `user_word_progress`. It has RLS per user and syncs the same way.
  
- **Seen:** a point counts as seen when it's on screen in an article you read. That's all a seen point gets: no change to its mastery, and it doesn't enter review.
  
- **Lookups:** see "What counts as a lookup" below. A counted lookup makes the point a review candidate at MEDIUM, like a word.
  
- **Review:** grammar cards share the 復習 deck and FSRS scheduler. The intake is capped like new words, so grammar doesn't flood the deck ([[study-pacing-flood-fix]]).
  
- **Cloze sentences** come from articles the reader actually read: store the sentence text and the span with the progress row.
  
### What counts as a lookup
A word lookup should never drag grammar along with it, and the reverse also holds. Tapping 直さなけれ to check 直す must not mark 〜なければならない as something you struggled with. The rule is to separate what a panel _shows_ from what gets _counted_.

1. **Grammar shown in a word panel counts for nothing.** The word is logged as a lookup, as today. The GRAMMAR rows under it are only displayed, so the point doesn't change and doesn't enter review.
  
2. **A grammar lookup needs a deliberate step:**
  

- **Opened from a row** (in a word panel or the 。 sheet): that's a clear choice, so it counts.
  
- **Opened by tapping a grammar piece** (ば, なりません): these are small and sit right next to words, so this is where accidental taps land. It counts only if the panel stays open for about 2 seconds or is scrolled. A quick close, or jumping to "As a word", is treated as a miss and nothing is logged.
  

3. **The other direction:** opening 〜なければならない from なりません doesn't log なる as a word lookup.
  
4. **Taps never set difficulty.** A counted lookup only makes the point a review candidate at MEDIUM, through the same capped daily intake as words. EASY and HARD change only when you move the slider yourself, so a lookup that slips through can't mark a point hard or flood 復習.
  

A stricter option is no automatic tracking at all: grammar would enter review only from the slider or an explicit 復習に追加. It's the safest, but it gives up the passive loop words have. Start with the dwell rule and tune the 2-second gate against real use.
## Casual language
The concern: the app reads news, and the books lean formal (N1 is almost all written style), so the catalogue could teach 〜なければならない and never 〜なきゃ.

- **The catalogue must cover casual forms.** NINJAL tags 72 senses as くだけた言い方 (55 headwords). Each casual point links to its formal partner: 〜なきゃ / 〜ないと ↔ 〜なければならない, 〜ちゃう ↔ 〜てしまう, 〜てる ↔ 〜ている, 〜とく ↔ 〜ておく, 〜って ↔ 〜という / 〜と言っていた. The grammar panel shows the partner ("In speech: 〜なきゃ"), so meeting either one teaches both.
  
- **Casual speech is more than patterns.** It also means sentence-final particles (よ, ね, よね, かな, っけ, じゃん, もん, の？), dropped particles, and contractions (じゃ, ちゃ, って). These belong in their own 話し言葉 group in the catalogue, and the rules need fixtures written in casual speech; kuromoji splits contractions differently.
  
- **The bigger lever is what you read.** Grammar detection can only find what the text contains. Casual text is already in the app in a few places:
  
  - songs (lyrics are casual by nature)
    
  - the dialogue in long-form fiction (the rewrite keeps the source's register)
    
  - quoted speech in news interviews
    
  
  Today's podcasts are written in です/ます (`podcastPrompt.ts`). The options are:
  
  - a casual podcast cast: two friends talking, plain form
    
  - an occasional column or interview style in the news rewrite, where quotes stay in plain speech
    
  - asking the rewrite to use casual points the reader is learning, in quotes and dialogue
    
  
  That way casual grammar meets the reader in context instead of only in a list.
  
- **Tracking stays one-to-one.** A casual point is its own catalogue entry with its own mastery: knowing 〜てしまう doesn't mean you can parse 〜ちゃった. The link between partners is for explanation, not shared credit.
  
## Feeding the rewrite
Once points are tracked, `process-article` (`_shared/rewritePrompt.ts`) can be asked to use 2–3 points the reader is learning, the same soft ask as review words. Any such change runs through the eval harness ([[eval-harness-is-rewrite-yardstick]]).
## Phases
| Phase | What ships | Done when |
| --- | --- | --- |
| **0 · Proof** ✅ | Rule engine (`src/services/grammar/engine.ts`) + 21 rules: 16 N5/N4 points and 5 casual forms (`rules.ts`) + `scripts/test-grammar-rules.mjs` (fixtures, NINJAL recall, article audit) → `docs/grammar/phase0-report.md` | Rules fire on real articles with few false positives: 71/71 fixtures, 98% NINJAL recall (580/592), no false positives seen in sampled hits |
| **1 · Read** | Catalogue of about 100 N5–N4 points; token → point map; grammar-first panel for grammar pieces; PATTERNS rows under the word insight; AI insight in the grammar panel (prompt given the matched points); lit span; points listed in the 。 sheet | Tapping any piece of an article explains its grammar |
| **2 · Connect** | Seen/lookup tracking; `user_grammar_progress` | Points you meet are remembered |
| **3 · Review** | Grammar cloze cards in 復習 | Points come back for review |
| **4 · Grow** | Rewrite asks for learning points; N3 rules; 進捗 › 文法 | Articles practise your grammar |
| **5 · Tail** | AI fallback for unmatched/ambiguous points | —   |
## Sources
From a research pass on 2026-10-12. The licences were read from each repo or site, except where noted.

| Source | Licence | Size | Use |
| --- | --- | --- | --- |
| **NINJAL 日本語文型データベース** ([record](https://repository.ninjal.ac.jp/record/2000610), Pardeshi & Sunakawa, v2026-01-26) | CC BY 4.0 | 800 headwords, 1,988 connection types, 9,552 examples; XML; Japanese only | **Spine.** Structured connection forms per sense, levels 1–5 (5 = easiest, mapping to JLPT is ours) |
| **Hanabira** ([content repo](https://github.com/tristcoil/hanabira.org-japanese-content)) | CC BY 4.0 (link to hanabira.org required) | 828 points N5–N1; JSON; English explanations + about 4 translated examples each | Reference for English; has errors, proofread before any reuse |
| **Open Japanese Grammar** ([repo](https://github.com/lasrod/open-japanese-grammar)) | CC BY 4.0 | 349 points, N5/N4 filled, N3+ stubs; best schema (formation array, distinguish-from) | Schema inspiration; possibly contribute back |
| **Tatoeba** | CC BY 2.0 FR (some CC0) | Large sentence corpus with `jpn_indices` | Extra example sentences |
| Tae Kim's Guide | CC BY-NC-SA (version unverified) | Prose | **Avoid:** non-commercial |
| Bunpro, JLPT Sensei, IMABI, DoJG / 日本語文型辞典, Anki decks | Copyright / no licence | —   | **Avoid** (reference only, never copied) |
| Tsutsuji 機能表現辞書 (Nagoya) | Unverified | about 16k surface forms, built for detection | Worth asking the authors about |

**JLPT level checklist** (`docs/grammar/jlpt-checklist.tsv`). This is transcribed from the indexes of the 新完全マスター文法 N3, N2 and N1 books (3A Network). It is used only as a checklist: pattern name, sense label and level. The book's explanations and examples are not used, and page numbers are dropped.

| Level | Patterns | Words | Categories |
| --- | --- | --- | --- |
| N3  | 186 | 58  | 10  |
| N2  | 218 | —   | —   |
| N1  | 163 | —   | —   |

- **Patterns** are the catalogue's core.
  
- **Words** are adverbs, conjunctions and demonstratives (したがって, まるで, めったに). JMdict already covers them, so they become "also a grammar point" links, not rules.
  
- **Categories** are 受身, 使役, 使役受身, 尊敬語, 謙譲語, 丁寧語, 自動詞, 他動詞, 禁止 and 命令. These are conjugation-based and among the easiest to detect.
  
- **Senses:** N3 names them in brackets (〜ように [期待] / [要求] …). N2 numbers them (〜ものだ ①②③); the numbers are kept, but the meanings still have to be written.
  
- **Overlap:** 25 N2 entries repeat N3 ones (〜わけだ, 〜によって, 〜べきだ…). A pattern takes the lower level unless the higher entry is a different sense. N1 barely repeats the lower books: only 〜とは, which in N1 is the surprise sense. The N1 index lists 〜(よ)うが and 〜ようが separately (and likewise the 〜まいが / 〜まいと forms); merge them when building.
  

**NINJAL match** (`docs/grammar/ninjal-match.tsv`, made by `scripts/grammar/ninjal_parse.py` + `ninjal_match.py`). Each checklist entry is matched to NINJAL headwords after normalising the notation (〜/…, optional parts, 〜に対して ≈ 〜に対し).

| Book level | Patterns | Matched exactly | Near (needs a look) | Not in NINJAL |
| --- | --- | --- | --- | --- |
| N3  | 186 | 125 | 8   | 53  |
| N2  | 218 | 142 | 9   | 67  |
| N1  | 163 | 92  | 6   | 65  |

- **Real gaps.** NINJAL's 800 headwords leave out some common patterns: 〜わけだ, 〜はずがない, 〜おそれがある, 〜をめぐって, 〜をもって, 〜ざるを得ない. We write their connection forms ourselves; they are standard and well documented.
  
- **Level calibration.** For exact matches, NINJAL's easiest-sense level lines up with the books like this. This settles the mapping:
  
  | NINJAL level | Book level |
  | --- | --- |
  | 1   | N1 (82 of 92) |
  | 2   | N2 (113 of 142) |
  | 3–4 | N3  |
  | 4–5 | N4–N5 |
  
- **N5–N4 core.** 146 NINJAL entries at level 4–5 aren't in any book index, e.g. 〜てしまう, 〜ておく, 〜てみる, 〜かもしれない, 〜ことができる, 〜てもいい, 〜てはいけない, plus the 敬語 verbs. Together with what the N3 book repeats, they make the starting set of about 100 points.
  
- **Free test sentences.** NINJAL marks the pattern in each example (降っ｛ていました｝), giving 9,552 positive examples with spans for the rule fixtures.
  
- **Register is tagged.** Each NINJAL sense carries a style: 163 硬い, 30 書き言葉, 75 柔らかい and 72 くだけた. The casual entries (55 headwords: 〜ちゃう, 〜とく, 〜てる, 〜なきゃ, 〜っけ, 〜って, 〜もん…) are a ready-made casual layer; see "Casual language" below.
  

**Detectors.** No mature open-source grammar detector exists.

- **YAPAN** is GPL and built on data scraped from JLPT Sensei.
  
- **ichiran** (MIT) and **Yomitan's deinflector** (GPL) cover conjugation only.
  

They're useful references for the rule engine, but the rules themselves are ours to write. That's the real work in phase 0–1.

**Attribution.** One line per source in the app's about or credits area, next to JMdict's: “Grammar patterns: 日本語文型データベース (NINJAL), CC BY 4.0.” Add Hanabira and Tatoeba to the line if their text or sentences are used.
## Open questions
0. **Sources.** Is NINJAL as the spine, with our own English and Hanabira as a cross-check, the right call? The alternative is writing the whole catalogue ourselves.
  
1. **Tap model.** A + B (the tap decides, and the sentence lists it), or try the 文法 lens (D)?
  
2. **Which piece leads with grammar.** Is "no content word, or wholly inside the point" the right rule? Edge cases: 前 in 〜前に and できる in 〜ことができる lead with grammar under this rule.
  
3. **First-meet marks.** Keep them (on by default), or have no marks at all?
  
4. **Review intake.** Should grammar cards come from counted lookups only, or also from points you meet often but never open? And is the 2-second dwell gate right, or should grammar be slider-only?
  
5. **Explanation language.** English meanings and notes to start; Japanese explanations (やさしい日本語) for N3+ readers later?
