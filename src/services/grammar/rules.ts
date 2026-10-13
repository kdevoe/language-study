/**
 * Grammar rules (#43): the N5/N4 points, the casual forms that come for free
 * from the tokenizer, and a few N3 staples of news writing. Ids match docs/grammar-plan.md and, later,
 * grammar_points.id. Tested by scripts/test-grammar-rules.mjs.
 *
 * Lean on part of speech and conjugation form, not the head word's lemma: kuromoji
 * misreads some lemmas (降り → 降りる) and its tags aren't always right (hearsay
 * 高いそう comes out 名詞/接尾, the "looks like" tag).
 */
import type { GrammarRule, Step } from './engine';

// ── Shared steps ──────────────────────────────────────────────────────────────

/** A verb (or adjective) the point attaches to: context, not marked. */
const verb = (cform?: string | string[]): Step => ({ pos: '動詞', cform, mark: false });
/** The て/で that joins a verb to a helper (not the place/means particle で). */
const te: Step = { surface: ['て', 'で'], pos: '助詞', pos1: '接続助詞' };
/** Trailing auxiliaries that belong to the point's span: ます, ません, た, ない… */
const tail: Step = { pos: '助動詞', star: true };
/** The ない of 〜なければ…: an auxiliary after verbs and で, an adjective after 〜く. */
const nai = { lemma: 'ない', pos: ['助動詞', '形容詞'] };
/** A negative ending: ない, or ませ + ん. */
const neg: Step = { any: [[{ lemma: 'ない', pos: '助動詞' }], [{ lemma: 'ます' }, { lemma: 'ん' }]] };
/** だ / です / な — the copula after そう. */
const copula: Step = { pos: '助動詞', lemma: ['だ', 'です'] };
/** A plain-form ending the point attaches to: a verb, adjective or auxiliary (た, ない). Context. */
const plain = (cform?: string | string[]): Step => ({ pos: ['動詞', '形容詞', '助動詞'], cform, mark: false });
/** The past た / だ, as context. */
const ta: Step = { pos: '助動詞', ctype: '特殊・タ', cform: '基本形', mark: false };
/** The conditional たら / だら. */
const tara: Step = { pos: '助動詞', ctype: '特殊・タ', cform: '仮定形' };
/** A verb in the dictionary form, or a negative ない: the "will do / won't do" before よう, こと. */
const willDo: Step = { any: [[{ pos: '動詞', cform: '基本形' }], [{ lemma: ['ない', 'ぬ'], pos: '助動詞', cform: '基本形' }]], mark: false };
/** Any plain non-past ending, or な / の before a noun-like word: 高い, 不便な, 偽物の. Context. */
const nonPast: Step = {
  any: [[{ pos: ['動詞', '形容詞', '助動詞'], cform: ['基本形', '体言接続'], not: { ctype: '特殊・タ' } }], [{ surface: 'の', pos1: '連体化' }]],
  mark: false,
};
/** いい / よい / 良い. */
const good: Step = { lemma: ['いい', 'よい', '良い', 'よろしい', '宜しい'] };
/** A verb stem helper: 降り|始める, 書き|終わる. */
const auxVerb = (lemma: string[]): Step[] => [verb('連用'), { lemma, pos: '動詞', pos1: '非自立' }, tail];
/** Verbs (and する nouns) of saying, after a quoting と. */
const SAYING = ['いう', '言う', '話す', '述べる', '語る', '伝える', '書く', '答える', '説明', '発表', '主張', '報告', '強調', '指摘'];
/** What a quoting と follows: a clause ending (守っている, 大切だ) or a closing 」, not a noun (友達と話す). */
const quoted: Step = { any: [[{ pos: ['動詞', '形容詞', '助動詞'] }], [{ pos: '記号', pos1: '括弧閉' }]], mark: false };
/** One particle token, by surface. */
const particle = (surface: string | string[], pos1?: string | string[]): Step => ({ surface, pos: '助詞', pos1 });

