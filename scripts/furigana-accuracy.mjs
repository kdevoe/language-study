/**
 * Furigana accuracy harness.
 *
 * Runs the real client tokenizer transform (displayFromRaw + okurigana
 * alignment) over Japanese text using kuromoji + IPADIC, and reports:
 *
 *   1. Measured reading accuracy on a hand-labeled GOLD set (normal words +
 *      heteronym traps) — an actual correct/total %.
 *   2. A coverage + risk scan over a corpus (built-in samples, or a --file you
 *      point at real article text) — coverage %, blank/unknown readings, and
 *      the high-risk categories (heteronyms, multi-kanji groups) to spot-check.
 *
 * Usage:
 *   node scripts/furigana-accuracy.mjs                 # gold set + built-in corpus
 *   node scripts/furigana-accuracy.mjs --file art.txt  # also scan a text file
 *
 * The harness loads the SAME transform the app ships (src/services/tokenizer.ts),
 * bundled on the fly, so results match production. Only the dictionary loader
 * differs (Node fs here vs. fetch in the browser) — the analysis is identical.
 */

import esbuild from 'esbuild';
import kuromoji from '@sglkc/kuromoji';
import { pathToFileURL } from 'node:url';
import { readFileSync, rmSync } from 'node:fs';

const NODE_DICT = 'node_modules/@sglkc/kuromoji/dict';
const TMP_BUNDLE = '.tmp_furigana_harness.mjs';

// ── Gold set: sentence + the word whose reading we check + the correct reading ──
// `cat: 'heteronym'` marks words with >1 common reading (the hard cases an LLM
// was originally meant to solve). `normal` words should be near-perfect.
const GOLD = [
  // — normal vocabulary (expect ~100%) —
  ['ウクライナの大統領がロンドンに着きました。', '大統領', 'だいとうりょう', 'normal'],
  ['イギリスの首相がこの会談を準備しました。', '首相', 'しゅしょう', 'normal'],
  ['イギリスの首相がこの会談を準備しました。', '会談', 'かいだん', 'normal'],
  ['イギリスの首相がこの会談を準備しました。', '準備', 'じゅんび', 'normal'],
  ['ドイツのメルツ氏も参加します。', '参加', 'さんか', 'normal'],
  ['大切なお金を支援しています。', '支援', 'しえん', 'normal'],
  ['これからの平和への道を話し合っています。', '平和', 'へいわ', 'normal'],
  ['安全な未来を造るために計画を立てます。', '安全', 'あんぜん', 'normal'],
  ['安全な未来を造るために計画を立てます。', '未来', 'みらい', 'normal'],
  ['安全な未来を造るために計画を立てます。', '計画', 'けいかく', 'normal'],
  ['迅速に計画を立てることが必要です。', '必要', 'ひつよう', 'normal'],
  ['有名な道路の近くで会談をします。', '有名', 'ゆうめい', 'normal'],
  ['有名な道路の近くで会談をします。', '道路', 'どうろ', 'normal'],
  ['ウクライナを助けるために集まりました。', '助ける', 'たすける', 'normal'],
  ['彼はロンドンに着きました。', '着きました', 'つきました', 'normal'],
  ['経済の問題について議論した。', '経済', 'けいざい', 'normal'],
  ['政府は新しい政策を発表した。', '政府', 'せいふ', 'normal'],
  ['政府は新しい政策を発表した。', '発表', 'はっぴょう', 'normal'],
  ['彼女は学校で日本語を勉強している。', '勉強', 'べんきょう', 'normal'],
  ['天気がよかったので公園を散歩した。', '散歩', 'さんぽ', 'normal'],

  // — heteronyms (the interesting measurement) —
  ['今日は天気がとてもいいです。', '今日', 'きょう', 'heteronym'],
  ['昨日は雨が降りました。', '昨日', 'きのう', 'heteronym'],
  ['実験を行った研究者が発表した。', '行った', 'おこなった', 'heteronym'],
  ['友達と公園に行った。', '行った', 'いった', 'heteronym'],
  ['これは何ですか。', '何', 'なに', 'heteronym'],
  ['会議には何人来ますか。', '何', 'なん', 'heteronym'],
  ['一日中ずっと働いていた。', '一日', 'いちにち', 'heteronym'],
  ['この映画はとても人気があります。', '人気', 'にんき', 'heteronym'],
  ['世界の市場が大きく動いた。', '市場', 'しじょう', 'heteronym'],
  ['彼は料理が上手です。', '上手', 'じょうず', 'heteronym'],
  ['店のドアが開く。', '開く', 'あく', 'heteronym'],
  ['部屋に入る前にノックする。', '入る', 'はいる', 'heteronym'],
  ['明日の朝に出発します。', '明日', 'あした', 'heteronym'],
  ['日本の文化に興味がある。', '日本', 'にほん', 'heteronym'],
];

