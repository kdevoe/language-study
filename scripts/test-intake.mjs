/**
 * Standalone test runner for the intake-queue selection logic (#68, v2
 * docs/intake-v2-spec.md).
 *
 *   node scripts/test-intake.mjs
 *
 * No test framework (matches test-srs.mjs / the eval-harness style): src/services/
 * intake.ts is pure, so we bundle it with esbuild and assert on the ranking with
 * fixed inputs. Exits non-zero on any failure.
 *
 * What it locks in:
 *   • workingLevel: easiest level under 80% solid; user level with no data
 *   • one score for every word: need, exposure, usefulness and level fit add up;
 *     no quotas — the top `cap` win whatever mix they are
 *   • eligibility: the rare tail (no freq rank) and junk never compete; chosen
 *     words (Discover / ハルカ) do, and lead
 *   • never-met candidates compete in the same ranking but lose to met words
 *   • the cap holds; dedupe by entryId prefers the local record
 */
import esbuild from 'esbuild';
import { pathToFileURL } from 'node:url';
import { rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const TMP = path.join('scripts', '.tmp-intake-bundle.mjs');
const NOW = Date.UTC(2026, 9, 18, 12);
const DAY = 86_400_000;

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

// Helpers to build IntakeItems tersely. Met words were last seen 2 days ago.
const local = (entryId, jlptLevel, freqRank, timesSeen = 1, extra = {}) =>
  ({ key: `k:${entryId}`, entryId, jlptLevel, freqRank, timesSeen, lastSeenTs: timesSeen ? NOW - 2 * DAY : 0, surface: entryId, ...extra });
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
  const { selectPromotions, workingLevel, isJunk, isEligible, intakeScore, levelFit } = await import(pathToFileURL(TMP).href);
  const pick = (items, cap, w = 4, cands = []) => selectPromotions(items, cands, cap, w, NOW);

  console.log('\nworkingLevel');
  const oct = [{ level: 5, total: 705, solid: 627 }, { level: 4, total: 650, solid: 195 }, { level: 3, total: 1700, solid: 300 }];
  check('N5 89% solid → working level N4', workingLevel(oct, 4) === 4);
  check('N5 under 80% → N5', workingLevel([{ level: 5, total: 100, solid: 79 }, ...oct.slice(1)], 4) === 5);
  check('N5 + N4 filled → N3', workingLevel([oct[0], { level: 4, total: 650, solid: 600 }, oct[2]], 4) === 3);
  check('no data → user level', workingLevel([], 4) === 4);

  console.log('\nlevelFit');
  check('working level fits best', levelFit(4, 4) === 1);
  check('one level up beats easier', levelFit(3, 4) > levelFit(5, 4));
  check('two up beats three up', levelFit(2, 4) > levelFit(1, 4));

  console.log('\nisJunk / isEligible');
  check('date (１２月) is junk', isJunk(local('１２月', null, 1)));
  check('suffix pos (屋) is junk', isJunk(local('屋', 5, null, 1, { pos: ['suf'] })));
  check('unranked katakana compound (西アフリカ) is junk', isJunk(local('西アフリカ', null, null)));
  check('ranked katakana word passes', !isJunk(local('テレビ局', 4, 5)));
  check('the rare tail (字引, no freq rank) cannot compete', !isEligible(local('字引', 5, null, 3)));
  check('a chosen word competes without a freq rank', isEligible(local('紅葉', 2, null, 0, { mastery: 'medium' })));

  console.log('\nintakeScore — each signal moves the score');
  const base = local('w', 4, 10, 3);
  const s = (x) => intakeScore(x, 4, NOW);
  check('lookups raise it', s({ ...base, lookupCount: 3 }) > s(base));
  check('marked hard raises it', s({ ...base, mastery: 'hard' }) > s(base));
  check('more common raises it', s({ ...base, freqRank: 2 }) > s(base));
  check('met recently beats met months ago', s(base) > s({ ...base, lastSeenTs: NOW - 90 * DAY }));
  check('met more often raises it', s({ ...base, timesSeen: 10 }) > s(base));
  check('working level beats two levels up', s(base) > s({ ...base, jlptLevel: 2 }));
  check('chosen by the learner leads', s(local('c', 3, 20, 0, { mastery: 'medium' })) > s({ ...base, lookupCount: 3 }));

  console.log('\nselectPromotions — one ranking, no quotas');
  const queue = [
    local('支援', null, 3, 6, { lookupCount: 5 }),
    local('権利', 3, 4, 4, { lookupCount: 3 }),
    local('着物', 4, 9, 2),
    local('制度', 3, 2, 3),
    local('講堂', 4, 30, 1),
    local('字引', 5, null, 1),
    local('紛争', 1, 8, 1),
  ];
  const three = pick(queue, 3);
  check('cap 3 promotes exactly 3', three.length === 3, ids(three).join(','));
  check('the most-looked-up words win, whatever their lane would have been', ids(three).includes('支援') && ids(three).includes('権利'), ids(three).join(','));
  check('picks are in score order', three.every((p, i) => i === 0 || three[i - 1].score >= p.score));
  const all = ids(pick(queue, 99));
  check('the rare tail (字引) never wins', !all.includes('字引'), all.join(','));
  check('an N1 word met once ranks last', all[all.length - 1] === '紛争', all.join(','));
  check('cap 0 promotes nothing', pick(queue, 0).length === 0);
  const fourN4 = pick([local('a', 4, 1), local('b', 4, 2), local('c', 4, 3), local('d', 4, 20)], 3);
  check('three from one level is fine — no quota pushes others in', JSON.stringify(ids(fourN4)) === JSON.stringify(['a', 'b', 'c']), ids(fourN4).join(','));

  console.log('\nselectPromotions — chosen words and junk');
  const chosen = pick([...queue, local('紅葉', 2, 15, 0, { mastery: 'medium' })], 1);
  check('a chosen N2 word, never met, wins', chosen[0].entryId === '紅葉', ids(chosen).join(','));
  const flagged = intakeScore(local('辞書', 4, 20, 5, { chosen: true }), 4, NOW);
  check('an explicit chosen flag counts even for a word met in reading', flagged > intakeScore(local('辞書', 4, 20, 5), 4, NOW) + 7);
  const requeued = intakeScore(local('requeued', 2, 15, 3, { mastery: 'medium' }), 4, NOW);
  check('a medium word met in reading gets no chosen boost', requeued < intakeScore(local('紅葉', 2, 15, 0, { mastery: 'medium' }), 4, NOW));
  const junky = pick([local('１２月', 4, 1), local('西アフリカ', 4, null), local('良', 4, 5)], 3);
  check('junk never wins', JSON.stringify(ids(junky)) === JSON.stringify(['良']), ids(junky).join(','));

  console.log('\nselectPromotions — never-met candidates');
  const cands = [virtual('cFourA', 4, 2), virtual('cFourB', 4, 1), virtual('cFourR', 4, null)];
  const cold = pick([], 2, 4, cands);
  check('empty queue → candidates, most common first', JSON.stringify(ids(cold)) === JSON.stringify(['cFourB', 'cFourA']), ids(cold).join(','));
  const mixed = pick([local('met', 4, 2, 3)], 1, 4, cands);
  check('a met word beats an equally common never-met one', mixed[0].entryId === 'met', ids(mixed).join(','));
  check('promoted candidates carry their materialisation payload', cold[0].candidate?.word === 'cFourB');

  console.log('\nselectPromotions — dedupe by entryId prefers the local record');
  const merged = selectPromotions([local('dup', 4, 1)], [virtual('dup', 4, 1)], 5, 4, NOW);
  check('a colliding entryId appears once', merged.filter((i) => i.entryId === 'dup').length === 1);
  check('the surviving record is the local one', merged.find((i) => i.entryId === 'dup')?.key !== null);

  console.log(`\n${passed} passed, ${failed} failed`);
  try { rmSync(TMP); } catch { /* ignore */ }
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
