/**
 * Standalone test runner for the intake-queue selection logic (#68).
 *
 *   node scripts/test-intake.mjs
 *
 * No test framework (matches test-srs.mjs / the eval-harness style): src/services/
 * intake.ts is pure, so we bundle it with esbuild and assert on the foundation-first
 * ordering + promotion selection with fixed inputs. Exits non-zero on any failure.
 *
 * What it locks in:
 *   • compareIntakeItem: easiest JLPT level first, then most common, then encountered
 *   • selectPromotions: respects the daily cap; cap<=0 promotes nothing
 *   • foundation-first: N5-common < N5-rare < N4 < N3
 *   • important UNSEEN words still promote when the local queue is empty (c1)
 *   • dedupe by entryId prefers the local encountered record over a virtual candidate
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
const local = (entryId, jlptLevel, freqRank, timesSeen = 1) =>
  ({ key: `k:${entryId}`, entryId, jlptLevel, freqRank, timesSeen });
const virtual = (entryId, jlptLevel, freqRank) =>
  ({ key: null, entryId, jlptLevel, freqRank, timesSeen: 0, candidate: { entryId, jlptLevel, freqRank, word: entryId, reading: '', meaning: '' } });

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
  const { compareIntakeItem, selectPromotions } = await import(pathToFileURL(TMP).href);

  console.log('\ncompareIntakeItem — foundation-first');
  const n5c = local('n5c', 5, 1);
  const n5r = local('n5r', 5, 100);
  const n4 = local('n4', 4, 1);
  const n3 = local('n3', 3, 1);
  const shuffled = [n3, n5r, n4, n5c];
  const order = [...shuffled].sort(compareIntakeItem).map((i) => i.entryId);
  check('N5-common < N5-rare < N4 < N3', JSON.stringify(order) === JSON.stringify(['n5c', 'n5r', 'n4', 'n3']), order.join(','));

  check('easier level (higher number) sorts first', compareIntakeItem(local('a', 5, 1), local('b', 4, 1)) < 0);
  check('within a level, lower freq_rank (more common) first', compareIntakeItem(local('a', 5, 1), local('b', 5, 2)) < 0);
  check('null freq_rank sorts after a ranked word', compareIntakeItem(local('a', 5, 5), local('b', 5, null)) < 0);
  check('null level sorts last', compareIntakeItem(local('a', null, 1), local('b', 1, 999)) > 0);

  console.log('\ncompareIntakeItem — encountered edges out never-seen at equal level+freq');
  check('higher timesSeen first on a tie', compareIntakeItem(local('seen', 5, 1, 5), virtual('unseen', 5, 1)) < 0);

  console.log('\nselectPromotions — daily cap');
  const pool = [n3, n4, n5r, n5c];
  check('cap 2 returns exactly 2', selectPromotions(pool, [], 2).length === 2);
  check('cap 2 returns the two easiest/most-common', JSON.stringify(selectPromotions(pool, [], 2).map((i) => i.entryId)) === JSON.stringify(['n5c', 'n5r']));
  check('cap 0 promotes nothing', selectPromotions(pool, [], 0).length === 0);
  check('cap larger than pool returns whole pool', selectPromotions(pool, [], 99).length === 4);

  console.log('\nselectPromotions — unseen-foundation words enter when queue is empty (c1)');
  const cands = [virtual('cB', 4, 1), virtual('cA', 5, 1), virtual('cC', 5, 50)];
  const fromEmpty = selectPromotions([], cands, 2).map((i) => i.entryId);
  check('promotes top-2 unseen candidates foundation-first', JSON.stringify(fromEmpty) === JSON.stringify(['cA', 'cC']), fromEmpty.join(','));
  check('promoted candidates carry their materialisation payload', selectPromotions([], cands, 1)[0].candidate?.word === 'cA');

  console.log('\nselectPromotions — dedupe by entryId prefers the local record');
  const merged = selectPromotions([local('dup', 5, 1)], [virtual('dup', 5, 1)], 5);
  check('a colliding entryId appears once', merged.filter((i) => i.entryId === 'dup').length === 1);
  check('the surviving record is the local (encountered) one', merged.find((i) => i.entryId === 'dup')?.key !== null);

  console.log(`\n${passed} passed, ${failed} failed`);
  try { rmSync(TMP); } catch { /* ignore */ }
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
