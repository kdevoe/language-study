/**
 * Standalone test runner for the server-side furigana aligner
 * (supabase/functions/_shared/furiganaMap.ts).
 *
 *   node scripts/test-furigana-map.mjs
 *
 * No test framework (matches test-srs.mjs / test-deck.mjs): the module is pure,
 * so we bundle it with esbuild and assert on a fixture table. Exits non-zero on
 * any failure.
 *
 * What it locks in:
 *   • the RECONSTRUCTION INVARIANT for every fixture: concatenating the
 *     segments reproduces the word and its full reading. Wrong furigana
 *     corrupts both display and SRS keying, and a dropped/duplicated kana is
 *     the corrupting failure mode — a merely-coarse per-kanji split is not.
 *   • exact per-character splits for the shapes the kana-anchor algorithm
 *     handles deterministically: all-kana words, okurigana, kana anchors
 *     between kanji runs, leading kana.
 *   • documented-heuristic shapes (unanchored multi-kanji runs: jukujikun,
 *     compounds) keep the invariant even though the per-kanji split is
 *     proportional guesswork (今日 has no true per-kanji reading).
 */
import esbuild from 'esbuild';
import { pathToFileURL } from 'node:url';
import { rmSync } from 'node:fs';
import path from 'node:path';

const TMP = path.join('scripts', '.tmp-furigana-bundle.mjs');

await esbuild.build({
  entryPoints: ['supabase/functions/_shared/furiganaMap.ts'],
  outfile: TMP,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
});
const { buildFuriganaMap } = await import(pathToFileURL(path.resolve(TMP)).href);
rmSync(TMP);

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

const seg = (kanji, kana) => ({ kanji, kana });
const show = (segs) => segs.map((s) => `${s.kanji}:${s.kana}`).join(' ');

// ── Fixture table ────────────────────────────────────────────────────────────
// exact: the algorithm's kana anchors make the split deterministic — pin it.
// invariant-only: unanchored multi-kanji runs split proportionally; the split is
// a display heuristic but the reading must still round-trip in full.
const FIXTURES = [
  // all-kana: identity mapping
  { word: 'さくら', reading: 'さくら', exact: [seg('さ', 'さ'), seg('く', 'く'), seg('ら', 'ら')] },
  // okurigana: kana anchor bounds the kanji reading
  { word: '食べる', reading: 'たべる', exact: [seg('食', 'た'), seg('べ', 'べ'), seg('る', 'る')] },
  { word: '聞く', reading: 'きく', exact: [seg('聞', 'き'), seg('く', 'く')] },
  // adjective with the anchor kana appearing only at its true position
  { word: '冷たい', reading: 'つめたい', exact: [seg('冷', 'つめ'), seg('た', 'た'), seg('い', 'い')] },
  // kana anchors BETWEEN two kanji runs
  { word: '引き出し', reading: 'ひきだし', exact: [seg('引', 'ひ'), seg('き', 'き'), seg('出', 'だ'), seg('し', 'し')] },
  { word: '焼き肉', reading: 'やきにく', exact: [seg('焼', 'や'), seg('き', 'き'), seg('肉', 'にく')] },
  // leading kana (honorific o-)
  { word: 'お金', reading: 'おかね', exact: [seg('お', 'お'), seg('金', 'かね')] },
  // interior 2-kanji run bounded by a trailing kana anchor: even split
  { word: '気持ち', reading: 'きもち', exact: [seg('気', 'き'), seg('持', 'も'), seg('ち', 'ち')] },
  // kana anchor inside a longer word
  { word: '生け花', reading: 'いけばな', exact: [seg('生', 'い'), seg('け', 'け'), seg('花', 'ばな')] },
  // sokuon anchor
  { word: '引っ越し', reading: 'ひっこし', exact: [seg('引', 'ひ'), seg('っ', 'っ'), seg('越', 'こ'), seg('し', 'し')] },
  // ── unanchored multi-kanji runs: proportional heuristic, invariant only ──
  { word: '勉強', reading: 'べんきょう' },   // true split べん/きょう; heuristic gives べんき/ょう
  { word: '図書館', reading: 'としょかん' }, // true と/しょ/かん
  { word: '今日', reading: 'きょう' },       // jukujikun — no per-kanji reading exists
  { word: '大人', reading: 'おとな' },       // jukujikun
  { word: '昨日', reading: 'きのう' },       // jukujikun
  { word: '一人', reading: 'ひとり' },       // jukujikun
  { word: '日々', reading: 'ひび' },         // iteration mark 々 treated as kanji
  { word: '飛行機', reading: 'ひこうき' },   // heteronym-prone compound
];

console.log('reconstruction invariant (word + full reading round-trip):');
for (const { word, reading } of FIXTURES) {
  const segs = buildFuriganaMap(word, reading);
  const wordBack = segs.map((s) => s.kanji).join('');
  const kanaBack = segs.map((s) => s.kana).join('');
  check(`${word} → word round-trips`, wordBack === word, `got «${wordBack}»`);
  check(`${word}/${reading} → reading round-trips`, kanaBack === reading, `got «${kanaBack}» (${show(segs)})`);
}

console.log('exact splits (kana-anchored shapes):');
for (const { word, reading, exact } of FIXTURES) {
  if (!exact) continue;
  const segs = buildFuriganaMap(word, reading);
  const ok = segs.length === exact.length && segs.every((s, i) => s.kanji === exact[i].kanji && s.kana === exact[i].kana);
  check(`${word}/${reading}`, ok, `expected «${show(exact)}», got «${show(segs)}»`);
}

console.log(failed === 0
  ? `\x1b[1m${passed} passed, 0 failed\x1b[0m`
  : `\x1b[1m\x1b[31m${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
