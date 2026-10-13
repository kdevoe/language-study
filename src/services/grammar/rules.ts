/**
 * Starter grammar rules (#43, phase 0): N5/N4 points plus the casual forms that
 * come for free from the tokenizer. Ids match docs/grammar-plan.md and, later,
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
  { id: 'te_kara', steps: [verb(), te, { surface: 'から', pos: '助詞' }] },

  // 〜ので: because.
  { id: 'node', steps: [{ surface: 'ので', pos: '助詞' }] },

  // 〜てもいい: may, it's OK to. Also after adjectives (狭くてもいい) and polite よろしい.
  { id: 'te_mo_ii', steps: [te, { surface: 'も' }, { lemma: ['いい', 'よい', '良い', 'よろしい', '宜しい'] }, tail] },

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
];
