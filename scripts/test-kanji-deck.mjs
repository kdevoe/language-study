/**
 * Standalone test runner for the RTK kanji deck (docs/rtk-kanji-deck-plan.md).
 *
 *   node scripts/test-kanji-deck.mjs
 *
 * Bundles the pure modules with esbuild (as test-deck.mjs does) and asserts with
 * fixed inputs. Exits non-zero on any failure.
 *
 * What it locks in:
 *   • due reviews most overdue first, new kanji (Heisig order) mixed between them
 *   • not-yet-due kanji are left out; new kanji are always in
 *   • the daily drip continues from the highest Heisig number, counts what it
 *     already added today, and stops at the end of the list
 *   • the Anki seed keeps Anki's due date and maps interval → S, ease → D
 *   • at retention 0.9 a seeded card's next interval is about its stability
 *   • the grade slider's starting grade follows thinking time, never Again
 */
import esbuild from 'esbuild';
import { pathToFileURL } from 'node:url';
import { rmSync } from 'node:fs';
import path from 'node:path';

const TMP = path.join('scripts', '.tmp-kanji-bundle.mjs');
const ENTRY = path.join('scripts', '.tmp-kanji-entry.ts');
const NOW = new Date(2026, 9, 17, 12, 0, 0).getTime(); // fixed local noon
const DAY = 86_400_000;

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  — ${detail}` : ''}`); }
}

const { writeFileSync } = await import('node:fs');
writeFileSync(ENTRY, `
export * from '../src/services/kanjiDeck';
export { defaultGrade, median } from '../src/services/thinkTime';
export { scheduleKanji, KANJI_REQUEST_RETENTION } from '../src/services/srs';
`);
await esbuild.build({ entryPoints: [ENTRY], bundle: true, platform: 'node', format: 'esm', outfile: TMP, logLevel: 'silent' });
const m = await import(pathToFileURL(TMP).href);
rmSync(TMP); rmSync(ENTRY);

const graded = (kanji, heisigNo, dueAt, extra = {}) => ({
  kanji, heisigNo, stability: 30, fsrsDifficulty: 5, dueAt, lastReviewedAt: dueAt - 30 * DAY, intervalDays: 30,
  reps: 3, lapses: 0, status: 'review', introducedAt: NOW - 100 * DAY, source: 'anki', updatedAt: 0, ...extra,
});

console.log('\nselectKanjiDeck');
{
  const progress = [
    graded('海', 500, NOW - 1 * DAY),
    graded('宣', 200, NOW - 5 * DAY),
    graded('抗', 700, NOW + 3 * DAY),           // not due
    m.newKanjiProgress('研', 729, NOW),
    m.newKanjiProgress('掛', 727, NOW),
  ];
  const deck = m.selectKanjiDeck(progress, NOW);
  const order = deck.map((c) => c.kanji).join('');
  check('reviews most-overdue first, new kanji in Heisig order mixed between them', order === '宣掛海研', order);
  check('not-yet-due kanji left out', !deck.some((c) => c.kanji === '抗'));
  check('kinds', deck.map((c) => c.kind).join(',') === 'review,new,review,new');
  check('a new kanji has no prior FSRS state', m.kanjiSrsState(progress[3]) === null);
  check('a graded kanji has one', m.kanjiSrsState(progress[0])?.stability === 30);
}

console.log('\nkanjiToIntroduce');
{
  const list = ['一', '二', '三', '四', '五', '六'];
  const base = [graded('一', 1, NOW + DAY), graded('二', 2, NOW + DAY)];
  const picks = m.kanjiToIntroduce(base, list, 3, NOW);
  check('continues from the highest Heisig number', picks.map((p) => `${p.kanji}${p.heisigNo}`).join(' ') === '三3 四4 五5');
  const withToday = [...base, m.newKanjiProgress('三', 3, NOW - 60_000)];
  check('counts kanji already added today', m.kanjiToIntroduce(withToday, list, 3, NOW).length === 2);
  const yesterday = [...base, m.newKanjiProgress('三', 3, NOW - DAY)];
  check('yesterday\'s additions don\'t count', m.kanjiToIntroduce(yesterday, list, 3, NOW).length === 3);
  const full = list.map((k, i) => graded(k, i + 1, NOW + DAY));
  check('stops at the end of the list', m.kanjiToIntroduce(full, list, 3, NOW).length === 0);
  check('highestHeisig', m.highestHeisig(base) === 2 && m.highestHeisig([]) === 0);
}

console.log('\nAnki seed');
{
  const due = NOW + 12 * DAY;
  const s = m.seedFromAnki({ intervalDays: 114, easeFactor: 2500, dueAt: due, lastReviewedAt: NOW - 102 * DAY, reps: 5, lapses: 0 });
  check('due date carried over unchanged', s.dueAt === due);
  check('stability = Anki interval', s.stability === 114);
  check('ease 2500 → D 5', s.fsrsDifficulty === 5);
  check('ease 3100 → D 2, 1900 → D 8', m.difficultyFromEase(3100) === 2 && m.difficultyFromEase(1900) === 8);
  check('D clamped to 1..10', m.difficultyFromEase(5000) === 1 && m.difficultyFromEase(500) === 10);
  check('interval floor of 1 day', m.seedFromAnki({ intervalDays: 0, easeFactor: 2500, dueAt: due, lastReviewedAt: NOW, reps: 1, lapses: 0 }).stability === 1);
  check('retention is 0.9', m.KANJI_REQUEST_RETENTION === 0.9);
  // Reviewed on its due date with Good: the next interval should grow from S, not jump years.
  const next = m.scheduleKanji(s, 3, due);
  check('Good on the due date grows the interval moderately', next.intervalDays > 114 && next.intervalDays < 114 * 4, `${next.intervalDays}d`);
  const again = m.scheduleKanji(s, 1, due);
  check('Again sends it back within days', again.intervalDays <= 7 && again.lapses === 1, `${again.intervalDays}d`);
}

console.log('\nThinking time → starting grade');
{
  const hist = Array.from({ length: 20 }, () => 8000); // median 8s
  check('quick (≤ half the median) → Easy', m.defaultGrade(3000, hist) === 4);
  check('normal (≤ 2× the median) → Good', m.defaultGrade(9000, hist) === 3);
  check('slow → Hard', m.defaultGrade(30_000, hist) === 2);
  check('never Again', [0, 1e3, 1e5, 1e7].every((t) => m.defaultGrade(t, hist) !== 1));
  check('fallback 6s median with few samples', m.defaultGrade(2900, []) === 4 && m.defaultGrade(11_000, [1, 2]) === 3 && m.defaultGrade(13_000, []) === 2);
  check('median', m.median([3, 1, 2]) === 2 && m.median([1, 2, 3, 4]) === 2.5);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
