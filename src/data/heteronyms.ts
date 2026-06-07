/**
 * Heteronym watchlist — surfaces with more than one common reading, where a
 * dictionary analyzer's single best guess is unreliable and sentence context is
 * what actually decides the reading.
 *
 * kuromoji/IPADIC already resolves most heteronyms correctly via its language
 * model (e.g. 実験を行った→おこなった vs 公園に行った→いった). This list is the
 * safety net: when one of these appears, the enricher asks the LLM to pick the
 * reading from the candidates given the sentence (one batched call per article,
 * cached). Candidates are listed most-common first.
 *
 * Restricted to non-conjugating words (nouns / adverbs / na-adjectives) so the
 * surface equals the dictionary form and the override maps cleanly. Conjugating
 * heteronyms (開く ひらく↔あく, 辛い つらい↔からい) are out of scope for now.
 */
export const HETERONYMS: Record<string, string[]> = {
  日本: ['にほん', 'にっぽん'],
  市場: ['しじょう', 'いちば'],
  上手: ['じょうず', 'うわて', 'かみて'],
  下手: ['へた', 'したて', 'しもて'],
  人気: ['にんき', 'ひとけ'],
  大事: ['だいじ', 'おおごと'],
  生物: ['せいぶつ', 'いきもの', 'なまもの'],
  見物: ['けんぶつ', 'みもの'],
  一行: ['いっこう', 'いちぎょう'],
  一見: ['いっけん', 'いちげん'],
  一目: ['ひとめ', 'いちもく'],
  最中: ['さいちゅう', 'さなか', 'もなか'],
  気質: ['きしつ', 'かたぎ'],
  色紙: ['しきし', 'いろがみ'],
  仮名: ['かな', 'かめい'],
  心中: ['しんちゅう', 'しんじゅう'],
  大家: ['おおや', 'たいか', 'たいけ'],
  人形: ['にんぎょう', 'ひとがた'],
  風車: ['ふうしゃ', 'かざぐるま'],
  草原: ['そうげん', 'くさはら'],
  一分: ['いっぷん', 'いちぶ'],
  一日: ['ついたち', 'いちにち'],
  二日: ['ふつか', 'ににち'],
  今日: ['きょう', 'こんにち'],
  昨日: ['きのう', 'さくじつ'],
  明日: ['あした', 'あす', 'みょうにち'],
  今朝: ['けさ', 'こんちょう'],
  一人: ['ひとり', 'いちにん'],
  二人: ['ふたり', 'ににん'],
  風: ['かぜ', 'ふう'],
  方: ['ほう', 'かた'],
  間: ['あいだ', 'ま', 'かん'],
  角: ['かど', 'つの'],
  境: ['さかい', 'きょう'],
  傍: ['そば', 'かたわら'],
};

/** Hiragana-only guard so a malformed LLM response can't poison a reading. */
export function isHiragana(s: string): boolean {
  return s.length > 0 && /^[぀-ゟー]+$/.test(s);
}
