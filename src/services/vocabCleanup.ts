/**
 * One-time tombstones from the JLPT tag cleanup (docs/jlpt_vocab_audit.md).
 *
 * The original enrichment tagged homograph/homophone JMDict entries with JLPT
 * levels they don't have (顔=かんばせ as N5, 肺 as はい, ...). Discover served
 * them, so word progress accumulated under entry ids the user never actually
 * studied. scripts/fix_progress_rows.cjs repairs the server rows (remapping
 * same-surface homographs to the entry the user really read, deleting
 * dictionary noise); this list keeps clients in agreement:
 *
 *   - sync-down ignores these ids, so an un-migrated server can't re-add them
 *   - sync-up skips them, so a stale local cache can't resurrect deleted rows
 *   - persist migration v8 drops them from the local word database
 *
 * Progress on the remap TARGETS flows back in via the normal server rehydrate.
 * Keep in sync with scripts/jlpt_progress_fix.json.
 */
export const TOMBSTONED_WORD_IDS: ReadonlySet<string> = new Set([
  // remapped (wrong homograph -> the entry the user actually read)
  '1579580', // 次(じ) -> 次(つぎ)
  '1580400', // 上手(うわて) -> 上手(じょうず)
  '1479900', // 半分(はんぷん) -> 半分(はんぶん)
  '1580485', // 丈夫(じょうふ) -> 丈夫(じょうぶ)
  '1311010', // 氏(うじ) -> 氏(し)
  '1185190', // 下手(したて) -> 下手(へた)
  '1185195', // 下手(しもて) -> 下手(へた)
  '1537960', // 役(えき) -> 役(やく)
  '1378440', // 生(き) -> 生(なま)
  '1375250', // 性(さが) -> 性(せい)
  '1311125', // 私(あたし) -> 私(わたし)
  '1414230', // 大勢(たいせい) -> 大勢(おおぜい)
  '1147330', // 露(ろ) -> 露(つゆ)
  '2147990', // 背(せ, chair) -> 背(せ)
  '1643470', // 大切り(おおぎり) -> 大切(たいせつ)
  '1465580', // 入る(いる) -> 入る(はいる)
  '1525750', // 万(ばん) -> 万(まん)
  '1249300', // 係る(かかる) -> 掛かる
  '1557940', // 齢(よわい) -> 歳(とし)
  '1347580', // 妾(わらわ) -> 私(わたし)
  '1409150', // 体(たい) -> 体(からだ)
  '1409160', // 体(てい) -> 体(からだ)
  '1428285', // 朝(ちょう) -> 朝(あさ)
  '1447430', // 東(あずま) -> 東(ひがし)
  '1165980', // 一番(ひとつがい) -> 一番(いちばん)
  '2246880', // 貝(バイ) -> 貝(かい)
  // deleted (dictionary noise that only entered via bad JLPT tags)
  // NOTE: do not add real words here — this set permanently blocks sync for
  // these ids. One-time fixes for legitimate words go in RECOVERABLE_WORD_IDS.
  '1543920', // 余意
  '1580130', // 出端
  '1000050', // 仝
  '1186150', // 下番
  '1193110', // 架かる
  '1316750', // 次点者
  '1331540', // 就ける
  '1339500', // 出切る
  '1518450', // 亡い
  '2427850', // 大き(おおき)
]);

/**
 * Real words whose progress rows were MISATTRIBUTED by the reader's homophone
 * tiebreak (pickBestEntry chose the kanji-primary homophone for a kana lemma:
 * する -> 擦る, いる -> 射る, なる -> 生る). The server-side fix remaps those
 * rows to the entry actually read; the persist v9 migration drops the local
 * copies once so the remapped progress rehydrates cleanly. Unlike
 * TOMBSTONED_WORD_IDS these are NOT blocked from future sync — they are
 * legitimate words that can be studied for real later.
 */
export const RECOVERABLE_WORD_IDS: ReadonlySet<string> = new Set([
  '1595910', // 擦る(する) -> 為る 1157170
  '1322180', // 射る(いる) -> 居る 1577980
  '1611000', // 生る(なる) -> 成る 1375610
]);
