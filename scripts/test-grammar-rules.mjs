/**
 * Grammar rule harness (#43, phase 0).
 *
 *   node scripts/test-grammar-rules.mjs [--ninjal <ninjal.json>] [--paras <paras.json>] [--report <out.md>]
 *
 * Bundles src/services/grammar/{engine,rules}.ts with esbuild (as test-srs.mjs
 * does), tokenizes with the app's kuromoji dictionary, then:
 *   1. Fixtures: hand-written positives (with the expected marked text) and
 *      negatives per rule. Any failure exits non-zero.
 *   2. NINJAL recall (optional): every example sentence of the matching NINJAL
 *      headword marks the point in ｛｝; a hit is a match overlapping that span.
 *      ninjal.json comes from scripts/grammar/ninjal_parse.py.
 *   3. Coverage audit (optional): how often each rule fires over stored article
 *      paragraphs (a JSON array of strings), with sampled hits to check by eye.
 */
import esbuild from 'esbuild';
import { pathToFileURL } from 'node:url';
import { rmSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));

const TMP = path.join('scripts', '.tmp-grammar-bundle.mjs');
await esbuild.build({
  stdin: { contents: "export * from './src/services/grammar/engine.ts'; export * from './src/services/grammar/rules.ts';", resolveDir: '.', loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', outfile: TMP, logLevel: 'silent',
});
const { findGrammar, STARTER_RULES } = await import(pathToFileURL(path.resolve(TMP)).href);
rmSync(TMP);

const kuromoji = createRequire(import.meta.url)('@sglkc/kuromoji');
const tokenizer = await new Promise((res, rej) => kuromoji.builder({ dicPath: 'public/kuromoji-dict/' }).build((e, t) => (e ? rej(e) : res(t))));
const run = (text) => findGrammar(tokenizer.tokenize(text), STARTER_RULES);

// ── 1. Fixtures ───────────────────────────────────────────────────────────────
// [sentence, expected marked text] for positives; sentence only for negatives.
const FIXTURES = {
  te_iru: { pos: [['本を読んでいます。', 'でいます'], ['若い人たちが住み始めています。', 'ています'], ['雨が降っていた。', 'ていた']], neg: ['ここで待つ。', '家にいます。'] },
  te_ru: { pos: [['テレビを見てる。', 'てる'], ['何読んでるの？', 'でる'], ['えさをあげてます。', 'てます']], neg: ['見ている。'] },
  te_shimau: { pos: [['財布を忘れてしまった。', 'てしまった'], ['全部食べてしまいます。', 'てしまいます']], neg: ['店を閉める。'] },
  chau: { pos: [['ケーキ食べちゃった。', 'ちゃった']], neg: ['食べてしまった。'] },
  te_oku: { pos: [['準備しておきます。', 'ておきます']], neg: ['本を置く。'] },
  toku: { pos: [['メモ書いとく。', 'とく']], neg: [] },
  te_aru: { pos: [['窓が開けてある。', 'てある'], ['名前が書いてあります。', 'てあります']], neg: ['机の上にある。'] },
  nakereba_naranai: {
    pos: [['住む前に直さなければなりません。', 'なければなりません'], ['明日は早く起きなければならない。', 'なければならない'], ['行かなくてはいけない。', 'なくてはいけない'], ['薬を飲まないといけない。', 'ないといけない']],
    pos2: [['会場は広くなければならない。', 'なければならない'], ['健康でなくてはならない。', 'なくてはならない'], ['本人でないといけない。', 'ないといけない']],
    neg: ['行かなければ、分からない。', 'もし雨が降らなければ行く。'],
  },
  nakya: { pos: [['もう行かなきゃ。', 'なきゃ'], ['宿題しなきゃいけない。', 'なきゃいけない']], neg: [] },
  tai: { pos: [['京都に行きたい。', 'たい'], ['何が食べたいですか。', 'たいです'], ['静かな暮らしをしたいと言っています。', 'たい']], neg: ['冷たい水。'] },
  nagara: { pos: [['音楽を聞きながら勉強する。', 'ながら']], neg: [] },
  koto_ga_dekiru: { pos: [['お茶を飲むことができる。', 'ことができる'], ['ここで写真を撮ることができます。', 'ことができます']], neg: ['大事なことができた。'] },
  mae_ni: { pos: [['寝る前に歯をみがく。', '前に'], ['食事の前に手を洗う。', '前に']], neg: ['駅の前に立つ。'] },
  te_kara: { pos: [['宿題をしてから遊ぶ。', 'てから']], neg: ['駅から歩く。'] },
  node: { pos: [['古い家は冬が寒いので、直す。', 'ので'], ['雨なので、行きません。', 'ので']], neg: [] },
  te_mo_ii: { pos: [['写真を撮ってもいいですか。', 'てもいいです'], ['狭くてもいいです。', 'てもいいです']], neg: ['見てもらう。'] },
  te_wa_ikenai: { pos: [['ここで泳いではいけません。', 'ではいけません'], ['嘘をついてはならない。', 'てはならない'], ['データは古くてはいけない。', 'てはいけない']], neg: ['見てはどうですか。', 'ここではいけない。'] },
  cha_ikenai: { pos: [['ここで写真を撮っちゃいけない。', 'ちゃいけない'], ['ジーンズじゃいけない。', 'じゃいけない']], neg: ['これじゃない。'] },
  kamoshirenai: { pos: [['雨が降るかもしれません。', 'かもしれません'], ['彼は来ないかもしれない。', 'かもしれない']], neg: [] },
  souda_hearsay: { pos: [['この家を選んだそうです。', 'そうです'], ['明日は雨が降るそうだ。', 'そうだ'], ['あの店は高いそうです。', 'そうです'], ['部長は遅れるそうなので、始めましょう。', 'そうな']], neg: ['雨が降りそうだ。', '美味しそうなケーキ。', '高いそうな店。'] },
  souda_looks: { pos: [['雨が降りそうだ。', 'そうだ'], ['美味しそうなケーキ。', 'そうな'], ['元気そうです。', 'そうです']], neg: ['この家を選んだそうです。', 'あの店は高いそうです。'] },
};

let passed = 0, failed = 0;
const fail = (msg) => { failed++; console.log('  ✗ ' + msg); };
console.log('Fixtures');
for (const [id, { pos, pos2 = [], neg }] of Object.entries(FIXTURES)) {
  for (const [s, want] of [...pos, ...pos2]) {
    const got = run(s).filter((m) => m.id === id).map((m) => s.slice(m.start, m.end));
    got.includes(want) ? passed++ : fail(`${id}: 「${s}」 want 「${want}」, got ${JSON.stringify(got)}`);
  }
  for (const s of neg) {
    const got = run(s).filter((m) => m.id === id).map((m) => s.slice(m.start, m.end));
    got.length === 0 ? passed++ : fail(`${id}: 「${s}」 should not match, got ${JSON.stringify(got)}`);
  }
}
const ruleIds = STARTER_RULES.map((r) => r.id);
const untested = ruleIds.filter((id) => !FIXTURES[id]);
if (untested.length) fail(`rules with no fixtures: ${untested.join(', ')}`);
console.log(`  ${passed} passed, ${failed} failed`);

const report = [];

// ── 2. NINJAL recall ──────────────────────────────────────────────────────────
// rule id → NINJAL headwords (and an optional sense-category filter).
const NINJAL_MAP = {
  te_iru: ['ている'], te_ru: ['てる'], te_shimau: ['てしまう'], chau: ['ちゃう'], te_oku: ['ておく'], toku: ['とく'], te_aru: ['てある'],
  nakereba_naranai: ['なければならない', 'なければいけない', 'なくてはならない', 'なくてはいけない', 'ないといけない'],
  nakya: ['なきゃ', 'なきゃいけない', 'なきゃならない'], tai: ['たい'], nagara: ['ながら|同時'], koto_ga_dekiru: ['ことができる'],
  mae_ni: ['前に'], te_kara: ['てから'], node: ['ので'], te_mo_ii: ['てもいい'], te_wa_ikenai: ['てはいけない', 'てはならない'], cha_ikenai: ['ちゃいけない', 'じゃいけない'],
  kamoshirenai: ['かもしれない'], souda_hearsay: ['そうだ|伝聞'], souda_looks: ['そうだ|様子', 'そうだ|直前の様子', 'そうだ|予想'],
};
if (args.ninjal) {
  const ninjal = JSON.parse(readFileSync(args.ninjal, 'utf8'));
  const norm = (p) => p.replace(/[～〜]/g, '');
  console.log('\nNINJAL recall (example sentences whose ｛marked｝ point the rule finds)');
  report.push('## NINJAL recall\n', '| Rule | Found | Examples | Recall |', '| --- | --- | --- | --- |');
  const misses = [];
  for (const [id, heads] of Object.entries(NINJAL_MAP)) {
    let hit = 0, total = 0;
    for (const h of heads) {
      const [head, cat] = h.split('|');
      for (const e of ninjal.filter((x) => norm(x.pattern) === head)) {
        for (const s of e.senses.filter((x) => !cat || x.category.endsWith(cat))) {
          for (const ex of s.connections.flatMap((c) => c.examples)) {
            // Strip speaker quotes etc. but keep the braces' position.
            const start = ex.indexOf('｛');
            if (start < 0) continue;
            const end = ex.indexOf('｝', start) - 1;
            const plain = ex.replace(/[｛｝]/g, '');
            total++;
            const found = run(plain).some((m) => m.id === id && m.start < end && start < m.end);
            if (found) hit++;
            else misses.push(`${id}: ${ex}`);
          }
        }
      }
    }
    const pct = total ? Math.round((100 * hit) / total) : 0;
    console.log(`  ${id.padEnd(18)} ${String(hit).padStart(3)}/${String(total).padEnd(3)} ${pct}%`);
    report.push(`| ${id} | ${hit} | ${total} | ${pct}% |`);
  }
  report.push('', '### Misses', '', ...misses.map((m) => `- ${m}`), '');
}

// ── 3. Coverage audit over stored articles ────────────────────────────────────
if (args.paras) {
  const paras = JSON.parse(readFileSync(args.paras, 'utf8'));
  const counts = Object.fromEntries(ruleIds.map((id) => [id, 0]));
  const samples = Object.fromEntries(ruleIds.map((id) => [id, []]));
  let chars = 0;
  for (const p of paras) {
    chars += p.length;
    for (const m of run(p)) {
      counts[m.id]++;
      // Reservoir-ish: keep every k-th hit so samples spread across the corpus.
      if (samples[m.id].length < 8 && counts[m.id] % 3 === 1) {
        samples[m.id].push(`${p.slice(Math.max(0, m.start - 14), m.start)}【${p.slice(m.start, m.end)}】${p.slice(m.end, m.end + 10)}`);
      }
    }
  }
  console.log(`\nCoverage over ${paras.length} paragraphs (${chars.toLocaleString()} chars)`);
  report.push(`## Coverage over ${paras.length} stored paragraphs (${chars.toLocaleString()} chars)\n`, '| Rule | Hits | Per 10k chars |', '| --- | --- | --- |');
  for (const id of ruleIds.sort((a, b) => counts[b] - counts[a])) {
    const per = ((counts[id] * 10000) / chars).toFixed(1);
    console.log(`  ${id.padEnd(18)} ${String(counts[id]).padStart(5)}  ${per}/10k`);
    report.push(`| ${id} | ${counts[id]} | ${per} |`);
  }
  report.push('', '### Sampled hits (check by eye for false positives)', '');
  for (const id of ruleIds) if (samples[id].length) report.push(`**${id}**`, '', ...samples[id].map((s) => `- ${s}`), '');
}

if (args.report) writeFileSync(args.report, `# Grammar rules: phase 0 report\n\nGenerated by \`scripts/test-grammar-rules.mjs\`. Example sentences quoted under NINJAL recall are from 日本語文型データベース (NINJAL), CC BY 4.0.\n\n${report.join('\n')}\n`);
process.exit(failed ? 1 : 0);
