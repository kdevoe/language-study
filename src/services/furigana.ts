/**
 * Furigana / kana utilities — pure functions, no dictionary or network deps.
 *
 * Shared by the client tokenizer and JMDict lookup so okurigana alignment is
 * computed one way everywhere (the old even-split heuristic mis-aligned
 * compounds like 副大統領).
 */

export const isKana = (c: string) => /[぀-ゟ゠-ヿ]/.test(c);
export const hasKanji = (s: string) => /[一-龯㐀-䶿]/.test(s);

/** Convert katakana to hiragana (kuromoji readings are katakana). */
export function kataToHira(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/**
 * Align a surface form to its kana reading, kanji-run by kanji-run.
 *
 * Splits the surface into alternating kanji/kana runs, anchors each kana run
 * inside the reading, and assigns each kanji run the reading span up to the
 * next anchor. Handles leading, trailing, and internal kana (入(い)り口(ぐち)).
 *
 * Example: 食べる + たべる → [{食:た},{べ:べ},{る:る}]
 *
 * A multi-kanji run with no internal kana (大統領) is genuinely ambiguous per
 * character; we attach the whole span to the first kanji and blank the rest
 * rather than guess wrong readings.
 */
export function alignOkurigana(
  surface: string,
  reading: string,
): { kanji: string; kana: string }[] {
  const chars = Array.from(surface);
  if (chars.every((c) => isKana(c)) || !reading) {
    return chars.map((c) => ({ kanji: c, kana: c }));
  }

  const segments: { kanji: string; kana: string }[] = [];
  let rIdx = 0;
  let i = 0;

  while (i < chars.length) {
    if (isKana(chars[i])) {
      let j = i;
      while (j < chars.length && isKana(chars[j])) j++;
      const kanaRun = chars.slice(i, j).join('');
      for (const c of kanaRun) segments.push({ kanji: c, kana: c });
      const pos = reading.indexOf(kanaRun, rIdx);
      rIdx = pos !== -1 ? pos + kanaRun.length : rIdx + kanaRun.length;
      i = j;
    } else {
      let j = i;
      while (j < chars.length && !isKana(chars[j])) j++;
      const kanjiRun = chars.slice(i, j);

      let readingEnd: number;
      if (j < chars.length) {
        let k = j;
        while (k < chars.length && isKana(chars[k])) k++;
        const nextKana = chars.slice(j, k).join('');
        const anchor = reading.indexOf(nextKana, rIdx);
        readingEnd = anchor !== -1 ? anchor : reading.length;
      } else {
        readingEnd = reading.length;
      }

      const blockReading = reading.slice(rIdx, readingEnd);
      segments.push({ kanji: kanjiRun[0], kana: blockReading });
      for (let k = 1; k < kanjiRun.length; k++) {
        segments.push({ kanji: kanjiRun[k], kana: '' });
      }
      rIdx = readingEnd;
      i = j;
    }
  }

  return segments;
}
