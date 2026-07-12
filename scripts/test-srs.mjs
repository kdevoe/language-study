/**
 * Standalone test runner for the FSRS scheduler (#67).
 *
 *   node scripts/test-srs.mjs
 *
 * No test framework (matches the repo's eval-harness style): src/services/srs.ts
 * imports `ts-fsrs`, so we bundle it to a temp file with esbuild and import it,
 * then assert on the pure scheduling behaviour with fixed clocks. Exits non-zero on
 * any failure so it can gate CI later.
 *
 * What it locks in:
 *   • ratingForReaderEvent: skip→Good(3), click→Again(1)
 *   • schedule(null, …): first review initialises a Review-state card
 *   • repeated Good grows the interval monotonically (learning)
 *   • Again lapses: stability collapses, lapses increments
 *   • D3 self-limit: an early read-past pushes the due date LESS than a due read
 *   • seedSrsFromDifficulty: easy words seed long, hard words seed short/overdue
 */
import esbuild from 'esbuild';
import { pathToFileURL } from 'node:url';
import { rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const TMP = path.join('scripts', '.tmp-srs-bundle.mjs');

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

const DAY = 86_400_000;
const T0 = Date.parse('2026-07-01T00:00:00Z'); // fixed clock — no Date.now()

async function main() {
  mkdirSync('scripts', { recursive: true });
  await esbuild.build({
    entryPoints: ['src/services/srs.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: TMP,
    logLevel: 'silent',
  });
  const srs = await import(pathToFileURL(TMP).href);
  const { schedule, ratingForReaderEvent, readerEventMayAdvance, seedSrsFromDifficulty, seedStability, REQUEST_RETENTION, seedForwardFromHistory, estimateStability } = srs;

  console.log('\nFSRS scheduler (#67) — request_retention', REQUEST_RETENTION);

  console.log('\nratingForReaderEvent');
  check('skip → Good (3)', ratingForReaderEvent('skip') === 3);
  check('click → Again (1)', ratingForReaderEvent('click') === 1);

  // Read⇄flashcard convergence (#71): the shared daily-dedup gate both the reader
  // and the flashcard path consult, so one word can't double-count in a day.
  console.log('\nreaderEventMayAdvance — shared daily gate (#71)');
  const DAY0 = '2026-07-01';
  const DAY1 = '2026-07-02';
  // Fresh day (no same-day adjustment): both events advance.
  check('untouched today → skip advances', readerEventMayAdvance('skip', undefined, undefined, DAY0) === true);
  check('untouched today → click advances', readerEventMayAdvance('click', undefined, undefined, DAY0) === true);
  check('adjusted a PRIOR day → skip advances', readerEventMayAdvance('skip', DAY1, 'skip', DAY0) === true);
  // Same-day passive read already happened: re-scroll skip deduped; a lookup upgrades.
  check('after same-day skip → another skip deduped', readerEventMayAdvance('skip', DAY0, 'skip', DAY0) === false);
  check('after same-day skip → a click overrides (upgrades)', readerEventMayAdvance('click', DAY0, 'skip', DAY0) === true);
  // Same-day lookup already happened: nothing passive stacks on it.
  check('after same-day click → skip deduped', readerEventMayAdvance('skip', DAY0, 'click', DAY0) === false);
  check('after same-day click → another click deduped', readerEventMayAdvance('click', DAY0, 'click', DAY0) === false);
  // The #71 fix: a flashcard grade stamps the day, so a later passive read of the
  // SAME word doesn't double-advance the one schedule (nor does a lookup restack).
  check('after same-day flashcard → skip deduped', readerEventMayAdvance('skip', DAY0, 'flashcard', DAY0) === false);
  check('after same-day flashcard → click deduped', readerEventMayAdvance('click', DAY0, 'flashcard', DAY0) === false);
  // A manual modal set is likewise deliberate — passive reads don't stack on it.
  check('after same-day manual → skip deduped', readerEventMayAdvance('skip', DAY0, 'manual', DAY0) === false);
  check('after same-day manual → click deduped', readerEventMayAdvance('click', DAY0, 'manual', DAY0) === false);

  console.log('\nschedule(null, …) — first review');
  const first = schedule(null, 3 /* Good */, T0);
  check('due is in the future', first.dueAt > T0, `dueAt=${first.dueAt} T0=${T0}`);
  check('status is a review-ish state', ['review', 'learning'].includes(first.status), `status=${first.status}`);
  check('stability > 0', first.stability > 0, `S=${first.stability}`);
  check('reps incremented to 1', first.reps === 1, `reps=${first.reps}`);
  check('lastReviewedAt == now', first.lastReviewedAt === T0);

  console.log('\nrepeated Good grows the interval (review at due each time)');
  let state = seedSrsFromDifficulty(5, T0); // medium word
  let prevInterval = 0;
  let monotonic = true;
  let clock = state.dueAt;
  for (let i = 0; i < 4; i++) {
    const next = schedule(state, 3, clock);
    if (next.intervalDays < prevInterval) monotonic = false;
    prevInterval = next.intervalDays;
    state = next;
    clock = next.dueAt; // always review exactly when due
  }
  check('interval grows monotonically across 4 Goods', monotonic, `last interval=${prevInterval}`);
  check('final interval is multiple weeks', prevInterval > 14, `interval=${prevInterval}d`);

  console.log('\nAgain (lookup) lapses the word');
  const mature = seedSrsFromDifficulty(3, T0); // easy word, high stability
  const lapsed = schedule(mature, 1 /* Again */, mature.dueAt);
  check('stability collapses on Again', lapsed.stability < mature.stability, `${mature.stability.toFixed(1)} → ${lapsed.stability.toFixed(1)}`);
  check('lapses incremented', lapsed.lapses === 1, `lapses=${lapsed.lapses}`);
  check('due date pulled in close (short-term steps off → stays review)', lapsed.dueAt - mature.dueAt < 5 * DAY && lapsed.status === 'review', `dueΔ=${Math.round((lapsed.dueAt - mature.dueAt) / DAY)}d status=${lapsed.status}`);

  console.log('\nD3 — early read pushes due date LESS than a due read');
  const base = seedSrsFromDifficulty(5, T0);
  const dueDay = Math.round((base.dueAt - T0) / DAY);
  const earlyRead = schedule(base, 3, T0 + 1 * DAY);            // read 1 day after seeding
  const dueRead = schedule(base, 3, base.dueAt);                // read exactly at due
  check(`early read gains less stability than due read (due≈+${dueDay}d)`,
    earlyRead.stability < dueRead.stability,
    `early S=${earlyRead.stability.toFixed(2)} vs due S=${dueRead.stability.toFixed(2)}`);
  check('but an early read still advances the schedule (> original stability)',
    earlyRead.stability > base.stability,
    `${base.stability.toFixed(2)} → ${earlyRead.stability.toFixed(2)}`);

  console.log('\nseedSrsFromDifficulty — easy seeds long, hard seeds short');
  check('easier word seeds higher stability than harder', seedStability(2) > seedStability(9),
    `S(2)=${seedStability(2).toFixed(1)} S(9)=${seedStability(9).toFixed(1)}`);
  const easy = seedSrsFromDifficulty(1, T0);
  const hard = seedSrsFromDifficulty(10, T0);
  check('easy word due well in the future', easy.dueAt - T0 > 21 * DAY, `+${Math.round((easy.dueAt - T0) / DAY)}d`);
  check('hard word due soon', hard.dueAt - T0 < 3 * DAY, `+${Math.round((hard.dueAt - T0) / DAY)}d`);
  check('seeded words enter as review', hard.status === 'review' && easy.status === 'review',
    `hard=${hard.status} easy=${easy.status}`);

  // Forward re-seed (study-pacing flood fix) — anchored at now, boosted by exposure.
  console.log('\nseedForwardFromHistory — forward-anchored, exposure-boosted, spread');
  const fwdOnce = seedForwardFromHistory(9, 1, T0);          // hard, seen once
  const fwdMany = seedForwardFromHistory(9, 20, T0);         // same word, seen across 20 days
  check('anchored at now, never in the past', fwdOnce.dueAt >= T0 && fwdMany.dueAt >= T0,
    `once=+${Math.round((fwdOnce.dueAt - T0) / DAY)}d many=+${Math.round((fwdMany.dueAt - T0) / DAY)}d`);
  check('respects the min-interval floor (hard/once not due <3d)', fwdOnce.dueAt - T0 >= 3 * DAY,
    `+${Math.round((fwdOnce.dueAt - T0) / DAY)}d`);
  check('exposure history lengthens the interval a lot', fwdMany.dueAt - T0 > (fwdOnce.dueAt - T0) * 3,
    `once=+${Math.round((fwdOnce.dueAt - T0) / DAY)}d many=+${Math.round((fwdMany.dueAt - T0) / DAY)}d`);
  check('estimateStability grows with distinct exposures', estimateStability(5, 10) > estimateStability(5, 1));
  check('reps 0 / status review (never actually graded)', fwdMany.reps === 0 && fwdMany.status === 'review');
  // Deterministic spread: same inputs + spreadFraction → same due date; extremes differ.
  const sLo = seedForwardFromHistory(5, 5, T0, { spreadFraction: 0 });
  const sHi = seedForwardFromHistory(5, 5, T0, { spreadFraction: 1 });
  const sLo2 = seedForwardFromHistory(5, 5, T0, { spreadFraction: 0 });
  check('spread is deterministic for a given fraction', sLo.dueAt === sLo2.dueAt);
  check('spread fans a cohort across days (0 vs 1 differ)', sLo.dueAt < sHi.dueAt,
    `lo=+${Math.round((sLo.dueAt - T0) / DAY)}d hi=+${Math.round((sHi.dueAt - T0) / DAY)}d`);

  console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m\n`);
}

main()
  .catch((e) => {
    console.error(e);
    failed++;
  })
  .finally(() => {
    try { rmSync(TMP, { force: true }); } catch { /* ignore */ }
    process.exit(failed > 0 ? 1 : 0);
  });
