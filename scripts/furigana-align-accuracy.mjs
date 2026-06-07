/**
 * Per-kanji furigana ALIGNMENT accuracy harness.
 *
 * Bundles the real shipped aligner (src/services/furigana.ts → alignReading,
 * with its generated reading tables) and validates it against JmdictFurigana —
 * the gold-standard per-kanji furigana dataset (~226k words with kanji). Reports:
 *
 *   - correct per-kanji splits     (we agree with the gold segmentation)
 *   - WRONG splits                 (we emit a split that differs from gold)
 *   - group fallback               (we defer to whole-word reading; = safe)
 *
 * Usage: node scripts/furigana-align-accuracy.mjs
 *
 * JmdictFurigana.txt is cached under /tmp; downloaded on first run.
 */
import esbuild from 'esbuild';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';

const FURI_URL =
  'https://github.com/Doublevil/JmdictFurigana/releases/download/2.3.1%2B2026-05-25/JmdictFurigana.txt';
const TMP_BUNDLE = '.tmp_align_harness.mjs';

const isKana = (c) => /[぀-ゟ゠-ヿ]/.test(c);
const isKanji = (c) => /[一-龯㐀-䶿]/.test(c);
const isKatakana = (c) => /[゠-ヿ]/.test(c);

async function goldText() {
  const tmp = '/tmp/JmdictFurigana.txt';
  if (existsSync(tmp)) return readFileSync(tmp, 'utf8');
  console.log('downloading JmdictFurigana.txt …');
  const res = await fetch(FURI_URL);
  if (!res.ok) throw new Error(`fetch: ${res.status}`);
  const text = await res.text();
  writeFileSync(tmp, text);
  return text;
}

// Bundle the real aligner (pulls in the generated data via its dynamic imports).
await esbuild.build({
  entryPoints: ['src/services/furigana.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: TMP_BUNDLE,
  logLevel: 'silent',
});
const { alignReading, loadReadingData } = await import(pathToFileURL(TMP_BUNDLE).href);
await loadReadingData();

// Parse gold per-character readings; returns null for grouped (unsplittable) entries.
function goldSegments(word, furi) {
  const chars = [...word];
  const seg = {};
  let grouped = false;
  for (const part of furi.split(';')) {
    const [idx, r] = part.split(':');
    if (idx.includes('-')) grouped = true;
    else seg[+idx] = r;
  }
  if (grouped) return null;
  const arr = chars.map((c, i) => (i in seg ? seg[i] : isKana(c) ? c : null));
  return arr.some((x) => x == null) ? null : arr;
}

const lines = (await goldText()).split('\n');
let total = 0,
  correct = 0,
  wrong = 0,
  grouped = 0;
const wrongSamples = [];

for (const line of lines) {
  if (!line) continue;
  const [word, reading, furi] = line.split('|');
  if (!word || !reading || !furi) continue;
  const chars = [...word];
  if (chars.length < 2 || !chars.some(isKanji) || ![...reading].every(isKana)) continue;
  // The app normalizes readings to hiragana and tokenizes katakana runs (loanwords,
  // mimetics) as their own non-kanji tokens, so katakana surfaces/readings never
  // reach alignReading. Skip them here to mirror production.
  if ([...word].some(isKatakana) || [...reading].some(isKatakana)) continue;
  total++;

  const got = alignReading(word, reading);
  // A "split" is per-character (every segment is a single char). Otherwise it's a
  // group/run fallback — counted as safe, not wrong.
  const isSplit = got.length === chars.length && got.every((s) => [...s.kanji].length === 1);
  if (!isSplit) {
    grouped++;
    continue;
  }
  const gold = goldSegments(word, furi);
  if (gold && got.every((s, i) => s.kana === gold[i])) {
    correct++;
  } else {
    wrong++;
    if (wrongSamples.length < 25)
      wrongSamples.push(`${word}|${reading} got[${got.map((s) => s.kana)}] gold[${gold || 'GROUP'}]`);
  }
}

rmSync(TMP_BUNDLE, { force: true });

const pct = (n) => ((100 * n) / total).toFixed(3);
console.log('=== alignReading vs JmdictFurigana gold (words with kanji) ===');
console.log('total          :', total);
console.log('correct split  :', correct, `(${pct(correct)}%)`);
console.log('WRONG split    :', wrong, `(${pct(wrong)}%)`);
console.log('group fallback :', grouped, `(${pct(grouped)}%)  [safe — whole-word reading]`);
console.log('');
console.log('--- spot checks ---');
for (const [w, r] of [
  ['手当て', 'てあて'],
  ['病院', 'びょういん'],
  ['大統領', 'だいとうりょう'],
  ['入り口', 'いりぐち'],
  ['今日', 'きょう'],
]) {
  console.log(`  ${w}|${r} ->`, JSON.stringify(alignReading(w, r)));
}
if (wrong > 0) {
  console.log('\n--- sample WRONG ---');
  wrongSamples.forEach((s) => console.log('  ' + s));
}
process.exit(wrong / total > 0.005 ? 1 : 0); // fail if >0.5% wrong
