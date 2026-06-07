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
        // Anchor the next kana run AFTER the kanji run's minimum span (≥1 mora per
        // kanji), so a kana that also appears inside the run's reading doesn't
        // steal the anchor and blank the run (手当て+てあて, お浸し+おしたし).
        const anchor = reading.indexOf(nextKana, rIdx + kanjiRun.length);
        readingEnd = anchor !== -1 ? anchor : reading.length;
      } else {
        readingEnd = reading.length;
      }

      // Keep a contiguous kanji run as ONE segment: the reading spans the whole
      // run (大統領 → だいとうりょう). Splitting per kanji would need per-character
      // reading data we don't have — even-distribution is wrong for unequal
      // compounds (首相 → しゅ/しょう, not しゅしょ/う). The modal renders this
      // reading over the group and still shows each kanji's RTK keyword below.
      segments.push({ kanji: kanjiRun.join(''), kana: reading.slice(rIdx, readingEnd) });
      rIdx = readingEnd;
      i = j;
    }
  }

  return segments;
}

// ── Per-kanji reading aligner ─────────────────────────────────────────────────
// alignOkurigana (above) splits a surface into kanji/kana runs but cannot break a
// multi-kanji run into per-character readings (病院 → びょう/いん) and mis-anchors
// okurigana that repeats in the reading (手当て + てあて). The aligner below uses a
// per-kanji reading dictionary to find the *unique* segmentation where every kana
// matches literally and every kanji takes one of its known readings (with rendaku
// /gemination variants). When there is no unique fit — or the word is a known
// jukujikun — it falls back to alignOkurigana so we never display a wrong guess.
//
// Data (kanjiReadings/jukujikun) is loaded lazily via loadReadingData(); until it
// resolves, alignReading transparently degrades to alignOkurigana.

let KANJI_READINGS: Record<string, string[]> | null = null;
let JUKUJIKUN: Set<string> | null = null;
let readingDataPromise: Promise<void> | null = null;

/** Lazy-load the kanji-reading tables (≈126 KB gzipped, code-split). Idempotent. */
export function loadReadingData(): Promise<void> {
  if (!readingDataPromise) {
    readingDataPromise = Promise.all([
      import('../data/kanjiReadings'),
      import('../data/jukujikun'),
    ]).then(([kr, jk]) => {
      const map: Record<string, string[]> = {};
      for (const line of kr.KANJI_READINGS_RAW.split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) map[line.slice(0, eq)] = line.slice(eq + 1).split(',');
      }
      KANJI_READINGS = map;
      JUKUJIKUN = new Set(jk.JUKUJIKUN_RAW.split('\n').filter(Boolean));
    });
    readingDataPromise.catch(() => {
      readingDataPromise = null; // allow a retry on next call
    });
  }
  return readingDataPromise;
}

/** Voiced (rendaku) first-mora variants. は-row also geminates to the p-row. */
const RENDAKU: Record<string, string[]> = {
  か: ['が'], き: ['ぎ'], く: ['ぐ'], け: ['げ'], こ: ['ご'],
  さ: ['ざ'], し: ['じ'], す: ['ず'], せ: ['ぜ'], そ: ['ぞ'],
  た: ['だ'], ち: ['ぢ'], つ: ['づ'], て: ['で'], と: ['ど'],
  は: ['ば', 'ぱ'], ひ: ['び', 'ぴ'], ふ: ['ぶ', 'ぷ'], へ: ['べ', 'ぺ'], ほ: ['ぼ', 'ぽ'],
};

/** Accepted surface forms of a kanji reading at a position (rendaku + gemination). */
function readingVariants(r: string, isFirst: boolean): string[] {
  const out = new Set([r]);
  if (!isFirst && r) {
    const voiced = RENDAKU[r[0]];
    if (voiced) for (const v of voiced) out.add(v + r.slice(1));
  }
  // Trailing つ/ち/く/き often geminates before the next morpheme (学校 がっこう).
  if (/[つちくき]$/.test(r)) out.add(r.slice(0, -1) + 'っ');
  return [...out];
}

/**
 * Align a surface to its reading with per-kanji granularity, using the loaded
 * reading dictionary. Returns one segment per character on a confident unique
 * split (病院 → [{病:びょう},{院:いん}]); otherwise defers to alignOkurigana.
 */
export function alignReading(
  surface: string,
  reading: string,
): { kanji: string; kana: string }[] {
  if (!KANJI_READINGS || !reading) return alignOkurigana(surface, reading);

  // Furigana is hiragana; kuromoji/JMDict readings can be katakana. Normalize so
  // kanji reading candidates (hiragana) match. The whole-word fallback uses it too.
  const hira = kataToHira(reading);
  const chars = Array.from(surface);
  if (chars.every(isKana)) return chars.map((c) => ({ kanji: c, kana: c }));
  // Known jukujikun (今日, 大人…): a per-kanji split is wrong by construction.
  if (JUKUJIKUN?.has(`${surface}\t${reading}`)) return alignOkurigana(surface, hira);

  // Candidate readings per character: kana are literal anchors; kanji expand to
  // their dictionary readings + variants. An unknown kanji aborts to the fallback.
  const candidates: string[][] = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (isKana(c)) {
      candidates.push([kataToHira(c)]);
      continue;
    }
    const base = KANJI_READINGS[c];
    if (!base) return alignOkurigana(surface, reading);
    const variants = new Set<string>();
    for (const r of base) for (const v of readingVariants(r, i === 0)) if (v) variants.add(v);
    // Longest-first keeps the search lean; uniqueness is enforced below regardless.
    candidates.push([...variants].sort((a, b) => b.length - a.length));
  }

  // Backtrack for partitions of `hira`; we only need to know if exactly one exists.
  const found: string[][] = [];
  const search = (idx: number, pos: number, acc: string[]): void => {
    if (found.length > 1) return;
    if (idx === chars.length) {
      if (pos === hira.length) found.push(acc.slice());
      return;
    }
    for (const r of candidates[idx]) {
      if (hira.startsWith(r, pos)) {
        acc.push(r);
        search(idx + 1, pos + r.length, acc);
        acc.pop();
        if (found.length > 1) return;
      }
    }
  };
  search(0, 0, []);

  if (found.length !== 1) return alignOkurigana(surface, hira); // ambiguous / no fit
  // Keep kana surface chars as themselves (no furigana over them); kanji take the
  // matched reading.
  return chars.map((c, i) => (isKana(c) ? { kanji: c, kana: c } : { kanji: c, kana: found[0][i] }));
}
