/**
 * Standalone test runner for the flashcard deck-selection logic (#70).
 *
 *   node scripts/test-deck.mjs
 *
 * No test framework (matches test-srs.mjs / test-intake.mjs): src/services/deck.ts
 * is pure, so we bundle it with esbuild and assert on membership + ordering with
 * fixed inputs. Exits non-zero on any failure.
 *
 * What it locks in:
 *   • due reviews (dueAt <= now) come before new cards
 *   • due reviews are ordered most-overdue-first
 *   • new cards are ordered foundation-first (easiest level, then most common)
 *   • queued words never appear
 *   • grandfathered known words (promotedTs null, reps 0) are NOT "new"
 *   • not-yet-due active words (future dueAt, reps>0) are excluded
 *   • a word that is both due and new appears once, as a review
 */
import esbuild from 'esbuild';
import { pathToFileURL } from 'node:url';
import { rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const TMP = path.join('scripts', '.tmp-deck-bundle.mjs');
const NOW = 1_000_000_000_000; // fixed clock
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

// Terse builders. Defaults describe a plain active, scheduled word.
const entry = (key, over) => ({
  key,
  jlptLevel: 5,
  freqRank: 1,
  dueAt: NOW + DAY,     // not due by default
  reps: 1,              // already studied by default
  stability: 10,
  intakeStatus: 'active',
  promotedTs: null,
  ...over,
});
// A due review: overdue by `days`.
const due = (key, days, over) => entry(key, { dueAt: NOW - days * DAY, ...over });
// A new card: promoted, never studied, seeded future due.
const fresh = (key, over) => entry(key, { dueAt: NOW + 30 * DAY, reps: 0, promotedTs: NOW - DAY, ...over });

async function main() {
  mkdirSync('scripts', { recursive: true });
  await esbuild.build({
    entryPoints: ['src/services/deck.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: TMP,
    logLevel: 'silent',
  });
  const { selectDeck, isDue, isNewCard, deckCounts } = await import(pathToFileURL(TMP).href);

  console.log('\nmembership');
  check('a due active word is due', isDue(due('d', 1), NOW));
  check('a future-due active word is NOT due', !isDue(entry('f'), NOW));
  check('a queued word is never due', !isDue(entry('q', { intakeStatus: 'queued', dueAt: NOW - DAY }), NOW));
  check('a queued word is never new', !isNewCard(fresh('qn', { intakeStatus: 'queued' })));
  check('a promoted unstudied word is new', isNewCard(fresh('n')));
  check('a grandfathered known word (promotedTs null, reps 0) is NOT new',
    !isNewCard(entry('g', { reps: 0, promotedTs: null })));
  check('a promoted-but-studied word (reps>0) is NOT new', !isNewCard(fresh('s', { reps: 3 })));
  check('a legacy stability-only row counts as active (due)',
    isDue({ key: 'L', jlptLevel: 5, freqRank: 1, dueAt: NOW - DAY, reps: 1, stability: 8, promotedTs: null }, NOW));

  console.log('\nselectDeck — reviews before new, each internally ordered');
  const deck = selectDeck([
    fresh('newN4', { jlptLevel: 4, freqRank: 1 }),
    due('review2', 1),
    fresh('newN5common', { jlptLevel: 5, freqRank: 1 }),
    due('review1', 5),                 // most overdue
    fresh('newN5rare', { jlptLevel: 5, freqRank: 500 }),
    entry('notdue'),                   // future due, studied → excluded
    entry('queued', { intakeStatus: 'queued', dueAt: NOW - DAY }), // excluded
  ], NOW);
  const order = deck.map((c) => c.key);
  check('excludes not-due and queued words', deck.length === 5, order.join(','));
  check('all reviews precede all new cards',
    JSON.stringify(order) === JSON.stringify(['review1', 'review2', 'newN5common', 'newN5rare', 'newN4']),
    order.join(','));
  check('reviews are most-overdue-first', order.indexOf('review1') < order.indexOf('review2'));
  check('new cards are foundation-first (N5-common < N5-rare < N4)',
    order.indexOf('newN5common') < order.indexOf('newN5rare') &&
    order.indexOf('newN5rare') < order.indexOf('newN4'));
  check('every card is tagged with a kind',
    deck.every((c) => c.kind === 'review' || c.kind === 'new'));

  console.log('\nselectDeck — a word both due AND new counts once, as a review');
  const dual = selectDeck([due('x', 2, { reps: 0, promotedTs: NOW - DAY })], NOW);
  check('appears exactly once', dual.length === 1);
  check('classified as a review (already scheduled + urgent)', dual[0].kind === 'review');

  console.log('\nselectDeck — level-less words are excluded (un-enriched junk)');
  const withJunk = selectDeck([
    due('good', 2),
    due('nolevel_due', 2, { jlptLevel: null }),   // due but no JLPT → excluded
    fresh('nolevel_new', { jlptLevel: null }),      // new but no JLPT → excluded
  ], NOW);
  check('a due word with no JLPT is dropped', !withJunk.some((c) => c.key === 'nolevel_due'));
  check('a new word with no JLPT is dropped', !withJunk.some((c) => c.key === 'nolevel_new'));
  check('the JLPT-rated word survives', withJunk.length === 1 && withJunk[0].key === 'good');

  console.log('\nselectDeck — empty deck when nothing is due or new');
  check('all-future/studied → empty', selectDeck([entry('a'), entry('b')], NOW).length === 0);

  // Dashboard health tallies (#73) — must agree with the deck's own predicates.
  console.log('\ndeckCounts — due / new / learning agree with the deck');
  const dc = deckCounts([
    due('d1', 1), due('d2', 3),                       // 2 due
    fresh('n1'), fresh('n2'), fresh('n3'),            // 3 new
    entry('l1'), entry('l2'),                         // 2 learning (active, scheduled, not due/new)
    entry('q1', { intakeStatus: 'queued' }),          // queued → not counted
    due('junk', 1, { jlptLevel: null }),              // level-less → excluded
  ], NOW);
  check('due count', dc.due === 2, JSON.stringify(dc));
  check('new count', dc.new === 3, JSON.stringify(dc));
  check('learning count', dc.learning === 2, JSON.stringify(dc));
  check('active = due + new + learning (queued/level-less excluded)', dc.active === 7, JSON.stringify(dc));
  const dualDc = deckCounts([due('x', 2, { reps: 0, promotedTs: NOW - DAY })], NOW);
  check('a word both due AND new counts once, as due', dualDc.due === 1 && dualDc.new === 0, JSON.stringify(dualDc));

  console.log(`\n${passed} passed, ${failed} failed`);
  try { rmSync(TMP); } catch { /* ignore */ }
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
