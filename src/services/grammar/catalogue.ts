/**
 * Grammar catalogue (#43): what the grammar panel shows for each point.
 * One entry per rule id in rules.ts (scripts/test-grammar-rules.mjs checks the two
 * stay in step). Ships with the client for now; the grammar_points table comes
 * with progress sync (phase 2).
 *
 * Point list, senses and connection forms follow 日本語文型データベース (NINJAL,
 * CC BY 4.0); the English and the examples are ours. In examples, 【】 marks the
 * point.
 */

export interface GrammarPoint {
  id: string;
  /** JLPT level, 5 (N5) … 1 (N1). */
  level: number;
  pattern: string;
  meaning: string;
  /** How it's built. The first part (and any part in （）) is a slot, the rest literal. */
  formation: string[];
  note: string;
  examples: { ja: string; en: string }[];
  /** Spoken, casual register. */
  casual?: boolean;
  /** A related point: the formal ↔ casual pair ("In speech: …" / "Formal: …"),
   *  or one that's easy to mix up ("Compare: …"). */
  partner?: string;
}

const P: GrammarPoint[] = [
  {
    id: 'te_iru', level: 5, pattern: '〜ている', meaning: 'ongoing action, or a state that continues',
    formation: ['動詞 て形', '＋ いる'],
    note: 'With verbs of change (住む, 結婚する, 行く) it describes the resulting state, not an action in progress: 結婚している means "is married".',
    examples: [{ ja: '今、本を読【んでいます】。', en: "I'm reading a book now." }, { ja: '兄は東京に住【んでいる】。', en: 'My brother lives in Tokyo.' }],
    partner: 'te_ru',
  },
  {
    id: 'te_ru', level: 5, pattern: '〜てる', meaning: 'casual 〜ている', casual: true,
    formation: ['動詞 て形', '－ い', '＋ る'],
    note: 'In speech the い of 〜ている drops: 見ている → 見てる, 読んでいる → 読んでる. The polite 〜てます works the same way.',
    examples: [{ ja: '何読【んでる】の？', en: 'What are you reading?' }, { ja: 'それ、もう知【ってる】よ。', en: 'I already know that.' }],
    partner: 'te_iru',
  },
  {
    id: 'te_shimau', level: 4, pattern: '〜てしまう', meaning: 'do completely; or did something regrettable',
    formation: ['動詞 て形', '＋ しまう'],
    note: 'Two senses: finishing something off (全部食べてしまった), or something you wish hadn\'t happened (財布を忘れてしまった).',
    examples: [{ ja: '宿題を全部やっ【てしまった】。', en: 'I finished all my homework.' }, { ja: '電車に傘を忘れ【てしまいました】。', en: 'I left my umbrella on the train.' }],
    partner: 'chau',
  },
  {
    id: 'chau', level: 4, pattern: '〜ちゃう', meaning: 'casual 〜てしまう', casual: true,
    formation: ['動詞 て形', '－ て', '＋ ちゃう'],
    note: 'て＋しまう contracts to ちゃう, and で＋しまう to じゃう: 忘れちゃった, 飲んじゃった.',
    examples: [{ ja: 'ケーキ、全部食べ【ちゃった】。', en: 'I ate all the cake.' }, { ja: 'また寝坊し【ちゃった】。', en: 'I overslept again.' }],
    partner: 'te_shimau',
  },
  {
    id: 'te_oku', level: 4, pattern: '〜ておく', meaning: 'do in advance; leave as it is',
    formation: ['動詞 て形', '＋ おく'],
    note: 'Doing something now so it\'s ready later (準備しておく), or leaving something the way it is (窓を開けておく).',
    examples: [{ ja: '旅行の前にホテルを予約し【ておきます】。', en: "I'll book the hotel before the trip." }, { ja: '窓は開け【ておいて】ください。', en: 'Please leave the window open.' }],
    partner: 'toku',
  },
  {
    id: 'toku', level: 4, pattern: '〜とく', meaning: 'casual 〜ておく', casual: true,
    formation: ['動詞 て形', '－ て', '＋ とく'],
    note: 'ておく contracts to とく, and でおく to どく: 書いとく, 読んどく.',
    examples: [{ ja: 'メモ書い【とく】ね。', en: "I'll jot it down." }, { ja: 'これ、読ん【どいて】。', en: 'Read this (for later).' }],
    partner: 'te_oku',
  },
  {
    id: 'te_aru', level: 4, pattern: '〜てある', meaning: 'has been done (and stays that way)',
    formation: ['他動詞 て形', '＋ ある'],
    note: 'Someone did it on purpose and the result is still there. Compare 窓が開いている (the window is open) with 窓が開けてある (someone has opened it, for a reason).',
    examples: [{ ja: '壁に地図が貼っ【てある】。', en: 'A map has been put up on the wall.' }, { ja: 'ノートに名前が書い【てあります】。', en: 'The name is written in the notebook.' }],
  },
  {
    id: 'nakereba_naranai', level: 4, pattern: '〜なければならない', meaning: 'must, have to',
    formation: ['動詞 ない形', '－ ない', '＋ なければならない'],
    note: 'Also なければいけない, なくてはならない and ないといけない, with little difference in meaning. ならない sounds more formal (rules, the news); いけない more personal.',
    examples: [{ ja: '明日は早く起き【なければならない】。', en: 'I have to get up early tomorrow.' }, { ja: 'この薬を飲ま【なければなりません】。', en: 'You must take this medicine.' }],
    partner: 'nakya',
  },
  {
    id: 'nakya', level: 4, pattern: '〜なきゃ', meaning: 'casual "have to"', casual: true,
    formation: ['動詞 ない形', '－ ない', '＋ なきゃ'],
    note: 'Short for なければ. Often said on its own, with いけない or ならない left off: もう行かなきゃ.',
    examples: [{ ja: 'もう行か【なきゃ】。', en: 'I have to go.' }, { ja: '宿題し【なきゃいけない】。', en: 'I have to do my homework.' }],
    partner: 'nakereba_naranai',
  },
  {
    id: 'tai', level: 5, pattern: '〜たい', meaning: 'want to do',
    formation: ['動詞 ます形', '＋ たい'],
    note: 'For your own wishes. For someone else\'s, quote them (〜たいと言っている) or use 〜たがる.',
    examples: [{ ja: '京都に行き【たい】。', en: 'I want to go to Kyoto.' }, { ja: '何が食べ【たいです】か。', en: 'What do you want to eat?' }],
  },
  {
    id: 'nagara', level: 4, pattern: '〜ながら', meaning: 'while doing (two actions, same person)',
    formation: ['動詞 ます形', '＋ ながら'],
    note: 'The main action comes last; the ながら one is in the background: 音楽を聞きながら勉強する is studying, with music on.',
    examples: [{ ja: '音楽を聞き【ながら】勉強する。', en: 'I study while listening to music.' }, { ja: '歩き【ながら】話しましょう。', en: "Let's talk while we walk." }],
  },
  {
    id: 'koto_ga_dekiru', level: 4, pattern: '〜ことができる', meaning: 'can, be able to',
    formation: ['動詞 辞書形', '＋ ことができる'],
    note: 'A fuller, more formal way to say the potential form: 飲むことができる = 飲める. Common in the news and in instructions.',
    examples: [{ ja: 'ここで写真を撮る【ことができます】。', en: 'You can take photos here.' }, { ja: '漢字を読む【ことができる】。', en: 'I can read kanji.' }],
  },
  {
    id: 'mae_ni', level: 5, pattern: '〜前に', meaning: 'before doing',
    formation: ['動詞 辞書形 / 名詞 ＋ の', '＋ 前に'],
    note: 'The verb stays in dictionary form even when the sentence is in the past: 食べる前に手を洗った.',
    examples: [{ ja: '寝る【前に】歯をみがく。', en: 'I brush my teeth before bed.' }, { ja: '食事の【前に】手を洗いました。', en: 'I washed my hands before the meal.' }],
  },
  {
    id: 'te_kara', level: 4, pattern: '〜てから', meaning: 'after doing; since',
    formation: ['動詞 て形', '＋ から'],
    note: 'Puts one action strictly after another. Also "since" a point in time: 日本に来てから三年になる.',
    examples: [{ ja: '宿題をし【てから】遊ぶ。', en: "I'll play after doing my homework." }, { ja: '日本に来【てから】三年になります。', en: "It's been three years since I came to Japan." }],
  },
  {
    id: 'node', level: 4, pattern: '〜ので', meaning: 'because, so',
    formation: ['普通形', '＋ ので', '（な形容詞・名詞 ＋ な）'],
    note: 'Softer and more objective than から; the usual choice in the news, in explanations and in polite requests.',
    examples: [{ ja: '雨な【ので】、行きません。', en: "It's raining, so I won't go." }, { ja: '疲れた【ので】、早く寝た。', en: 'I was tired, so I went to bed early.' }],
  },
  {
    id: 'te_mo_ii', level: 4, pattern: '〜てもいい', meaning: "may; it's OK to",
    formation: ['動詞 て形', '＋ もいい'],
    note: 'Asking or giving permission; politer as 〜てもよろしいですか. The negative 〜なくてもいい means "don\'t have to". After an adjective it means "even if": 狭くてもいい, it\'s fine even if it\'s small.',
    examples: [{ ja: '写真を撮っ【てもいいですか】。', en: 'May I take a photo?' }, { ja: 'ここに座っ【てもいい】よ。', en: 'You can sit here.' }],
  },
  {
    id: 'te_wa_ikenai', level: 4, pattern: '〜てはいけない', meaning: 'must not',
    formation: ['動詞 て形', '＋ はいけない'],
    note: 'Forbids something. てはならない is the formal, written version you see in rules and laws.',
    examples: [{ ja: 'ここで泳い【ではいけません】。', en: "You mustn't swim here." }, { ja: '嘘をつい【てはならない】。', en: 'One must not lie.' }],
    partner: 'cha_ikenai',
  },
  {
    id: 'cha_ikenai', level: 4, pattern: '〜ちゃいけない', meaning: 'casual "must not"', casual: true,
    formation: ['動詞 て形', '－ ては', '＋ ちゃいけない'],
    note: 'ては contracts to ちゃ, and では to じゃ: 見ちゃいけない, 飲んじゃだめ.',
    examples: [{ ja: 'それ、触っ【ちゃいけない】よ。', en: "Don't touch that." }, { ja: 'そこで遊ん【じゃだめ】。', en: "You can't play there." }],
    partner: 'te_wa_ikenai',
  },
  {
    id: 'kamoshirenai', level: 4, pattern: '〜かもしれない', meaning: 'might, maybe',
    formation: ['普通形', '＋ かもしれない', '（な形容詞・名詞 は だ を取る）'],
    note: 'Roughly fifty-fifty. Casual speech often cuts it to 〜かも.',
    examples: [{ ja: '明日は雨が降る【かもしれません】。', en: 'It might rain tomorrow.' }, { ja: '彼は来ない【かもしれない】。', en: "He might not come." }],
  },
  {
    id: 'souda_hearsay', level: 4, pattern: '〜そうだ（伝聞）', meaning: 'I hear that, apparently',
    formation: ['普通形', '＋ そうだ'],
    note: 'Passes on something you heard or read. Not the "looks like" 〜そうだ, which attaches to the stem: 降るそうだ (I hear it will rain) vs 降りそうだ (it looks like rain).',
    examples: [{ ja: '明日は雨が降る【そうだ】。', en: 'I hear it will rain tomorrow.' }, { ja: '彼は先生だ【そうです】。', en: 'Apparently he is a teacher.' }],
  },
  {
    id: 'souda_looks', level: 4, pattern: '〜そうだ（様子）', meaning: 'looks like; seems about to',
    formation: ['動詞 ます形 / い形容詞 －い / な形容詞', '＋ そうだ'],
    note: 'What you can see or sense yourself. Irregular: いい → よさそう, ない → なさそう. Before a noun it becomes そうな: 美味しそうなケーキ.',
    examples: [{ ja: '雨が降り【そうだ】。', en: 'It looks like rain.' }, { ja: '美味し【そうな】ケーキですね。', en: 'That cake looks delicious.' }],
  },

  // ── Phase 1 catalogue ─────────────────────────────────────────────────────────
  {
    id: 'te_kudasai', level: 5, pattern: '〜てください', meaning: 'please do',
    formation: ['動詞 て形', '＋ ください'],
    note: 'A polite request. Softer still as 〜てくださいませんか. Before ます or ました, くださる means someone kindly did something (〜てくれる).',
    examples: [{ ja: 'ここに座っ【てください】。', en: 'Please sit here.' }, { ja: '名前を書い【てくださいませんか】。', en: 'Could you write your name?' }],
  },
  {
    id: 'naide_kudasai', level: 5, pattern: '〜ないでください', meaning: 'please don\'t',
    formation: ['動詞 ない形', '＋ でください'],
    note: 'A polite way to ask someone not to do something. In casual speech the ください often drops: 触らないで.',
    examples: [{ ja: '写真を撮ら【ないでください】。', en: 'Please don\'t take photos.' }, { ja: 'ここに荷物を置か【ないでください】。', en: 'Please don\'t leave bags here.' }],
  },
  {
    id: 'mashou', level: 5, pattern: '〜ましょう', meaning: 'let\'s',
    formation: ['動詞 ます形', '－ ます', '＋ ましょう'],
    note: 'Suggests doing something together. With か it offers help or asks for agreement: 手伝いましょうか, shall I help?',
    examples: [{ ja: '一緒に行き【ましょう】。', en: 'Let\'s go together.' }, { ja: '荷物を持ち【ましょうか】。', en: 'Shall I carry your bag?' }],
    partner: 'volitional',
  },
  {
    id: 'masenka', level: 5, pattern: '〜ませんか', meaning: 'won\'t you…? (an invitation)',
    formation: ['動詞 ます形', '－ ます', '＋ ませんか'],
    note: 'A polite invitation, softer than 〜ましょう because it leaves the choice to the listener. In casual speech it becomes 〜ない？',
    examples: [{ ja: '映画を見に行き【ませんか】。', en: 'Would you like to go see a movie?' }, { ja: 'お茶を飲み【ませんか】。', en: 'Won\'t you have some tea?' }],
  },
  {
    id: 'nasai', level: 4, pattern: '〜なさい', meaning: 'do (a firm instruction)',
    formation: ['動詞 ます形', '－ ます', '＋ なさい'],
    note: 'An instruction from someone in charge: a parent, a teacher, an exam paper. Too direct to use with equals or seniors.',
    examples: [{ ja: '早く寝【なさい】。', en: 'Go to bed now.' }, { ja: '正しい答えを選び【なさい】。', en: 'Choose the correct answer.' }],
  },
  {
    id: 'hou_ga_ii', level: 4, pattern: '〜ほうがいい', meaning: 'had better, should',
    formation: ['動詞 た形 / ない形', '＋ ほうがいい'],
    note: 'Advice. Usually the past form in the positive (行ったほうがいい) and the plain form in the negative (行かないほうがいい).',
    examples: [{ ja: '早く寝た【ほうがいい】。', en: 'You\'d better go to bed early.' }, { ja: '無理しない【ほうがいいです】よ。', en: 'You shouldn\'t overdo it.' }],
  },
  {
    id: 'ba_ii', level: 4, pattern: '〜ばいい・〜たらいい', meaning: 'should, just need to',
    formation: ['動詞 ば形 / たら形', '＋ いい'],
    note: 'Asks for or gives advice: どうすればいいですか, what should I do? Often means "all you have to do is".',
    examples: [{ ja: 'どうすれ【ばいいです】か。', en: 'What should I do?' }, { ja: '駅で聞い【たらいい】よ。', en: 'You could just ask at the station.' }],
  },
  {
    id: 'te_hoshii', level: 4, pattern: '〜てほしい', meaning: 'want someone to do',
    formation: ['動詞 て形', '＋ ほしい'],
    note: 'What you want someone else to do. The person is marked with に: 友達に来てほしい. For your own wishes use 〜たい.',
    examples: [{ ja: '早く来【てほしい】。', en: 'I want you to come soon.' }, { ja: 'もっと話を聞い【てほしかった】。', en: 'I wish they had listened more.' }],
  },
  {
    id: 'tagaru', level: 4, pattern: '〜たがる', meaning: '(someone else) wants to',
    formation: ['動詞 ます形', '＋ たがる'],
    note: 'Describes another person\'s wish from the outside. Usually in the ている form for an ongoing wish: 行きたがっている.',
    examples: [{ ja: '猫は外に出【たがる】。', en: 'The cat wants to go outside.' }, { ja: '子どもは甘い物を食べ【たがる】。', en: 'Kids always want sweets.' }],
  },
  {
    id: 'tsumori', level: 4, pattern: '〜つもり', meaning: 'intend to, plan to',
    formation: ['動詞 辞書形 / ない形', '＋ つもりだ'],
    note: 'A plan you have already decided on, firmer than 〜ようと思う. 行かないつもりだ: I don\'t intend to go.',
    examples: [{ ja: '来年留学する【つもりです】。', en: 'I plan to study abroad next year.' }, { ja: '今日は何も買わない【つもりだ】。', en: 'I don\'t intend to buy anything today.' }],
  },
  {
    id: 'volitional', level: 4, pattern: '〜（よ）う', meaning: 'let\'s; I\'ll (plain volitional)',
    formation: ['動詞 意向形'],
    note: 'The plain form of 〜ましょう: 行こう, 食べよう, しよう. On its own it suggests or decides; with と思う it\'s an intention, and with とする an attempt.',
    examples: [{ ja: '一緒に行こ【う】。', en: 'Let\'s go together.' }, { ja: '今日は早く寝よ【う】。', en: 'I\'ll go to bed early tonight.' }],
    partner: 'mashou',
  },
  {
    id: 'you_to_suru', level: 3, pattern: '〜（よ）うとする', meaning: 'try to; be about to',
    formation: ['動詞 意向形', '＋ とする'],
    note: 'An attempt, often one that doesn\'t succeed: 逃げようとした, tried to escape. Also "just about to": 出かけようとしたとき.',
    examples: [{ ja: '鳥は空を飛ぼ【うとした】。', en: 'The bird tried to fly.' }, { ja: '家を出よ【うとした】とき、電話が鳴った。', en: 'Just as I was about to leave, the phone rang.' }],
  },
  {
    id: 'you_to_omou', level: 4, pattern: '〜（よ）うと思う', meaning: 'I\'m thinking of doing',
    formation: ['動詞 意向形', '＋ と思う'],
    note: 'An intention, softer than 〜つもりだ. 〜ようと思っている says you\'ve been thinking about it for a while.',
    examples: [{ ja: '明日は早く起きよ【うと】思う。', en: 'I think I\'ll get up early tomorrow.' }, { ja: '留学しよ【うと】考えている。', en: 'I\'m thinking of studying abroad.' }],
  },
  {
    id: 'koto_ni_suru', level: 4, pattern: '〜ことにする', meaning: 'decide to',
    formation: ['動詞 辞書形 / ない形', '＋ ことにする'],
    note: 'A decision you made yourself. 〜ことにしている describes a rule you keep: 毎朝走ることにしている.',
    examples: [{ ja: '留学する【ことにした】。', en: 'I decided to study abroad.' }, { ja: '甘い物は食べない【ことにしています】。', en: 'I make a point of not eating sweets.' }],
    partner: 'koto_ni_naru',
  },
  {
    id: 'koto_ni_naru', level: 4, pattern: '〜ことになる', meaning: 'it has been decided; end up',
    formation: ['動詞 辞書形 / ない形', '＋ ことになる'],
    note: 'A decision made by others or by circumstances, not by you. Common in the news for outcomes and rulings.',
    examples: [{ ja: '来月、転勤する【ことになった】。', en: 'It\'s been decided that I\'ll transfer next month.' }, { ja: '彼は刑務所に入る【ことになりました】。', en: 'He will go to prison.' }],
    partner: 'koto_ni_suru',
  },
  {
    id: 'ta_koto_ga_aru', level: 4, pattern: '〜たことがある', meaning: 'have done (before)',
    formation: ['動詞 た形', '＋ ことがある'],
    note: 'Experience: something that has happened at least once. The negative 〜たことがない means "have never".',
    examples: [{ ja: '京都に行った【ことがある】。', en: 'I\'ve been to Kyoto.' }, { ja: 'この本は読んだ【ことがない】。', en: 'I\'ve never read this book.' }],
  },
  {
    id: 'ru_koto_ga_aru', level: 4, pattern: '〜ことがある', meaning: 'sometimes, there are times when',
    formation: ['動詞 辞書形 / い形容詞 / な形容詞 ＋ な', '＋ ことがある'],
    note: 'Something that happens now and then. Not to be confused with 〜たことがある (experience), which takes the past form.',
    examples: [{ ja: '時々映画を見る【ことがある】。', en: 'I sometimes watch movies.' }, { ja: 'この道は夜、危ない【ことがあります】。', en: 'This road can be dangerous at night.' }],
  },
  {
    id: 'you_ni_naru', level: 4, pattern: '〜ようになる', meaning: 'come to, start to (be able to)',
    formation: ['動詞 辞書形 / ない形', '＋ ようになる'],
    note: 'A gradual change in ability or habit. With a potential verb it means "can now": 話せるようになった.',
    examples: [{ ja: '日本語が話せる【ようになった】。', en: 'I can speak Japanese now.' }, { ja: '最近よく眠れる【ようになりました】。', en: 'I\'ve started sleeping well lately.' }],
  },
  {
    id: 'you_ni_suru', level: 4, pattern: '〜ようにする', meaning: 'make sure to, try to',
    formation: ['動詞 辞書形 / ない形', '＋ ようにする'],
    note: 'An effort to keep a habit. 〜ようにしている is the ongoing habit; 〜ようにしてください asks someone to make sure.',
    examples: [{ ja: '毎日歩く【ようにし】ている。', en: 'I make a point of walking every day.' }, { ja: '遅れない【ようにして】ください。', en: 'Please make sure not to be late.' }],
  },
  {
    id: 'you_ni', level: 4, pattern: '〜ように', meaning: 'so that, in order that',
    formation: ['動詞 辞書形 / ない形 / 可能形', '＋ ように'],
    note: 'A goal that isn\'t fully in your control: 見えるように (so that it can be seen). For a direct goal, use 〜ために. After た or の, ように means "as, like" instead.',
    examples: [{ ja: '忘れない【ように】メモする。', en: 'I write it down so I won\'t forget.' }, { ja: 'よく見える【ように】前に座る。', en: 'I sit at the front so I can see well.' }],
  },
  {
    id: 'te_miru', level: 4, pattern: '〜てみる', meaning: 'try doing (and see)',
    formation: ['動詞 て形', '＋ みる'],
    note: 'Doing something to find out what it\'s like. Not "try hard to" (that\'s 〜ようとする).',
    examples: [{ ja: 'この服を着【てみる】。', en: 'I\'ll try this on.' }, { ja: '初めて納豆を食べ【てみました】。', en: 'I tried natto for the first time.' }],
  },
  {
    id: 'te_ageru', level: 4, pattern: '〜てあげる', meaning: 'do (something) for someone',
    formation: ['動詞 て形', '＋ あげる'],
    note: 'Doing a favour for someone else. It can sound like showing off, so it\'s avoided with seniors; to them use 〜てさしあげる or just say what you did.',
    examples: [{ ja: '妹に本を買っ【てあげた】。', en: 'I bought my sister a book.' }, { ja: '道を教え【てあげました】。', en: 'I showed them the way.' }],
  },
  {
    id: 'te_kureru', level: 4, pattern: '〜てくれる', meaning: '(someone) does for me',
    formation: ['動詞 て形', '＋ くれる'],
    note: 'Someone does something for you or your group, with a sense of thanks. The polite form is 〜てくださる.',
    examples: [{ ja: '友達が手伝っ【てくれた】。', en: 'My friend helped me.' }, { ja: '先生が教え【てくださいました】。', en: 'The teacher kindly taught us.' }],
  },
  {
    id: 'te_morau', level: 4, pattern: '〜てもらう', meaning: 'have someone do (for me)',
    formation: ['動詞 て形', '＋ もらう'],
    note: 'You receive someone\'s action as a favour; the doer is marked with に. Polite: 〜ていただく.',
    examples: [{ ja: '先生に作文を見【てもらう】。', en: 'I\'ll have the teacher look at my essay.' }, { ja: '説明し【ていただきました】。', en: 'They kindly explained it to us.' }],
  },
  {
    id: 'te_iku', level: 4, pattern: '〜ていく', meaning: 'go on doing; (change) from now on',
    formation: ['動詞 て形', '＋ いく'],
    note: 'Movement away (飛んでいく), or a change that continues into the future: 人口は減っていく.',
    examples: [{ ja: '鳥が飛ん【でいく】。', en: 'The bird flies away.' }, { ja: '人口はこれから減っ【ていきます】。', en: 'The population will keep falling.' }],
    partner: 'te_kuru',
  },
  {
    id: 'te_kuru', level: 4, pattern: '〜てくる', meaning: 'come doing; (change) up to now',
    formation: ['動詞 て形', '＋ くる'],
    note: 'Movement toward the speaker, doing something and coming back, or a change that has built up until now: 寒くなってきた.',
    examples: [{ ja: 'だんだん寒くなっ【てきた】。', en: 'It\'s been getting colder.' }, { ja: 'ちょっと飲み物を買っ【てくる】ね。', en: 'I\'ll go get a drink.' }],
    partner: 'te_iku',
  },
  {
    id: 'hajimeru', level: 4, pattern: '〜はじめる', meaning: 'start to',
    formation: ['動詞 ます形', '＋ 始める'],
    note: 'The start of an action or a change. 〜だす is similar but sudden and unplanned.',
    examples: [{ ja: '雨が降り【始めた】。', en: 'It started to rain.' }, { ja: '去年から日本語を勉強し【始めました】。', en: 'I started studying Japanese last year.' }],
  },
  {
    id: 'owaru', level: 4, pattern: '〜おわる', meaning: 'finish doing',
    formation: ['動詞 ます形', '＋ 終わる'],
    note: 'Finishing an action all the way through. 〜終える is the more formal, written version.',
    examples: [{ ja: 'レポートを書き【終わった】。', en: 'I finished writing the report.' }, { ja: '本を読み【終えた】。', en: 'I finished reading the book.' }],
  },
  {
    id: 'tsuzukeru', level: 4, pattern: '〜つづける', meaning: 'keep on doing',
    formation: ['動詞 ます形', '＋ 続ける'],
    note: 'An action that keeps going, often longer than expected: 雨が降り続ける.',
    examples: [{ ja: '一時間歩き【続けた】。', en: 'I kept walking for an hour.' }, { ja: '彼は夢を追い【続けている】。', en: 'He keeps chasing his dream.' }],
  },
  {
    id: 'dasu', level: 4, pattern: '〜だす', meaning: 'suddenly start to',
    formation: ['動詞 ます形', '＋ 出す'],
    note: 'A sudden, often unexpected start: 泣き出す, 笑い出す, 降り出す. 〜はじめる is the neutral version.',
    examples: [{ ja: '子どもが急に泣き【出した】。', en: 'The child suddenly burst into tears.' }, { ja: '彼は急に怒り【出した】。', en: 'He suddenly got angry.' }],
  },
  {
    id: 'sugiru', level: 4, pattern: '〜すぎる', meaning: 'too much, over-',
    formation: ['動詞 ます形 / い形容詞 －い / な形容詞', '＋ すぎる'],
    note: 'Doing or being more than is good. With adjectives the い drops: 高すぎる. Exception: いい → よすぎる.',
    examples: [{ ja: '昨日は食べ【すぎた】。', en: 'I ate too much yesterday.' }, { ja: 'この服は高【すぎる】。', en: 'These clothes are too expensive.' }],
  },
  {
    id: 'yasui', level: 4, pattern: '〜やすい', meaning: 'easy to',
    formation: ['動詞 ます形', '＋ やすい'],
    note: 'The action is easy, or the thing tends to happen: 壊れやすい, breaks easily. The opposite is 〜にくい.',
    examples: [{ ja: 'この本は読み【やすい】。', en: 'This book is easy to read.' }, { ja: '冬は風邪をひき【やすい】。', en: 'You catch colds easily in winter.' }],
    partner: 'nikui',
  },
  {
    id: 'nikui', level: 4, pattern: '〜にくい', meaning: 'hard to',
    formation: ['動詞 ます形', '＋ にくい'],
    note: 'The action is hard to do, or the thing doesn\'t easily happen: 壊れにくい, hard to break.',
    examples: [{ ja: 'この説明は分かり【にくい】。', en: 'This explanation is hard to follow.' }, { ja: 'この靴は歩き【にくい】。', en: 'These shoes are hard to walk in.' }],
    partner: 'yasui',
  },
  {
    id: 'ni_iku', level: 5, pattern: '〜に行く', meaning: 'go to do',
    formation: ['動詞 ます形', '＋ に ＋ 行く・来る・帰る'],
    note: 'The purpose of going or coming. Only verbs of moving take it; with other verbs use 〜ために.',
    examples: [{ ja: '本を買い【に】行く。', en: 'I\'m going to buy a book.' }, { ja: '友達が映画を見【に】来た。', en: 'A friend came to watch a movie.' }],
  },
  {
    id: 'causative', level: 4, pattern: '〜せる・〜させる', meaning: 'make or let (someone) do',
    formation: ['五段 ない形 ＋ せる', '一段 ＋ させる'],
    note: 'Making someone do something, or letting them. Which one comes from context: 子どもに野菜を食べさせる (make), 好きなだけ遊ばせる (let). する → させる, 来る → 来させる.',
    examples: [{ ja: '子どもに野菜を食べ【させる】。', en: 'I make my child eat vegetables.' }, { ja: '弟を買い物に行か【せた】。', en: 'I had my brother go shopping.' }],
  },
  {
    id: 'passive', level: 4, pattern: '〜れる・〜られる', meaning: 'is done (passive)',
    formation: ['五段 ない形 ＋ れる', '一段 ＋ られる'],
    note: 'Something is done to the subject. The same form is also a respectful way to describe someone\'s actions (先生が来られた), and after 一段 verbs it can mean "can" (食べられる).',
    examples: [{ ja: '車が壊さ【れ】た。', en: 'The car was broken.' }, { ja: '先生に褒め【られ】た。', en: 'I was praised by the teacher.' }],
  },
  {
    id: 'tara', level: 4, pattern: '〜たら', meaning: 'if, when, after',
    formation: ['動詞・形容詞 た形', '＋ ら'],
    note: 'The most widely used "if": a condition, or "once / when" something has happened. Also for things that turned out a certain way: 開けたら、猫がいた.',
    examples: [{ ja: '雨が降っ【たら】行かない。', en: 'If it rains, I won\'t go.' }, { ja: '駅に着い【たら】電話してください。', en: 'Call me when you get to the station.' }],
  },
  {
    id: 'ba', level: 4, pattern: '〜ば', meaning: 'if',
    formation: ['動詞・形容詞 ば形'],
    note: 'A condition and its result, often something general or logical: 安ければ買う. Sounds a little more formal than 〜たら.',
    examples: [{ ja: '安けれ【ば】買う。', en: 'If it\'s cheap, I\'ll buy it.' }, { ja: '急げ【ば】間に合う。', en: 'If you hurry, you\'ll make it.' }],
  },
  {
    id: 'to_cond', level: 4, pattern: '〜と', meaning: 'when, whenever (natural result)',
    formation: ['普通形 現在', '＋ と'],
    note: 'Something that always or naturally follows: 春になると暖かくなる. It can\'t be followed by a request or a wish.',
    examples: [{ ja: '春になる【と】暖かくなる。', en: 'When spring comes, it gets warm.' }, { ja: 'ボタンを押す【と】、ドアが開く。', en: 'Press the button and the door opens.' }],
  },
  {
    id: 'nara', level: 4, pattern: '〜なら', meaning: 'if (it\'s the case that)',
    formation: ['普通形 / 名詞', '＋ なら'],
    note: 'Takes up what someone said or a topic, and adds advice or a comment: 京都なら, as for Kyoto….',
    examples: [{ ja: '京都に行く【なら】、秋がいい。', en: 'If you\'re going to Kyoto, autumn is best.' }, { ja: 'お茶【なら】、あそこの店がいい。', en: 'For tea, that shop is good.' }],
  },
  {
    id: 'te_mo', level: 4, pattern: '〜ても', meaning: 'even if, even though',
    formation: ['動詞・い形容詞 て形', '＋ も'],
    note: 'The result doesn\'t change despite the condition. With nouns and な形容詞 it is 〜でも: 雨でも行く.',
    examples: [{ ja: '雨が降っ【ても】行く。', en: 'I\'ll go even if it rains.' }, { ja: '高く【ても】買います。', en: 'I\'ll buy it even if it\'s expensive.' }],
  },
  {
    id: 'nakute_mo_ii', level: 4, pattern: '〜なくてもいい', meaning: 'don\'t have to',
    formation: ['動詞 ない形', '－ い', '＋ くてもいい'],
    note: 'No need to do something. More formal as 〜なくてもかまわない.',
    examples: [{ ja: '明日は来【なくてもいい】。', en: 'You don\'t have to come tomorrow.' }, { ja: '全部食べ【なくてもいいです】よ。', en: 'You don\'t have to eat it all.' }],
    partner: 'nakereba_naranai',
  },
  {
    id: 'kara', level: 5, pattern: '〜から', meaning: 'because, so',
    formation: ['普通形 / です・ます', '＋ から'],
    note: 'Gives a reason, often a personal one. 〜からです at the end of a sentence explains the one before. Softer and more objective: 〜ので.',
    examples: [{ ja: '寒い【から】帰る。', en: 'It\'s cold, so I\'m going home.' }, { ja: '大きな地震が起きた【から】です。', en: 'It\'s because a big earthquake struck.' }],
    partner: 'node',
  },
  {
    id: 'kedo', level: 4, pattern: '〜けど', meaning: 'but, although',
    formation: ['普通形 / です・ます', '＋ けど'],
    note: 'A casual "but". けれど and けれども are more formal. Often softens a sentence by leaving the rest unsaid: ちょっと高いんですけど….',
    examples: [{ ja: '高い【けど】買う。', en: 'It\'s expensive, but I\'ll buy it.' }, { ja: '行きたい【けれど】、時間がない。', en: 'I want to go, but I don\'t have time.' }],
    partner: 'ga_but',
  },
  {
    id: 'ga_but', level: 5, pattern: '〜が', meaning: 'but; and (linking two clauses)',
    formation: ['普通形 / です・ます', '＋ が'],
    note: 'Joins two clauses, usually in contrast. In the news it often just links background to the main point: 会議が開かれましたが、….',
    examples: [{ ja: '行きたいです【が】、時間がありません。', en: 'I\'d like to go, but I don\'t have time.' }, { ja: '値段は高いです【が】、よく売れている。', en: 'It\'s expensive, but it sells well.' }],
    partner: 'kedo',
  },
  {
    id: 'noni', level: 4, pattern: '〜のに', meaning: 'even though (and that\'s surprising)',
    formation: ['普通形', '＋ のに', '（な形容詞・名詞 ＋ な）'],
    note: 'Something turned out differently from what you expected, often with disappointment: 行ったのに会えなかった.',
    examples: [{ ja: '行った【のに】会えなかった。', en: 'I went, but I didn\'t get to see them.' }, { ja: '日曜日な【のに】、仕事がある。', en: 'It\'s Sunday, yet I have work.' }],
  },
  {
    id: 'shi', level: 4, pattern: '〜し', meaning: 'and also (giving reasons)',
    formation: ['普通形', '＋ し'],
    note: 'Lists reasons or points, with more implied: 安いし、近いし (it\'s cheap, it\'s close, and so on).',
    examples: [{ ja: 'この店は安い【し】、近い。', en: 'This shop is cheap, and it\'s close.' }, { ja: '雨だ【し】、今日は家にいよう。', en: 'It\'s raining, so let\'s stay home today.' }],
  },
  {
    id: 'tari', level: 4, pattern: '〜たり〜たりする', meaning: 'doing things like … and …',
    formation: ['動詞 た形', '＋ り'],
    note: 'Lists a few examples of actions, not all of them, and ends with する. Also alternating states: 行ったり来たり.',
    examples: [{ ja: '掃除し【たり】洗濯し【たり】する。', en: 'I do things like cleaning and laundry.' }, { ja: '週末は本を読ん【だり】する。', en: 'On weekends I read and so on.' }],
  },
  {
    id: 'naide', level: 4, pattern: '〜ないで', meaning: 'without doing',
    formation: ['動詞 ない形', '＋ で'],
    note: 'Doing one thing without doing another: 朝ご飯を食べないで出かけた. Said on its own it is a casual "don\'t": 行かないで.',
    examples: [{ ja: '朝ご飯を食べ【ないで】出かけた。', en: 'I left without eating breakfast.' }, { ja: '傘を持た【ないで】来た。', en: 'I came without an umbrella.' }],
    partner: 'zu_ni',
  },
  {
    id: 'zu_ni', level: 3, pattern: '〜ずに', meaning: 'without doing (written)',
    formation: ['動詞 ない形', '＋ ずに', '（する → せずに）'],
    note: 'The written, more formal version of 〜ないで.',
    examples: [{ ja: '何も言わ【ずに】帰った。', en: 'I went home without saying anything.' }, { ja: '連絡せ【ずに】休んだ。', en: 'They took the day off without telling anyone.' }],
    partner: 'naide',
  },
  {
    id: 'toki', level: 5, pattern: '〜とき', meaning: 'when, at the time',
    formation: ['普通形 / な形容詞 ＋ な / 名詞 ＋ の', '＋ とき'],
    note: 'The verb\'s tense before とき shows order: 行くとき (on the way, before arriving), 行ったとき (after arriving).',
    examples: [{ ja: '子どもの【とき】、よく遊んだ。', en: 'I played a lot as a child.' }, { ja: '暇な【時に】本を読む。', en: 'I read when I have free time.' }],
  },
  {
    id: 'ta_ato_de', level: 5, pattern: '〜たあとで', meaning: 'after doing',
    formation: ['動詞 た形 / 名詞 ＋ の', '＋ あとで'],
    note: 'One thing happens after another. The verb is always in the past form, even about the future.',
    examples: [{ ja: 'ご飯を食べた【あとで】散歩する。', en: 'I\'ll take a walk after eating.' }, { ja: '会議の【後で】話しましょう。', en: 'Let\'s talk after the meeting.' }],
    partner: 'mae_ni',
  },
  {
    id: 'ta_bakari', level: 4, pattern: '〜たばかり', meaning: 'have just done',
    formation: ['動詞 た形', '＋ ばかり'],
    note: 'Something happened a short time ago, or feels recent to the speaker even if it wasn\'t: 買ったばかりなのに壊れた.',
    examples: [{ ja: '日本に来た【ばかりです】。', en: 'I\'ve just come to Japan.' }, { ja: '買った【ばかりの】パソコン。', en: 'A computer I just bought.' }],
  },
  {
    id: 'tokoro', level: 4, pattern: '〜ところだ', meaning: 'about to / in the middle of / just did',
    formation: ['動詞 辞書形 / ている形 / た形', '＋ ところだ'],
    note: 'The form before ところ sets the moment: 出かけるところ (about to leave), 食べているところ (eating right now), 着いたところ (just arrived).',
    examples: [{ ja: '今から出かける【ところです】。', en: 'I\'m just about to leave.' }, { ja: '今、駅に着いた【ところだ】。', en: 'I\'ve just arrived at the station.' }],
  },
  {
    id: 'ta_mama', level: 4, pattern: '〜たまま', meaning: 'leaving it as it is, still',
    formation: ['動詞 た形 / ない形 / 名詞 ＋ の', '＋ まま'],
    note: 'A state carries on unchanged while something else happens: 電気をつけたまま寝た.',
    examples: [{ ja: '電気をつけた【まま】寝た。', en: 'I fell asleep with the light on.' }, { ja: '靴の【まま】入らないでください。', en: 'Please don\'t come in with your shoes on.' }],
  },
  {
    id: 'darou', level: 5, pattern: '〜だろう・〜でしょう', meaning: 'probably, I suppose',
    formation: ['普通形', '＋ だろう・でしょう'],
    note: 'A guess. でしょう is the polite form, as in weather forecasts; with rising intonation it asks for agreement: いいでしょう？',
    examples: [{ ja: '明日は晴れる【でしょう】。', en: 'It will probably be sunny tomorrow.' }, { ja: '彼はもう帰った【だろう】。', en: 'He\'s probably gone home already.' }],
  },
  {
    id: 'hazu', level: 4, pattern: '〜はずだ', meaning: 'should be, is expected to',
    formation: ['普通形', '＋ はずだ', '（な形容詞 ＋ な / 名詞 ＋ の）'],
    note: 'A conclusion you have good reason for. はずがない (N3) means "can\'t be".',
    examples: [{ ja: '荷物はもう着いた【はずだ】。', en: 'The package should have arrived by now.' }, { ja: '彼は来る【はずです】。', en: 'He\'s supposed to come.' }],
  },
  {
    id: 'mitai', level: 4, pattern: '〜みたいだ', meaning: 'seems like; like',
    formation: ['普通形 / 名詞', '＋ みたいだ'],
    note: 'The casual version of 〜ようだ, for a guess from what you see or a comparison: 子どもみたいに笑う.',
    examples: [{ ja: '外は雨【みたいです】。', en: 'It looks like it\'s raining outside.' }, { ja: '子ども【みたいに】笑う。', en: 'They laugh like a child.' }],
    partner: 'you_da',
  },
  {
    id: 'rashii', level: 4, pattern: '〜らしい', meaning: 'apparently, I hear',
    formation: ['普通形 / 名詞', '＋ らしい'],
    note: 'A guess based on something heard or read, more distant than 〜ようだ. After a noun as an adjective it means "typical of": 男らしい.',
    examples: [{ ja: '彼は医者【らしい】。', en: 'Apparently he\'s a doctor.' }, { ja: 'あの店は閉まった【らしい】。', en: 'I hear that shop closed.' }],
  },
  {
    id: 'you_da', level: 4, pattern: '〜ようだ', meaning: 'seems; like, as',
    formation: ['普通形 / 名詞 ＋ の', '＋ ようだ'],
    note: 'A guess from what you observe (誰もいないようだ), or a comparison (鳥のように). In the news, 〜たように means "as": 前に述べたように.',
    examples: [{ ja: '誰もいない【ようだ】。', en: 'It seems nobody is here.' }, { ja: '鳥の【ように】空を飛びたい。', en: 'I want to fly like a bird.' }],
    partner: 'mitai',
  },
  {
    id: 'no_da', level: 4, pattern: '〜のだ・〜んです', meaning: 'it\'s that…, you see (explaining)',
    formation: ['普通形', '＋ のだ・んです', '（な形容詞・名詞 ＋ な）'],
    note: 'Explains a situation, or asks for an explanation: どうしたんですか. んです is the spoken form. Overused, it can sound pushy.',
    examples: [{ ja: 'どうして遅れた【んです】か。', en: 'Why were you late?' }, { ja: 'この町は昔、海だった【のです】。', en: 'You see, this town used to be sea.' }],
  },
  {
    id: 'to_iu', level: 4, pattern: '〜という', meaning: 'called; that says',
    formation: ['名詞 / 普通形', '＋ という'],
    note: 'Names something (田中という人, a person called Tanaka), or reports what someone says. Ending a news sentence, 〜という means "it is said".',
    examples: [{ ja: 'タイタン【という】潜水艇。', en: 'A submersible called Titan.' }, { ja: '問題は大きい【と】話している。', en: 'They say the problem is serious.' }],
  },
  {
    id: 'to_omou', level: 4, pattern: '〜と思う', meaning: 'I think (that)',
    formation: ['普通形', '＋ と思う'],
    note: 'Your opinion or a guess. 〜と思っている can describe someone else\'s view. 〜と考える is more formal.',
    examples: [{ ja: 'それはいい【と】思います。', en: 'I think that\'s good.' }, { ja: '政府は大切だ【と】考えている。', en: 'The government considers it important.' }],
  },
  {
    id: 'ka_dou_ka', level: 4, pattern: '〜かどうか', meaning: 'whether or not',
    formation: ['普通形', '＋ かどうか', '（な形容詞・名詞 は だ を取る）'],
    note: 'A yes/no question inside a sentence: 行くかどうか分からない. For questions with 誰, 何 and the like, use just か.',
    examples: [{ ja: '行く【かどうか】分からない。', en: 'I don\'t know whether I\'ll go.' }, { ja: '正しい【かどうか】確かめる。', en: 'I\'ll check whether it\'s right.' }],
  },
  {
    id: 'shika', level: 4, pattern: '〜しか〜ない', meaning: 'only (and not enough)',
    formation: ['名詞', '＋ しか ＋ 否定'],
    note: 'Always with a negative verb, stressing that it\'s only that much: 千円しかない, I only have 1,000 yen. だけ is the neutral "only".',
    examples: [{ ja: '千円【しか】ない。', en: 'I only have 1,000 yen.' }, { ja: '漢字は少し【しか】読めない。', en: 'I can only read a little kanji.' }],
  },
  {
    id: 'tame', level: 4, pattern: '〜ため（に）', meaning: 'for, in order to; because of',
    formation: ['動詞 辞書形 / 名詞 ＋ の', '＋ ために'],
    note: 'After a will-do verb or a noun: purpose (健康のために走る). After a past form or a state: cause, common in the news (雨が降ったため、中止した).',
    examples: [{ ja: '健康の【ために】走る。', en: 'I run for my health.' }, { ja: '雨が降った【ため】、試合は中止になった。', en: 'The game was called off because of the rain.' }],
  },
  {
    id: 'sa', level: 4, pattern: '〜さ', meaning: '-ness (adjective → noun)',
    formation: ['い形容詞 －い / な形容詞', '＋ さ'],
    note: 'Makes a measurable noun from an adjective: 広さ (size), 長さ (length), 静かさ (quietness).',
    examples: [{ ja: '部屋の広【さ】はどのくらいですか。', en: 'How big is the room?' }, { ja: 'この町の静か【さ】が好きだ。', en: 'I love the quiet of this town.' }],
  },
  {
    id: 'ni_yoru_to', level: 3, pattern: '〜によると', meaning: 'according to',
    formation: ['名詞', '＋ によると'],
    note: 'Names the source of information; the sentence usually ends in 〜そうだ or 〜ということだ. によれば is the same.',
    examples: [{ ja: 'ニュース【によると】、地震があった。', en: 'According to the news, there was an earthquake.' }, { ja: '報道【によれば】、値段が上がるそうだ。', en: 'Reports say prices will go up.' }],
  },
  {
    id: 'ni_tsuite', level: 3, pattern: '〜について', meaning: 'about, concerning',
    formation: ['名詞', '＋ について'],
    note: 'The topic of talking, thinking or writing. Before a noun: についての.',
    examples: [{ ja: '環境【について】話す。', en: 'We talk about the environment.' }, { ja: 'この問題【について】調べた。', en: 'I looked into this problem.' }],
    partner: 'ni_kanshite',
  },
  {
    id: 'to_shite', level: 3, pattern: '〜として', meaning: 'as (a role or status)',
    formation: ['名詞', '＋ として'],
    note: 'The role or standpoint something has: 代表として参加する, take part as a representative.',
    examples: [{ ja: '代表【として】会議に出る。', en: 'I\'ll attend the meeting as a representative.' }, { ja: 'この町は温泉【として】有名だ。', en: 'This town is famous for its hot springs.' }],
  },
  {
    id: 'ni_yotte', level: 3, pattern: '〜によって', meaning: 'by; depending on; because of',
    formation: ['名詞', '＋ によって・による・により'],
    note: 'Several senses: the doer in a passive (彼によって書かれた), a means, a cause, or "depending on" (国によって違う).',
    examples: [{ ja: '地域【によって】違う。', en: 'It differs by region.' }, { ja: '専門家【による】調査。', en: 'A study by experts.' }],
  },
  {
    id: 'ni_taishite', level: 3, pattern: '〜に対して', meaning: 'toward, against; in contrast to',
    formation: ['名詞', '＋ に対して・に対する'],
    note: 'The target of an action or feeling (質問に対して答える), or a contrast between two things.',
    examples: [{ ja: '質問【に対して】答える。', en: 'I answer the question.' }, { ja: '政府【に対する】批判。', en: 'Criticism of the government.' }],
  },
  {
    id: 'ni_totte', level: 3, pattern: '〜にとって', meaning: 'for, to (from someone\'s point of view)',
    formation: ['名詞', '＋ にとって'],
    note: 'Whose point of view a judgement is from: 私にとって大切だ, it matters to me.',
    examples: [{ ja: '私【にとって】大切な人だ。', en: 'They are important to me.' }, { ja: '子ども【にとって】は難しい。', en: 'It\'s hard for children.' }],
  },
  {
    id: 'ni_kanshite', level: 3, pattern: '〜に関して', meaning: 'regarding, in relation to',
    formation: ['名詞', '＋ に関して・に関する'],
    note: 'A more formal 〜について, typical of reports and the news.',
    examples: [{ ja: '経済【に関して】話す。', en: 'We talk about the economy.' }, { ja: '事故【に関する】ニュース。', en: 'News about the accident.' }],
    partner: 'ni_tsuite',
  },
];

export const GRAMMAR_POINTS: Record<string, GrammarPoint> = Object.fromEntries(P.map((p) => [p.id, p]));