// Surfaces with more than one common reading — flagged in the corpus scan as
// "needs a human check" even when we can't auto-grade them.
const HETERONYM_WATCH = new Set([
  '今日', '昨日', '明日', '何', '一日', '二日', '日本', '人気', '市場', '上手',
  '下手', '大事', '見物', '清水', '生物', '一行', '一見', '色紙', '風', '方',
  '気', '間', '物', '辛い', '入る', '入った', '行く', '行った', '行って', '開く',
  '開いた', '空く', '止まる', 'congress',
]);

// Built-in corpus for the scan (news-register prose like the app produces).
const CORPUS = [
  'ウクライナのゼレンスキー大統領が、イギリスのロンドンに着きました。',
  'ダウニング街にある有名な道路の近くで、ヨーロッパの国々のリーダーたちと会談をします。',
  'イギリスのスターマー首相がこの会談を準備しました。',
  'フランスのマクロン大統領やドイツのメルツ氏も参加します。',
  'これらの国は、ウクライナを助けるために大切なお金を支援しています。',
  'リーダーたちは、これからの平和への道を話し合っています。',
  '安全な未来を造るために、迅速に計画を立てることが必要です。',
  '政府は経済の問題について新しい政策を発表しました。',
  '研究者たちは実験を行い、その結果を世界に向けて公表した。',
  '昨日の市場では株価が大きく上がり、多くの投資家が注目した。',
];

