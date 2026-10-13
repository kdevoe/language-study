/**
 * Grammar rule harness (#43).
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
  stdin: {
    contents: "export * from './src/services/grammar/engine.ts'; export * from './src/services/grammar/rules.ts'; export * from './src/services/grammar/catalogue.ts';",
    resolveDir: '.', loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', outfile: TMP, logLevel: 'silent',
});
const { findGrammar, STARTER_RULES, GRAMMAR_POINTS } = await import(pathToFileURL(path.resolve(TMP)).href);
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

  // Phase 1.
  te_kudasai: { pos: [['ここに座ってください。', 'てください'], ['名前を書いてくださいませんか。', 'てくださいませんか']], neg: ['先生が教えてくださった。', '先生が教えてくださいました。', '触らないでください。'] },
  naide_kudasai: { pos: [['触らないでください。', 'ないでください']], neg: ['ここに座ってください。'] },
  mashou: { pos: [['一緒に行きましょう。', 'ましょう'], ['手伝いましょうか。', 'ましょうか']], neg: ['一緒に行こう。'] },
  masenka: { pos: [['映画を見に行きませんか。', 'ませんか']], neg: ['行きません。'] },
  nasai: { pos: [['早く寝なさい。', 'なさい']], neg: [] },
  hou_ga_ii: { pos: [['早く寝たほうがいい。', 'ほうがいい'], ['無理しないほうがいいです。', 'ほうがいいです']], neg: ['東の方が好きだ。'] },
  ba_ii: { pos: [['どうすればいいですか。', 'ばいいです'], ['どこに行ったらいいですか。', 'たらいいです']], neg: ['安ければ買う。'] },
  te_hoshii: { pos: [['早く来てほしい。', 'てほしい']], neg: ['新しい車がほしい。'] },
  tagaru: { pos: [['子どもは外に行きたがる。', 'たがる']], neg: ['京都に行きたい。'] },
  tsumori: { pos: [['来年行くつもりです。', 'つもりです'], ['買わないつもりだ。', 'つもりだ']], neg: [] },
  volitional: { pos: [['一緒に行こう。', 'う'], ['今日は早く寝よう。', 'う']], neg: ['一緒に行きましょう。', '明日は晴れるだろう。'] },
  you_to_omou: { pos: [['明日は早く起きようと思う。', 'うと'], ['留学しようと考えている。', 'うと']], neg: ['いいと思います。'] },
  koto_ni_suru: { pos: [['留学することにした。', 'ことにした'], ['毎日歩くことにしています。', 'ことにし']], neg: [] },
  koto_ni_naru: { pos: [['転勤することになった。', 'ことになった']], neg: ['大事なことになった。'] },
  ta_koto_ga_aru: { pos: [['京都に行ったことがある。', 'ことがある'], ['読んだことがない。', 'ことがない']], neg: ['時々映画を見ることがある。'] },
  ru_koto_ga_aru: { pos: [['時々映画を見ることがある。', 'ことがある'], ['母は不機嫌なことがある。', 'ことがある']], neg: ['京都に行ったことがある。'] },
  you_ni_naru: { pos: [['日本語が話せるようになった。', 'ようになった'], ['よく眠れるようになりました。', 'ようになりました']], neg: ['忘れないように書く。'] },
  you_ni_suru: { pos: [['毎日歩くようにしている。', 'ようにし']], neg: ['日本語が話せるようになった。'] },
  you_ni: { pos: [['忘れないように書く。', 'ように'], ['よく見えるように前に座る。', 'ように'], ['食べやすいように小さく切る。', 'ように']], neg: ['鳥のように飛ぶ。', '前に述べたように、増えた。', '日本語が話せるようになった。'] },
  te_miru: { pos: [['この服を着てみる。', 'てみる'], ['食べてみました。', 'てみました']], neg: ['テレビを見る。'] },
  te_ageru: { pos: [['妹に本を買ってあげた。', 'てあげた']], neg: ['プレゼントをあげた。'] },
  te_kureru: { pos: [['友達が教えてくれた。', 'てくれた'], ['先生が教えてくださった。', 'てくださった'], ['先生が教えてくださいました。', 'てくださいました']], neg: ['ここに座ってください。'] },
  te_morau: { pos: [['先生に見てもらう。', 'てもらう'], ['説明していただきました。', 'ていただきました']], neg: ['手紙をもらう。'] },
  te_iku: { pos: [['鳥が飛んでいく。', 'でいく'], ['人口は減っていきます。', 'ていきます']], neg: ['学校に行く。'] },
  te_kuru: { pos: [['寒くなってきた。', 'てきた'], ['雨が降ってくる。', 'てくる']], neg: ['友達が来る。'] },
  hajimeru: { pos: [['雨が降り始めた。', '始めた']], neg: ['会議を始めた。'] },
  owaru: { pos: [['レポートを書き終わる。', '終わる'], ['本を読み終えた。', '終えた']], neg: ['授業が終わる。'] },
  tsuzukeru: { pos: [['一時間歩き続ける。', '続ける']], neg: ['勉強を続ける。'] },
  dasu: { pos: [['子どもが泣き出した。', '出した']], neg: ['手紙を出した。'] },
  sugiru: { pos: [['昨日は食べすぎた。', 'すぎた'], ['値段が高すぎる。', 'すぎる']], neg: [] },
  yasui: { pos: [['この本は読みやすい。', 'やすい']], neg: ['この店は安い。'] },
  nikui: { pos: [['この説明は分かりにくい。', 'にくい']], neg: [] },
  ni_iku: { pos: [['本を買いに行く。', 'に'], ['友達が映画を見に来た。', 'に']], neg: ['学校に行く。', '彼らは仕事に戻る。'] },
  causative: { pos: [['子どもに野菜を食べさせる。', 'させる'], ['弟を買い物に行かせた。', 'せ']], neg: ['車を止める。'] },
  passive: { pos: [['車が壊された。', 'れ'], ['先生に褒められた。', 'られ']], neg: ['この水は飲める。'] },
  tara: { pos: [['雨が降ったら行かない。', 'たら'], ['読んだら返して。', 'だら']], neg: [] },
  ba: { pos: [['安ければ買う。', 'ば'], ['行かなければ、分からない。', 'ば']], neg: ['住む前に直さなければなりません。', 'どうすればいいですか。'] },
  to_cond: { pos: [['春になると暖かくなる。', 'と'], ['ボタンを押すと、開く。', 'と']], neg: ['友達と話す。', 'いいと思います。', '薬を飲まないといけない。', 'ニュースによると、地震があった。', '規則を守っていると話しています。'] },
  nara: { pos: [['行くなら早く。', 'なら'], ['京都ならよく知っている。', 'なら']], neg: ['行かなければならない。'] },
  te_mo: { pos: [['雨が降っても行く。', 'ても'], ['高くても買う。', 'ても']], neg: ['写真を撮ってもいいですか。'] },
  nakute_mo_ii: { pos: [['明日は来なくてもいい。', 'なくてもいい']], neg: ['写真を撮ってもいいですか。'] },
  kara: { pos: [['寒いから帰る。', 'から']], neg: ['駅から歩く。', '宿題をしてから遊ぶ。'] },
  kedo: { pos: [['高いけど買う。', 'けど'], ['行きたいけれど、時間がない。', 'けれど']], neg: [] },
  ga_but: { pos: [['行きたいが、時間がない。', 'が']], neg: ['雨が降る。'] },
  noni: { pos: [['行ったのに会えなかった。', 'のに']], neg: [] },
  shi: { pos: [['安いし、近い。', 'し']], neg: ['掃除をし、洗濯する。'] },
  tari: { pos: [['掃除したり洗濯したりする。', 'たり'], ['本を読んだりする。', 'だり']], neg: [] },
  naide: { pos: [['朝ご飯を食べないで出かけた。', 'ないで']], neg: ['触らないでください。'] },
  zu_ni: { pos: [['何も言わずに帰った。', 'ずに']], neg: [] },
  toki: { pos: [['子どものとき、よく遊んだ。', 'とき'], ['暇な時に読む。', '時に'], ['雨が降る時は家にいる。', '時は']], neg: ['その時間はない。'] },
  ta_ato_de: { pos: [['食べたあとで散歩する。', 'あとで'], ['会議の後で話す。', '後で']], neg: ['あとで電話する。'] },
  ta_bakari: { pos: [['日本に来たばかりです。', 'ばかりです']], neg: ['肉ばかり食べる。'] },
  tokoro: { pos: [['今から出かけるところです。', 'ところです'], ['今、着いたところだ。', 'ところだ']], neg: ['静かなところに住む。'] },
  ta_mama: { pos: [['電気をつけたまま寝た。', 'まま'], ['靴のまま入った。', 'まま'], ['熱いまま食べる。', 'まま']], neg: [] },
  darou: { pos: [['明日は晴れるだろう。', 'だろう'], ['明日は晴れるでしょう。', 'でしょう']], neg: ['一緒に行こう。'] },
  hazu: { pos: [['もう着いたはずだ。', 'はずだ']], neg: [] },
  mitai: { pos: [['雨みたいです。', 'みたいです'], ['子どもみたいに笑う。', 'みたいに']], neg: [] },
  rashii: { pos: [['彼は医者らしい。', 'らしい']], neg: [] },
  you_da: { pos: [['誰もいないようだ。', 'ようだ'], ['鳥のように飛ぶ。', 'ように'], ['そのような問題。', 'ような']], neg: ['忘れないように書く。'] },
  no_da: { pos: [['どうして遅れたんですか。', 'んです'], ['これは大事なのです。', 'のです']], neg: ['これは私のです。'] },
  to_iu: { pos: [['田中という人。', 'という'], ['多くの人が住んでいるという。', 'と'], ['規則を守っていると話しています。', 'と']], neg: ['友達と話す。'] },
  you_to_suru: { pos: [['空を飛ぼうとした。', 'うとした'], ['国境を渡ろうとしています。', 'うとし']], neg: ['一緒に行こう。'] },
  to_omou: { pos: [['いいと思います。', 'と'], ['問題があると考えている。', 'と'], ['「大丈夫」と思った。', 'と']], neg: ['明日は早く起きようと思う。', '友達と考える。'] },
  ka_dou_ka: { pos: [['行くかどうか分からない。', 'かどうか']], neg: [] },
  shika: { pos: [['千円しかない。', 'しか']], neg: [] },
  tame: { pos: [['健康のために走る。', 'ために'], ['雨が降ったため、中止した。', 'ため']], neg: [] },
  sa: { pos: [['この部屋の広さ。', 'さ'], ['町の静かさが好きだ。', 'さ']], neg: [] },
  ni_yoru_to: { pos: [['ニュースによると、地震があった。', 'によると'], ['報道によれば、増えた。', 'によれば']], neg: ['地域によって違う。'] },
  ni_tsuite: { pos: [['環境について話す。', 'について']], neg: [] },
  to_shite: { pos: [['代表として参加する。', 'として']], neg: [] },
  ni_yotte: { pos: [['地域によって違う。', 'によって'], ['専門家による調査。', 'による']], neg: [] },
  ni_taishite: { pos: [['質問に対して答える。', 'に対して']], neg: [] },
  ni_totte: { pos: [['私にとって大切だ。', 'にとって']], neg: [] },
  ni_kanshite: { pos: [['経済に関して話す。', 'に関して']], neg: [] },
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
// Every rule needs a catalogue entry (the panel has nothing to show otherwise), and
// every catalogue example must mark its point and be found by its own rule.
const noEntry = ruleIds.filter((id) => !GRAMMAR_POINTS[id]);
if (noEntry.length) fail(`rules with no catalogue entry: ${noEntry.join(', ')}`);
for (const p of Object.values(GRAMMAR_POINTS)) {
  if (p.partner && !GRAMMAR_POINTS[p.partner]) fail(`${p.id}: partner ${p.partner} not in the catalogue`);
  if (!ruleIds.includes(p.id)) continue;
  for (const { ja } of p.examples) {
    const start = ja.indexOf('【');
    const end = ja.indexOf('】') - 1;
    if (start < 0 || end < start) { fail(`${p.id}: example 「${ja}」 has no 【】`); continue; }
    const plain = ja.replace(/[【】]/g, '');
    run(plain).some((m) => m.id === p.id && m.start < end && start < m.end) ? passed++ : fail(`${p.id}: catalogue example 「${ja}」 not found`);
  }
}
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
  te_kudasai: ['てください'], naide_kudasai: ['ないでください'], mashou: ['ましょう'], masenka: ['ませんか'], nasai: ['なさい'],
  hou_ga_ii: ['ほうがいい'], ba_ii: ['たらいい'], te_hoshii: ['てほしい'], tsumori: ['つもりだ|意志'], volitional: ['う・よう'],
  you_to_omou: ['うと思う・ようと思う'], you_to_suru: ['うとする・ようとする'], koto_ni_suru: ['ことにする'], ta_koto_ga_aru: ['ことがある|経験'], ru_koto_ga_aru: ['ことがある|時々'],
  you_ni_naru: ['ようになる'], you_ni_suru: ['ようにする'], you_ni: ['ように|目的'], te_miru: ['てみる'], te_ageru: ['てあげる'],
  te_kureru: ['てくれる'], te_morau: ['てもらう'], te_iku: ['ていく'], te_kuru: ['てくる'], hajimeru: ['始める'], owaru: ['終わる', '終える'],
  tsuzukeru: ['つづける'], dasu: ['出す'], sugiru: ['すぎる'], yasui: ['やすい'], nikui: ['にくい'], ni_iku: ['に|目的'],
  causative: ['せる・させる'], passive: ['れる・られる'], tara: ['たら|仮定', 'たら|反事実', 'たら|後'], to_cond: ['と|必然', 'と|反復・習慣', 'と|前置き'],
  nara: ['なら'], te_mo: ['ても'], nakute_mo_ii: ['なくてもいい'], kara: ['から|原因・理由'], ga_but: ['が|逆接', 'が|対比', 'が|前置き・注釈'],
  noni: ['のに|予想外'], shi: ['し'], tari: ['たりたり'], naide: ['ないで'], zu_ni: ['ずに'], toki: ['とき'], ta_ato_de: ['後で'],
  tokoro: ['ところだ'], ta_mama: ['まま'], darou: ['でしょう'], hazu: ['はずだ'], mitai: ['みたいだ'], rashii: ['らしい'], you_da: ['ようだ'],
  no_da: ['のだ'], to_iu: ['というN'], ka_dou_ka: ['かどうか'], shika: ['しかない|限定'], tame: ['ため', 'ために'],
  ni_yoru_to: ['によると', 'によれば'], ni_tsuite: ['について'], to_shite: ['として'], ni_yotte: ['によって'], ni_taishite: ['に対して'],
  ni_totte: ['にとって'], ni_kanshite: ['に関して'],
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

if (args.report) writeFileSync(args.report, `# Grammar rules report\n\nGenerated by \`scripts/test-grammar-rules.mjs\`. Example sentences quoted under NINJAL recall are from 日本語文型データベース (NINJAL), CC BY 4.0.\n\n${report.join('\n')}\n`);
process.exit(failed ? 1 : 0);