export const STARTER_RULES: GrammarRule[] = [
  // 〜ている: ongoing action or resulting state. 読んでいます, 住み始めている.
  { id: 'te_iru', steps: [verb(), te, { lemma: 'いる', pos1: '非自立' }, tail] },
  // 〜てる (casual 〜ている): 見てる, 読んでる; polite 勤めてます (て + ます, い dropped).
  {
    id: 'te_ru',
    steps: [verb(), { any: [[{ lemma: ['てる', 'でる'], pos1: '非自立' }], [te, { lemma: 'ます', pos: '助動詞' }]] }, tail],
  },

  // 〜てしまう: completion / regret.
  { id: 'te_shimau', steps: [verb(), te, { lemma: 'しまう', pos1: '非自立' }, tail] },
  // 〜ちゃう / 〜じゃう (casual 〜てしまう).
  { id: 'chau', steps: [verb(), { lemma: ['ちゃう', 'じゃう'], pos1: '非自立' }, tail] },

  // 〜ておく: do in advance.
  { id: 'te_oku', steps: [verb(), te, { lemma: 'おく', pos1: '非自立' }, tail] },
  // 〜とく (casual 〜ておく).
  { id: 'toku', steps: [verb(), { lemma: ['とく', 'どく'], pos1: '非自立' }, tail] },

  // 〜てある: a state left by someone's action.
  { id: 'te_aru', steps: [verb(), te, { lemma: 'ある', pos1: '非自立' }, tail] },

  // 〜なければならない / 〜なければいけない / 〜なくてはならない / 〜ないといけない.
  // After a verb (行かなければ), an adjective (広くなければ) or a noun + で (本人でなければ):
  // the なけれ+ば+なる/いける+neg run is distinctive enough to need no context step.
  {
    id: 'nakereba_naranai',
    suppresses: ['ba', 'to_cond', 'te_wa_ikenai'],
    steps: [
      {
        any: [
          [{ ...nai, cform: '仮定形' }, { surface: 'ば' }],
          [{ ...nai, cform: '連用テ接続' }, { surface: 'て' }, { surface: 'は' }],
          [{ ...nai, cform: '基本形' }, { surface: 'と', pos1: '接続助詞' }],
        ],
      },
      { lemma: ['なる', 'いける'] },
      neg,
      tail,
    ],
  },
  // 〜なきゃ (casual), optionally + いけない / ならない.
  {
    id: 'nakya',
    steps: [{ ...nai, cform: '仮定縮約' }, { optional: true, any: [[{ lemma: ['なる', 'いける'] }, neg]] }, tail],
  },

  // 〜たい: want to.
  { id: 'tai', steps: [verb('連用'), { lemma: 'たい', pos: '助動詞' }, tail] },

  // 〜ながら: while doing.
  { id: 'nagara', steps: [verb('連用'), { surface: 'ながら', pos: '助詞' }] },

  // 〜ことができる: can.
  {
    id: 'koto_ga_dekiru',
    steps: [verb('基本形'), { surface: 'こと' }, { surface: ['が', 'は', 'も'] }, { lemma: ['できる', '出来る'] }, tail],
  },

  // 〜前に: before doing. Verb in dictionary form, or an action noun + の (食事の前に).
  // Only サ変 nouns: 駅の前に is "in front of", not "before".
  {
    id: 'mae_ni',
    steps: [
      { any: [[verb('基本形')], [{ pos: '名詞', pos1: 'サ変接続', mark: false }, { surface: 'の', mark: false }]], mark: false },
      { surface: ['前', 'まえ'] },
      { surface: 'に' },
    ],
  },

  // 〜てから: after doing.
  { id: 'te_kara', suppresses: ['kara'], steps: [verb(), te, { surface: 'から', pos: '助詞' }] },

  // 〜ので: because.
  { id: 'node', steps: [{ surface: 'ので', pos: '助詞' }] },

  // 〜てもいい: may, it's OK to. Also after adjectives (狭くてもいい) and polite よろしい.
  { id: 'te_mo_ii', suppresses: ['te_mo'], steps: [te, { surface: 'も' }, { lemma: ['いい', 'よい', '良い', 'よろしい', '宜しい'] }, tail] },

  // 〜てはいけない / 〜てはならない / 〜てはだめ: must not.
  {
    id: 'te_wa_ikenai',
    // No context step: also after adjectives (古くてはいけない) and であっては.
    steps: [te, { surface: 'は' }, { any: [[{ lemma: ['いける', 'なる'] }, neg], [{ surface: ['だめ', 'ダメ', '駄目'] }]] }, tail],
  },
  // 〜ちゃいけない / 〜じゃいけない (casual 〜てはいけない / 〜ではいけない). じゃ is 接続助詞
  // after a verb (飲んじゃ) and 副助詞 after a noun (ジーンズじゃ); the いけない after it decides.
  {
    id: 'cha_ikenai',
    steps: [{ surface: ['ちゃ', 'じゃ'], pos: '助詞', pos1: ['接続助詞', '副助詞'] }, { any: [[{ lemma: ['いける', 'なる'] }, neg], [{ surface: ['だめ', 'ダメ', '駄目'] }]] }, tail],
  },

  // 〜かもしれない: might.
  { id: 'kamoshirenai', steps: [{ surface: 'かも' }, { lemma: 'しれる' }, neg, tail] },

  // 〜そうだ (hearsay): plain form (dictionary form or た) + そう + だ/です.
  // Not 〜そうだった: hearsay そうだ doesn't take the past. It does take そうで (…そうで、)
  // and そうな only before ので/のに (遅れるそうなので).
  {
    id: 'souda_hearsay',
    steps: [
      { pos: ['動詞', '形容詞', '助動詞'], cform: '基本形', mark: false },
      { surface: 'そう', pos: '名詞' },
      {
        any: [
          [{ ...copula, cform: '基本形' }],
          [{ ...copula, cform: '連用形', surface: 'で' }],
          [{ ...copula, surface: 'な' }, { surface: ['ので', 'のに'], mark: false }],
        ],
      },
    ],
  },
  // 〜そうだ (looks like): stem + そう. 降りそう, 美味しそうな, 元気そうです.
  {
    id: 'souda_looks',
    steps: [
      {
        any: [
          [{ pos: '動詞', cform: '連用形', mark: false }],
          [{ pos: '形容詞', cform: 'ガル接続', mark: false }],
          [{ pos: '名詞', pos1: '形容動詞語幹', mark: false }],
        ],
        mark: false,
      },
      { surface: 'そう', pos: '名詞' },
      { optional: true, any: [[copula], [{ surface: 'に', pos: '助詞' }]] },
    ],
  },

  // ── Phase 1: the rest of the N5–N4 catalogue ─────────────────────────────────

  // Requests and suggestions.
  // 〜てください (not 〜てくれる: ください is the 命令 form of くださる).
  // ください also comes before ませんか; before ます/ました it's 〜てくれる (te_kureru wins).
  { id: 'te_kudasai', steps: [te, { surface: 'ください', pos1: '非自立' }, { optional: true, any: [[{ lemma: 'ます', cform: '未然形' }, { lemma: 'ん' }, { surface: 'か' }]] }] },
  { id: 'naide_kudasai', suppresses: ['naide', 'te_kudasai'], steps: [{ lemma: 'ない', pos: '助動詞', cform: '連用デ接続' }, { surface: 'で', pos1: '接続助詞' }, { lemma: 'くださる', cform: '命令' }, tail] },
  // 〜ましょう / 〜ましょうか.
  { id: 'mashou', steps: [{ lemma: 'ます', cform: '未然ウ接続' }, { lemma: 'う', pos: '助動詞' }, { optional: true, surface: 'か', pos: '助詞' }] },
  // 〜ませんか: an invitation (行きませんか).
  { id: 'masenka', steps: [{ lemma: 'ます', cform: '未然形' }, { lemma: 'ん', pos: '助動詞' }, { surface: 'か', pos: '助詞' }] },
  { id: 'nasai', steps: [verb('連用'), { lemma: 'なさる', pos1: '非自立', cform: '命令' }] },
  { id: 'hou_ga_ii', steps: [plain(), { surface: ['ほう', '方'], pos1: '非自立' }, { surface: 'が' }, good, tail] },
  // 〜ばいい / 〜たらいい: what you should do.
  { id: 'ba_ii', suppresses: ['ba', 'tara'], steps: [{ any: [[{ surface: 'ば', pos1: '接続助詞' }], [tara]] }, good, tail] },

  // Wanting, intending, deciding.
  { id: 'te_hoshii', steps: [te, { lemma: ['ほしい', '欲しい'], pos1: '非自立' }, tail] },
  { id: 'tagaru', suppresses: ['tai'], steps: [{ lemma: 'たい', cform: 'ガル接続' }, { lemma: 'がる', pos1: '接尾' }, tail] },
  { id: 'tsumori', steps: [plain(), { surface: 'つもり', pos1: '非自立' }, tail] },
  // 〜(よ)う: volitional, "let's / I'll". The verb's 未然ウ接続 form + う / よう.
  { id: 'volitional', steps: [{ pos: '動詞', cform: '未然ウ接続', mark: false }, { lemma: ['う', 'よう'], pos: '助動詞' }] },
  // 〜(よ)うとする: try to; be about to.
  { id: 'you_to_suru', suppresses: ['volitional'], steps: [{ pos: '動詞', cform: '未然ウ接続', mark: false }, { lemma: ['う', 'よう'], pos: '助動詞' }, { surface: 'と', pos: '助詞' }, { lemma: 'する', pos: '動詞' }, tail] },
  { id: 'you_to_omou', suppresses: ['volitional', 'to_omou'], steps: [{ pos: '動詞', cform: '未然ウ接続', mark: false }, { lemma: ['う', 'よう'], pos: '助動詞' }, { surface: 'と', pos1: '格助詞' }, { lemma: ['思う', '考える'], mark: false }] },
  { id: 'koto_ni_suru', steps: [willDo, { surface: 'こと' }, { surface: 'に' }, { lemma: 'する', pos: '動詞' }, tail] },
  { id: 'koto_ni_naru', steps: [willDo, { surface: 'こと' }, { surface: 'に' }, { lemma: 'なる', pos: '動詞' }, tail] },

  // Experience and habits.
  // 〜たことがある: has done. The た is context (it's inside the verb's display token).
  { id: 'ta_koto_ga_aru', steps: [ta, { surface: 'こと' }, { surface: ['が', 'は', 'も'] }, { lemma: ['ある', 'ない'], pos: ['動詞', '形容詞'] }, tail] },
  // 〜ることがある: sometimes does.
  { id: 'ru_koto_ga_aru', steps: [nonPast, { surface: 'こと' }, { surface: ['が', 'も'] }, { lemma: 'ある', pos: '動詞' }, tail] },
  { id: 'you_ni_naru', suppresses: ['you_ni', 'you_da'], steps: [willDo, { surface: 'よう', pos1: '非自立' }, { surface: 'に' }, { lemma: 'なる', pos: '動詞' }, tail] },
  { id: 'you_ni_suru', suppresses: ['you_ni', 'you_da'], steps: [willDo, { surface: 'よう', pos1: '非自立' }, { surface: 'に' }, { lemma: 'する', pos: '動詞' }, tail] },
  // 〜ように: so that (after "will do / won't do"). After た or の it's "as, like" (you_da).
  // Not after の: 鳥のように is "like a bird".
  { id: 'you_ni', suppresses: ['you_da'], steps: [{ ...nonPast, any: nonPast.any!.slice(0, 1) }, { surface: 'よう', pos1: '非自立' }, { surface: 'に' }] },

  // Helpers after the て form.
  { id: 'te_miru', steps: [te, { lemma: 'みる', pos1: '非自立' }, tail] },
  { id: 'te_ageru', steps: [te, { lemma: ['あげる', 'やる', 'さしあげる', '差し上げる'], pos1: '非自立' }, tail] },
  {
    id: 'te_kureru',
    suppresses: ['te_kudasai'],
    steps: [
      te,
      { any: [[{ lemma: ['くれる', 'くださる'], pos1: '非自立', not: { surface: 'ください' } }], [{ surface: 'ください', pos1: '非自立' }, { lemma: 'ます', not: { cform: '未然' } }]] },
      tail,
    ],
  },
  { id: 'te_morau', steps: [te, { lemma: ['もらう', 'いただく', '頂く'], pos1: '非自立' }, tail] },
  { id: 'te_iku', steps: [te, { lemma: ['いく', '行く'], pos1: '非自立' }, tail] },
  { id: 'te_kuru', steps: [te, { lemma: ['くる', '来る'], pos1: '非自立' }, tail] },

  // Helpers after the stem.
  { id: 'hajimeru', steps: auxVerb(['始める', 'はじめる']) },
  { id: 'owaru', steps: auxVerb(['終わる', 'おわる', '終える', 'おえる']) },
  { id: 'tsuzukeru', steps: auxVerb(['続ける', 'つづける']) },
  { id: 'dasu', steps: auxVerb(['出す', 'だす']) },
  // 〜すぎる: after a verb stem (食べすぎる) or an adjective stem (高すぎる).
  { id: 'sugiru', steps: [{ lemma: ['すぎる', '過ぎる'], pos: '動詞', pos1: '非自立' }, tail] },
  { id: 'yasui', steps: [verb('連用'), { lemma: ['やすい', '易い'], pos: '形容詞', pos1: '非自立' }, tail] },
  { id: 'nikui', steps: [verb('連用'), { lemma: ['にくい', '難い'], pos: '形容詞', pos1: '非自立' }, tail] },
  // 〜に行く / 〜に来る: go to do. Only に is marked; the movement verb stays a word.
  // Verb stems only: a noun before に is usually the destination (仕事に戻る, 試合に行く).
  { id: 'ni_iku', steps: [verb('連用'), { surface: 'に', pos1: '格助詞' }, { lemma: ['行く', 'いく', '来る', 'くる', '帰る', '戻る', '出かける'], mark: false }] },

  // Verb forms.
  { id: 'causative', steps: [{ lemma: ['せる', 'させる'], pos: '動詞', pos1: '接尾' }] },
  // れる / られる: passive, but also respect (述べられた) and, after 一段 verbs, "can".
  { id: 'passive', steps: [{ lemma: ['れる', 'られる'], pos: '動詞', pos1: '接尾' }] },

  // Conditions.
  { id: 'tara', steps: [tara] },
  { id: 'ba', steps: [{ surface: 'ば', pos: '助詞', pos1: '接続助詞' }] },
  // と as "when / if" (接続助詞), not the quoting or "with" と (格助詞).
  { id: 'to_cond', steps: [plain('基本形'), { surface: 'と', pos: '助詞', pos1: '接続助詞' }] },
  { id: 'nara', steps: [{ lemma: 'だ', pos: '助動詞', cform: '仮定形', surface: 'なら' }, { optional: true, surface: 'ば' }] },
  { id: 'te_mo', steps: [te, { surface: 'も', pos: '助詞' }] },
  {
    id: 'nakute_mo_ii',
    suppresses: ['te_mo_ii', 'te_mo'],
    steps: [{ lemma: 'ない', cform: '連用テ接続' }, { surface: 'て' }, { surface: 'も' }, good, tail],
  },

  // Joining clauses.
  { id: 'kara', steps: [particle('から', '接続助詞')] },
  { id: 'kedo', steps: [particle(['けど', 'けれど', 'けれども'], '接続助詞')] },
  { id: 'ga_but', steps: [particle('が', '接続助詞')] },
  { id: 'noni', steps: [particle('のに', '接続助詞')] },
  { id: 'shi', steps: [particle('し', '接続助詞')] },
  { id: 'tari', steps: [particle(['たり', 'だり'], '並立助詞')] },
  // 〜ないで: without doing (or, said alone, "please don't").
  { id: 'naide', steps: [{ lemma: 'ない', pos: '助動詞', cform: '連用デ接続' }, { surface: 'で', pos1: '接続助詞' }] },
  { id: 'zu_ni', steps: [{ lemma: 'ぬ', pos: '助動詞', cform: '連用ニ接続', surface: 'ず' }, { surface: 'に' }] },

  // Time.
  { id: 'toki', steps: [{ any: [[plain()], [{ surface: 'の', pos1: '連体化' }]], mark: false }, { surface: ['とき', '時'], pos: '名詞' }, { optional: true, surface: ['に', 'は', 'には'] }] },
  { id: 'ta_ato_de', steps: [{ any: [[ta], [{ pos: '名詞', pos1: 'サ変接続', mark: false }, { surface: 'の', mark: false }]], mark: false }, { surface: ['後', 'あと'] }, { surface: ['で', 'に'] }] },
  { id: 'ta_bakari', steps: [ta, { surface: 'ばかり' }, tail] },
  { id: 'tokoro', steps: [{ any: [[{ pos: '動詞', cform: '基本形' }], [ta]], mark: false }, { surface: 'ところ', pos1: '非自立' }, copula, tail] },
  { id: 'ta_mama', steps: [{ any: [[ta], [{ pos: ['動詞', '形容詞', '助動詞'], cform: ['基本形', '体言接続'] }], [{ surface: 'の', pos1: '連体化' }], [{ pos: '連体詞' }]], mark: false }, { surface: 'まま' }, { optional: true, any: [[{ surface: ['で', 'に'], pos: '助詞' }], [copula, tail]] }] },

  // Guessing and hearsay.
  { id: 'darou', steps: [{ any: [[{ lemma: 'だ', cform: '未然形' }], [{ lemma: 'です', cform: '未然形' }]] }, { lemma: 'う', pos: '助動詞' }] },
  { id: 'hazu', steps: [{ surface: 'はず', pos1: '非自立' }, tail] },
  { id: 'mitai', steps: [{ surface: 'みたい', pos: '名詞' }, { optional: true, any: [[{ surface: 'に', pos: '助詞' }], [tail]] }] },
  { id: 'rashii', steps: [{ lemma: 'らしい', pos: '助動詞' }, tail] },
  // 〜ようだ / 〜ような / 〜ように: seems; like, as.
  { id: 'you_da', steps: [{ surface: 'よう', pos: '名詞', pos1: '非自立' }, { any: [[copula, tail], [{ surface: 'に', pos: '助詞' }]] }] },

  // Explaining, quoting, asking.
  // 〜のです / 〜んです: explains. Only after a verb, adjective or な (not 私のです, "mine").
  { id: 'no_da', steps: [plain(), { surface: ['の', 'ん'], pos: '名詞', pos1: '非自立' }, copula, tail] },
  // Also と + a verb of saying (と話しています), where kuromoji sometimes tags the と
  // as the conditional one, so this wins over to_cond.
  {
    id: 'to_iu',
    suppresses: ['to_cond'],
    steps: [{ any: [[{ surface: 'という', pos: '助詞' }], [quoted, { surface: 'と', pos: '助詞' }, { lemma: SAYING, mark: false }]] }],
  },
  { id: 'to_omou', steps: [quoted, { surface: 'と', pos1: '格助詞' }, { lemma: ['思う', '考える'], mark: false }] },
  { id: 'ka_dou_ka', steps: [{ surface: 'か' }, { surface: 'どう' }, { surface: 'か' }] },
  { id: 'shika', steps: [{ surface: 'しか', pos: '助詞' }] },
  // Purpose and cause: 〜ため(に).
  { id: 'tame', steps: [{ any: [[plain()], [{ surface: 'の', pos1: '連体化' }]], mark: false }, { surface: ['ため', '為'], pos1: '非自立' }, { optional: true, surface: ['に', 'には'] }] },
  // 〜さ: an adjective made into a noun (広さ, 静かさ).
  { id: 'sa', steps: [{ any: [[{ pos: '形容詞', cform: 'ガル接続' }], [{ pos: '名詞', pos1: '形容動詞語幹' }]], mark: false }, { surface: 'さ', pos: '名詞', pos1: '接尾' }] },

  // News staples (N3): one particle token each, except によると.
  { id: 'ni_yoru_to', suppresses: ['to_cond', 'ba'], steps: [{ surface: 'に' }, { lemma: ['よる', '依る', '因る'] }, { surface: ['と', 'ば'] }] },
  { id: 'ni_tsuite', steps: [particle(['について', 'につき'])] },
  { id: 'to_shite', steps: [particle(['として', 'としては', 'としても'])] },
  { id: 'ni_yotte', steps: [particle(['によって', 'により', 'による'])] },
  { id: 'ni_taishite', steps: [particle(['に対して', 'に対する', 'に対し'])] },
  { id: 'ni_totte', steps: [particle(['にとって', 'にとっては'])] },
  { id: 'ni_kanshite', steps: [particle(['に関して', 'に関する'])] },
];
