/**
 * Standalone test runner for the intake-queue selection logic (#68, v2
 * docs/intake-v2-spec.md).
 *
 *   node scripts/test-intake.mjs
 *
 * No test framework (matches test-srs.mjs / the eval-harness style): src/services/
 * intake.ts is pure, so we bundle it with esbuild and assert on the lane selection
 * with fixed inputs. Exits non-zero on any failure.
 *
 * What it locks in:
 *   • compareIntakeItem: easiest JLPT level first, then most common, then encountered
 *   • workingLevel: easiest level under 80% solid; user level with no data
 *   • laneShares: cap 3 → 1/1/1, cap 5 → 2/2/1
 *   • lanes: struggle (lookups/hard, any level), met-at-level (common, W or W−1),
 *     foundation (W, ranked); spill between lanes; the cap holds
 *   • the rare tail (no freq rank) and below-working-level words never win
 *   • junk (dates, affixes, unranked katakana) never wins
 *   • never-met candidates only fill what the queue can't (cold start), at W
 *   • dedupe by entryId prefers the local record
 */
import esbuild from 'esbuild';
import { pathToFileURL } from 'node:url';
import { rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const TMP = path.join('scripts', '.tmp-intake-bundle.mjs');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

// Helpers to build IntakeItems tersely.
const local = (entryId, jlptLevel, freqRank, timesSeen = 1, extra = {}) =>
  ({ key: `k:${entryId}`, entryId, jlptLevel, freqRank, timesSeen, surface: entryId, ...extra });
const virtual = (entryId, jlptLevel, freqRank) =>
  ({ key: null, entryId, jlptLevel, freqRank, timesSeen: 0, surface: entryId, candidate: { entryId, jlptLevel, freqRank, word: entryId, reading: '', meaning: '' } });
const ids = (picks) => picks.map((p) => p.entryId);

async function main() {
  mkdirSync('scripts', { recursive: true });
  await esbuild.build({
    entryPoints: ['src/services/intake.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: TMP,
    logLevel: 'silent',
  });
  const { compareIntakeItem, selectPromotions, workingLevel, laneShares, isJunk } = await import(pathToFileURL(TMP).href);

  console.log('\ncompareIntakeItem — foundation-first (used inside the foundation lane)');
  const order = [local('n3', 3, 1), local('n5r', 5, 100), local('n4', 4, 1), local('n5c', 5, 1)]
    .sort(compareIntakeItem).map((i) => i.entryId);
  check('N5-common < N5-rare < N4 < N3', JSON.stringify(order) === JSON.stringify(['n5c', 'n5r', 'n4', 'n3']), order.join(','));
  check('null level sorts last', compareIntakeItem(local('a', null, 1), local('b', 1, 999)) > 0);
  check('higher timesSeen first on a tie', compareIntakeItem(local('seen', 5, 1, 5), virtual('unseen', 5, 1)) < 0);

  console.log('\nworkingLevel');
  const oct = [{ level: 5, total: 705, solid: 627 }, { level: 4, total: 650, solid: 195 }, { level: 3, total: 1700, solid: 300 }];
  check('N5 89% solid → working level N4', workingLevel(oct, 4) === 4);
  check('N5 under 80% → N5', workingLevel([{ level: 5, total: 100, solid: 79 }, ...oct.slice(1)], 4) === 5);
  check('N5 + N4 filled → N3', workingLevel([oct[0], { level: 4, total: 650, solid: 600 }, oct[2]], 4) === 3);
  check('no data → user level', workingLevel([], 4) === 4);

  console.log('\nlaneShares');
  check('cap 3 → 1/1/1', JSON.stringify(laneShares(3)) === JSON.stringify({ S: 1, M: 1, Fo: 1 }));
  check('cap 5 → 2/2/1', JSON.stringify(laneShares(5)) === JSON.stringify({ S: 2, M: 2, Fo: 1 }));
  check('cap 0 → nothing', JSON.stringify(laneShares(0)) === JSON.stringify({ S: 0, M: 0, Fo: 0 }));

  console.log('\nisJunk');
  check('date (１２月) is junk', isJunk(local('１２月', null, 1)));
  check('suffix pos (屋) is junk', isJunk(local('屋', 5, null, 1, { pos: ['suf'] })));
  check('unranked katakana compound (西アフリカ) is junk', isJunk(local('西アフリカ', null, null)));
  check('ranked katakana word passes', !isJunk(local('テレビ局', 4, 5)));
  check('plain word (旅館) passes', !isJunk(local('旅館', 4, 9)));

  console.log('\nselectPromotions — lanes at working level N4');
  const queue = [
    local('支援', null, 3, 6, { lookupCount: 5 }),       // struggle, JLPT-unrated
    local('権利', 3, 4, 4, { lookupCount: 3 }),          // struggle, N3
    local('被る', 5, 46, 3, { mastery: 'hard' }),        // struggle via hard
    local('着物', 4, 9, 2),                              // met, N4 common
    local('制度', 3, 2, 3),                              // met, N3 very common
    local('屋上', 4, 10, 1),                             // met, N4
    local('講堂', 4, 30, 1),                             // foundation only (not common)
    local('字引', 5, null, 1),                           // the rare N5 tail
    local('晩御飯', 5, 20, 1),                           // below working level
    local('紛争', 1, 8, 1),                              // N1 met once — no lane
  ];
  const five = selectPromotions(queue, [], 5, 4);
  check('cap 5 promotes exactly 5', five.length === 5, ids(five).join(','));
  check('struggle lane takes the two most-looked-up', JSON.stringify(ids(five.filter((p) => p.lane === 'S'))) === JSON.stringify(['支援', '権利']), ids(five).join(','));
  check('met lane takes the two most common at N4/N3', JSON.stringify(ids(five.filter((p) => p.lane === 'M'))) === JSON.stringify(['制度', '着物']), ids(five).join(','));
  check('foundation lane takes N4 words only', five.filter((p) => p.lane === 'Fo').every((p) => p.jlptLevel === 4), ids(five).join(','));
  const all = ids(selectPromotions(queue, [], 99, 4));
  check('the rare N5 tail (字引) never wins', !all.includes('字引'), all.join(','));
  check('below-working-level words win only via struggle (晩御飯 out, 被る in)', !all.includes('晩御飯') && all.includes('被る'), all.join(','));
  check('an N1 word met once has no lane', !all.includes('紛争'), all.join(','));

  const three = selectPromotions(queue, [], 3, 4);
  check('cap 3 → one per lane', JSON.stringify(three.map((p) => p.lane)) === JSON.stringify(['S', 'M', 'Fo']), three.map((p) => p.lane).join(','));
  check('cap 0 promotes nothing', selectPromotions(queue, [], 0, 4).length === 0);

  console.log('\nselectPromotions — spill and junk');
  const noStruggle = selectPromotions([local('a', 4, 1), local('b', 4, 2), local('c', 4, 3), local('d', 4, 20)], [], 3, 4);
  check('an empty struggle lane spills to the others', noStruggle.length === 3, ids(noStruggle).join(','));
  const junky = selectPromotions([local('１２月', 4, 1), local('西アフリカ', 4, null), local('良', 4, 5)], [], 3, 4);
  check('junk never wins', JSON.stringify(ids(junky)) === JSON.stringify(['良']), ids(junky).join(','));

  console.log('\nselectPromotions — never-met candidates are a cold-start fallback');
  const cands = [virtual('cFive', 5, 1), virtual('cFourA', 4, 2), virtual('cFourB', 4, 1), virtual('cFourR', 4, null)];
  const cold = selectPromotions([], cands, 2, 4);
  check('empty queue → candidates at the working level, most common first', JSON.stringify(ids(cold)) === JSON.stringify(['cFourB', 'cFourA']), ids(cold).join(','));
  check('cold picks are tagged', cold.every((p) => p.lane === 'cold'));
  const full = selectPromotions([local('x', 4, 1), local('y', 4, 2), local('z', 4, 3)], cands, 3, 4);
  check('a full queue leaves candidates out', full.every((p) => p.key != null), ids(full).join(','));
  check('promoted candidates carry their materialisation payload', cold[0].candidate?.word === 'cFourB');

  console.log('\nselectPromotions — dedupe by entryId prefers the local record');
  const merged = selectPromotions([local('dup', 4, 1)], [virtual('dup', 4, 1)], 5, 4);
  check('a colliding entryId appears once', merged.filter((i) => i.entryId === 'dup').length === 1);
  check('the surviving record is the local one', merged.find((i) => i.entryId === 'dup')?.key !== null);

  console.log(`\n${passed} passed, ${failed} failed`);
  try { rmSync(TMP); } catch { /* ignore */ }
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
