// Server-side furigana alignment: split a word's reading across its characters
// so the client can render per-character <ruby> text. Kana characters anchor the
// split (they must appear in the reading); a run of kanji between anchors gets
// the enclosed reading slice, divided proportionally when the run is longer than
// one kanji. Extracted from dictionary-lookup/index.ts so the alignment — which
// feeds both displayed furigana and SRS keying — is unit-testable offline
// (scripts/test-furigana-map.mjs). Mirrors the client aligner's contract
// (src/services/furigana.ts): concatenating the segments always reproduces the
// word and its full reading, even when a per-kanji split is heuristic (jukujikun
// like 今日 have no true per-kanji reading).
export const isKana = (c: string) => /[\u3040-\u309f\u30a0-\u30ff]/.test(c);

export function buildFuriganaMap(word: string, reading: string): { kanji: string; kana: string }[] {
  const chars = Array.from(word);

  if (chars.every(isKana)) {
    return chars.map(c => ({ kanji: c, kana: c }));
  }

  const segments: { kanji: string; kana: string }[] = [];
  let readingIdx = 0;

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (isKana(char)) {
      segments.push({ kanji: char, kana: char });
      const kanaPos = reading.indexOf(char, readingIdx);
      if (kanaPos !== -1) {
        readingIdx = kanaPos + 1;
      } else {
        readingIdx++;
      }
    } else {
      let kanjiEnd = i + 1;
      while (kanjiEnd < chars.length && !isKana(chars[kanjiEnd])) {
        kanjiEnd++;
      }

      let readingEnd = readingIdx;
      if (kanjiEnd < chars.length) {
        const nextKana = chars[kanjiEnd];
        const nextAnchorPos = reading.indexOf(nextKana, readingIdx);
        readingEnd = nextAnchorPos !== -1 ? nextAnchorPos : readingIdx + (kanjiEnd - i);
      } else {
        readingEnd = reading.length;
      }

      const kanjiBlock = chars.slice(i, kanjiEnd);
      const blockReading = reading.slice(readingIdx, readingEnd);

      if (kanjiBlock.length === 1) {
        segments.push({ kanji: kanjiBlock[0], kana: blockReading });
      } else {
        const readingPerKanji = Math.floor(blockReading.length / kanjiBlock.length);
        const remainder = blockReading.length % kanjiBlock.length;
        let rIdx = 0;
        for (let k = 0; k < kanjiBlock.length; k++) {
          const count = readingPerKanji + (k < remainder ? 1 : 0);
          segments.push({ kanji: kanjiBlock[k], kana: blockReading.slice(rIdx, rIdx + count) });
          rIdx += count;
        }
      }

      readingIdx = readingEnd;
      i = kanjiEnd - 1;
    }
  }

  return segments.length > 0 ? segments : [{ kanji: word, kana: reading }];
}