// ── Bundle the real transform, then load it ──────────────────────────────────
async function loadTransform() {
  await esbuild.build({
    entryPoints: ['src/services/tokenizer.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['@sglkc/kuromoji'],
    outfile: TMP_BUNDLE,
    logLevel: 'silent',
  });
  return import(pathToFileURL(TMP_BUNDLE).href);
}

function buildTokenizer() {
  return new Promise((resolve, reject) => {
    kuromoji.builder({ dicPath: NODE_DICT }).build((err, t) => (err ? reject(err) : resolve(t)));
  });
}

function pct(n, d) {
  return d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`;
}

// Find the reading for `target` in a token list. Handles the target landing as
// one token, or split across a contiguous run (一日 → 一 + 日), by concatenating.
function readingFor(tokens, target) {
  const exact = tokens.find((t) => t.text === target);
  if (exact) return exact.furigana ?? '(no furigana)';
  for (let i = 0; i < tokens.length; i++) {
    let surface = '';
    let reading = '';
    for (let j = i; j < tokens.length; j++) {
      surface += tokens[j].text;
      reading += tokens[j].furigana ?? tokens[j].text;
      if (surface === target) return reading;
      if (!target.startsWith(surface)) break;
    }
  }
  return '(token not found)';
}

async function main() {
  const fileArgIdx = process.argv.indexOf('--file');
  const extraText = fileArgIdx !== -1 ? readFileSync(process.argv[fileArgIdx + 1], 'utf8') : '';

  const { displayFromRaw } = await loadTransform();
  const tokenizer = await buildTokenizer();
  const tokenize = (s) => displayFromRaw(tokenizer.tokenize(s));

  // ── 1. Gold-set measured accuracy ──────────────────────────────────────────
  const buckets = { normal: { ok: 0, n: 0 }, heteronym: { ok: 0, n: 0 } };
  const misses = [];
  for (const [sentence, target, expected, cat] of GOLD) {
    const tokens = tokenize(sentence);
    const got = readingFor(tokens, target);
    buckets[cat].n++;
    if (got === expected) buckets[cat].ok++;
    else misses.push({ sentence, target, expected, got, cat });
  }

  console.log('═══ 1. Gold-set reading accuracy (measured) ═══\n');
  for (const cat of ['normal', 'heteronym']) {
    const b = buckets[cat];
    console.log(`  ${cat.padEnd(10)} ${b.ok}/${b.n}  (${pct(b.ok, b.n)})`);
  }
  const allOk = buckets.normal.ok + buckets.heteronym.ok;
  const allN = buckets.normal.n + buckets.heteronym.n;
  console.log(`  ${'overall'.padEnd(10)} ${allOk}/${allN}  (${pct(allOk, allN)})`);
  if (misses.length) {
    console.log('\n  Misreads:');
    for (const m of misses) {
      console.log(`    [${m.cat}] ${m.target}  expected ${m.expected}  got ${m.got}`);
      console.log(`        ${m.sentence}`);
    }
  }

  // ── 2. Corpus coverage + risk scan ─────────────────────────────────────────
  const sentences = [...CORPUS];
  if (extraText) {
    for (const s of extraText.split(/(?<=[。！？\n])/)) {
      const t = s.trim();
      if (t) sentences.push(t);
    }
  }

  let kanjiTokens = 0;
  let withReading = 0;
  let blank = 0;
  let multiKanjiGroups = 0;
  const blankSamples = [];
  const heteronymHits = [];

  const hasKanji = (s) => /[一-龯㐀-䶿]/.test(s);
  for (const s of sentences) {
    for (const t of tokenize(s)) {
      if (hasKanji(t.text)) {
        kanjiTokens++;
        if (t.furigana) withReading++;
        else { blank++; if (blankSamples.length < 25) blankSamples.push(t.text); }
        if (t.furiganaMap) {
          for (const seg of t.furiganaMap) {
            if (Array.from(seg.kanji).length > 1) multiKanjiGroups++;
          }
        }
      }
      if (HETERONYM_WATCH.has(t.text)) heteronymHits.push({ word: t.text, reading: t.furigana ?? '(none)', s });
    }
  }

  console.log(`\n═══ 2. Corpus scan (${sentences.length} sentences) ═══\n`);
  console.log(`  Kanji-bearing tokens:     ${kanjiTokens}`);
  console.log(`  Reading present:          ${withReading}  (${pct(withReading, kanjiTokens)} coverage)`);
  console.log(`  Blank / unknown reading:  ${blank}  (proper nouns, names — shown bare, not wrong)`);
  if (blankSamples.length) console.log(`      e.g. ${[...new Set(blankSamples)].join(' ')}`);
  console.log(`  Multi-kanji groups:       ${multiKanjiGroups}  (whole-word reading shown, RTK per kanji)`);
  console.log(`  Heteronym-watchlist hits: ${heteronymHits.length}  (need human check)`);
  for (const h of heteronymHits) console.log(`      ${h.word} → ${h.reading}`);

  console.log('\nNote: gold-set % is measured; corpus coverage is automatic, but');
  console.log('reading *correctness* on the corpus still needs human spot-check of');
  console.log('the heteronym hits above (the dominant residual error source).');

  rmSync(TMP_BUNDLE, { force: true });
}

main().catch((e) => {
  rmSync(TMP_BUNDLE, { force: true });
  console.error(e);
  process.exit(1);
});
