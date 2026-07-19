# JLPT Vocabulary Tag Audit

**Date:** 2026-07-19 · **Scope:** `jmdict_entries.jlpt_level` (all levels, N5 in depth) · **Read-only** — no data was changed.

## TL;DR

The odd words you're hitting in N5 are real and systematic: **roughly 22% of N5-tagged entries (186 of 827) are cleanup candidates**, almost all of them rare homographs and homophones that were dragged in by loose matching in the original enrichment script. Worse, **45 genuine N5 words — including 会う, 来る, する, 頭, 魚, 川 — currently carry a harder-level tag** (N1–N3) and are missing from the N5 pool entirely. The same defects affect every level (1,143 flagged entries across N1–N5). The fix I recommend is a re-run of enrichment with a stricter matcher rather than hand-editing rows, since one root cause (level overwrites) can't be fixed by deletion alone.

## How the tags got there, and why they're wrong

Tags were populated by `scripts/enrich_jlpt.cjs`, which downloads the open-anki-jlpt-decks CSVs (718 N5 words, 6,131 total) and matches them to JMDict by surface text. It has three defects:

1. **Fan-out over-tagging.** For each CSV word it fetches up to 5 JMDict entries whose kanji text matches, and tags *all* of them. The N5 word 顔 (かお) therefore also tagged 顔 read かんばせ (dated, "countenance"). 私 (わたし) tagged 私 read あっし (Edo-period workman's "I"). 二十歳 (はたち) tagged 二十歳 read はたとせ (archaic). This is the main source of the weird words you're seeing.

2. **Kana homophone fallback.** When a CSV word has no kanji form (これ, する, いい, やる…), it matches by kana reading — again tagging every homophone. いい ("good") tagged 易々, 唯々, 謂, 怡々. やる tagged 殺る ("to bump someone off"), 犯る (vulgar slang), 演る. かばん ("bag") tagged 下番 ("going off duty"). じてんしゃ tagged 次点者 ("runner-up"). It even tagged ＫＯＰＦ, a 1930s Esperanto proletarian-culture federation, as N5 because it reads コップ.

3. **Hardest level wins on overlap.** Levels are processed N5 → N1 with a plain overwrite, so any entry whose surface also matches a harder level's list ends up tagged with the harder level. That's how 来る became N1 and 会う became N3/N4. A learner filtering for N5 never sees these words.

## Numbers by level

Tier definitions — **A (remove):** every sense is archaic/obsolete/rare, or it's a non-common, unranked homograph that lost to an established entry with the same written form. **B (review):** non-common and unranked but not provably a collision; mostly kana-homophone junk with a few legitimate keeps. **C (keep, note):** collision loser but common/frequency-ranked — usually two legitimate readings of one written form (e.g. 一日 as ついたち and いちにち).

| Level | Source CSV words | Tagged entries | A: remove | B: review | C: keep |
|---|---|---|---|---|---|
| N5 | 718 | 827 | 141 | 45 | 14 |
| N4 | 668 | 724 | 93 | 27 | 7 |
| N3 | 2,140 | 2,341 | 297 | 62 | 68 |
| N2 | 1,906 | 1,823 | 102 | 65 | 21 |
| N1 | 2,699 | 2,881 | 198 | 185 | 31 |
| **Total** | **8,131** | **8,596** | **831** | **384** | **141** |

The full flagged list (1,356 rows, all levels, with entry IDs, glosses, and tier) is in **`docs/jlpt_audit_candidates.csv`**.

## N5 in detail

### Tier A — remove tag (141 entries)

Representative offenders (full list in the CSV):

| Entry | Word | Reading | Why it's tagged N5 | Actually is |
|---|---|---|---|---|
| 2015370 | 儂 | わし | collides with わたし-adjacent forms | old-man "I" |
| 1347580 | 妾 | わらわ | shares 私-family kanji | archaic feminine "I" |
| 2221310 | 顔 | かんばせ | same kanji as 顔 (かお) | dated "countenance" |
| 2079310 | 私 | あっし | same kanji as 私 (わたし) | Edo workman's "I" |
| 2220380 | 二十歳 | はたとせ | same kanji as はたち | archaic "twenty years" |
| 2087680 | 強い | こわい | same kanji as つよい | "stiff, obstinate" |
| 2109290 | 違う | たがう | same kanji as ちがう | literary "to run counter to" |
| 1288860 | 今 | こん | same kanji as いま | prefix "the current…" |
| 1409160 | 体 | てい | same kanji as からだ | "appearance, air" |
| 1447430 | 東 | あずま | same kanji as ひがし | old name for eastern Japan |
| 2153780 | 水 | すい | same kanji as みず | "Wednesday (abbr)" |
| 2151440 | 橋 | きょう | same kanji as はし | "pons Varolii" (brain anatomy) |
| 2253330 | 夏 | か | same kanji as なつ | Xia dynasty of China |
| 2252550 | 唖々 | ああ | reads ああ | archaic "caw of a crow" |
| 2571360 | 怡々 | いい | reads いい | archaic "rejoicing" |

The pattern: single-kanji N5 words (日, 目, 口, 山, 水, 木…) have many obscure alternate-reading entries in JMDict, and every one of them got the N5 tag.

### Tier B — review (45 entries, my calls included)

Nearly all are kana-homophone junk from defect 2 and should also lose the tag: 次点者 (じてんしゃ), 殺る・犯る・演る (やる), 出切る (できる), 架かる・係る・斯かる (かかる), 就ける・尾ける (つける), 亡い (ない), 余意 (よい), 下番 (かばん), 仝・戸戸・呱々 (ここ/どう), 摩多 (また), 立破 (りっぱ), 謂・易々・唯々 (いい), 蒙・猛 (もう), 邪 (じゃ), 出端 (では), 翌 (よく), interjection-only entries for これ・それ・あれ・なる, ＫＯＰＦ, ＰＥＮ, ＰＥＴ, 六 read リュー, 町 read ちょう, 体 read たい, 戸 read こ, マッチ entry 2784220 ("match = contest"; the matchstick entry is the common one).

**Keep (legitimately N5 despite no frequency rank):** お皿 (1299685), お酒 (1329015), テープレコーダー (1078810), 伯母さん (2261500). Possibly 温い (2863133, ぬくい) — judgment call.

### Lost N5 words — 45 real N5 words tagged harder (needs restore, not delete)

会う, 開く, 上げる, 明後日, 暖かい, 頭 (→N1), 後, 余り, 在る/有る, 五日, 上, 後ろ, 歌, 伯父さん, 遅い, 一昨日, おととし, お腹, 降りる, 方, かぶる, 辛い, 川, グラム, 来る (→N1), 魚, 先, 下, 閉める, 締める, する (→N1/N2), そば, 空, 机, 勤める, 中, 登る, はい, 一人, and 6 more (full list derivable from the CSV comparison; script in scratchpad).

These can't be fixed by removing bad tags — they need re-tagging to 5, which is why I recommend a re-run over surgery.

### Never matched — 43 CSV words with no tag at all

Almost all are affix patterns the matcher couldn't handle: ～円, ～回, ～階, ～か月, ～側, ～個, ～語, お～, ～がる, etc. Low priority; they're grammar-ish entries a dictionary lookup handles differently anyway.

## Recommendation

**Option 1 (recommended): fix the enricher, wipe, re-run.** Modify `enrich_jlpt.cjs` to (a) pick a *single best* JMDict entry per CSV word — prefer exact kanji match, then `common = true`, then best `freq_rank`, and require the entry's reading to match the CSV reading when matching by kanji; (b) never tag additional homographs/homophones; (c) on cross-level overlap, keep the *easiest* level (first-tagged wins) so N5 会う stays N5. Then `UPDATE jmdict_entries SET jlpt_level = NULL` and re-run. This fixes all three defects at every level in one deterministic pass, and stays re-runnable when the source decks update.

**Option 2 (surgical): null out the flagged IDs.** A single `UPDATE … SET jlpt_level = NULL WHERE id IN (…)` from the Tier A + Tier B-remove lists in the CSV. Faster, but leaves the 45 lost N5 words wrong and leaves N4–N1 collision losers of Tier C ambiguity untouched.

Either way the migration is manual in Supabase per project convention, and `getJlptTotals()` caches per-level totals client-side — Progress denominators will shift after cleanup (N5: 827 → about 690 + 45 restored ≈ 735).

## Reading-goal impact

For your stated goal (reading + vocab growth toward JLPT): the N5 pool your Discover/intake lanes draw from is currently about 17% noise, and it's the *rare-looking* noise you noticed because collision losers are precisely the entries with no frequency rank. Cleaning Tier A+B and restoring the 45 lost words makes "study everything tagged N5" actually mean the 718-word syllabus.
