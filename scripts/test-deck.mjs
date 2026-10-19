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
 *   • new cards are spread through the due reviews (the run opens on a review)
 *   • late arrivals join the run ahead; もう一度 repeats come back after REPEAT_GAP cards
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
  const { selectDeck, isDue, isNewCard, deckCounts, mixNewCards, mergeArrivals, queueRepeat, REPEAT_GAP } = await import(pathToFileURL(TMP).href);

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

  console.log('\nselectDeck — new cards mixed through the reviews, each internally ordered');
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
  check('opens on a review, new cards spread through (not saved for the end)',
    JSON.stringify(order) === JSON.stringify(['review1', 'newN5common', 'newN5rare', 'review2', 'newN4']),
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

  console.log('\nselectDeck — words with no level and no frequency rank are excluded (un-enriched junk)');
  const withJunk = selectDeck([
    due('good', 2),
    due('nolevel_due', 2, { jlptLevel: null, freqRank: null }),   // no JLPT, no rank → excluded
    fresh('nolevel_new', { jlptLevel: null, freqRank: null }),      // no JLPT, no rank → excluded
    fresh('unrated_ranked', { jlptLevel: null, freqRank: 3 }),      // JLPT-unrated real word → kept
  ], NOW);
  check('a due word with no JLPT or rank is dropped', !withJunk.some((c) => c.key === 'nolevel_due'));
  check('a new word with no JLPT or rank is dropped', !withJunk.some((c) => c.key === 'nolevel_new'));
  check('a JLPT-unrated word with a frequency rank is kept', withJunk.some((c) => c.key === 'unrated_ranked'));
  check('the JLPT-rated word survives', withJunk.some((c) => c.key === 'good') && withJunk.length === 2);

  console.log('\nselectDeck — empty deck when nothing is due or new');
  check('all-future/studied → empty', selectDeck([entry('a'), entry('b')], NOW).length === 0);

  // Dashboard health tallies (#73) — must agree with the deck's own predicates.
  console.log('\ndeckCounts — due / new / learning agree with the deck');
  const dc = deckCounts([
    due('d1', 1), due('d2', 3),                       // 2 due
    fresh('n1'), fresh('n2'), fresh('n3'),            // 3 new
    entry('l1'), entry('l2'),                         // 2 learning (active, scheduled, not due/new)
    entry('q1', { intakeStatus: 'queued' }),          // queued → not counted
    due('junk', 1, { jlptLevel: null, freqRank: null }), // no level, no rank → excluded
  ], NOW);
  check('due count', dc.due === 2, JSON.stringify(dc));
  check('new count', dc.new === 3, JSON.stringify(dc));
  check('learning count', dc.learning === 2, JSON.stringify(dc));
  check('active = due + new + learning (queued/level-less excluded)', dc.active === 7, JSON.stringify(dc));
  const dualDc = deckCounts([due('x', 2, { reps: 0, promotedTs: NOW - DAY })], NOW);
  check('a word both due AND new counts once, as due', dualDc.due === 1 && dualDc.new === 0, JSON.stringify(dualDc));

  // Daily review cap (study-pacing flood fix) — bounds surfaced reviews, keeps new cards.
  console.log('\nselectDeck — reviewCap bounds reviews, most-overdue kept');
  const many = [due('a', 1), due('b', 5), due('c', 3), due('d', 10), fresh('n1'), fresh('n2')];
  const capped = selectDeck(many, NOW, { reviewCap: 2 });
  const cappedReviews = capped.filter((c) => c.kind === 'review');
  const cappedNews = capped.filter((c) => c.kind === 'new');
  check('cap limits reviews to 2', cappedReviews.length === 2, JSON.stringify(cappedReviews.map((c) => c.key)));
  check('most-overdue reviews survive the cap', cappedReviews[0].key === 'd' && cappedReviews[1].key === 'b', JSON.stringify(cappedReviews.map((c) => c.key)));
  check('new cards unaffected by review cap', cappedNews.length === 2);
  check('reviewCap 0 hides all reviews, keeps new', selectDeck(many, NOW, { reviewCap: 0 }).every((c) => c.kind === 'new'));
  check('no cap → all reviews (legacy)', selectDeck(many, NOW).filter((c) => c.kind === 'review').length === 4);

  console.log('\ndeckCounts — dueShown reflects the cap, due stays the true backlog');
  const capDc = deckCounts(many, NOW, { reviewCap: 2 });
  check('due = true backlog (4)', capDc.due === 4, JSON.stringify(capDc));
  check('dueShown = min(due, cap) = 2', capDc.dueShown === 2, JSON.stringify(capDc));
  check('no cap → dueShown === due', deckCounts(many, NOW).dueShown === 4);

  console.log('\nmixNewCards — new cards spread evenly through the reviews');
  const R = (n) => Array.from({ length: n }, (_, i) => `r${i + 1}`);
  const N = (n) => Array.from({ length: n }, (_, i) => `n${i + 1}`);
  const mixed = mixNewCards(R(9), N(3)).join(' ');
  check('9 reviews + 3 new → a new card every 3 or so, opening and closing on reviews',
    mixed === 'r1 r2 r3 n1 r4 r5 n2 r6 r7 n3 r8 r9', mixed);
  check('no new cards → reviews unchanged', mixNewCards(R(3), []).join(' ') === 'r1 r2 r3');
  check('no reviews → new cards in order', mixNewCards([], N(3)).join(' ') === 'n1 n2 n3');
  check('one review opens the run', mixNewCards(R(1), N(2)).join(' ') === 'r1 n1 n2');

  console.log('\nmergeArrivals — late cards join the part of the run still ahead');
  const C = (key, kind) => ({ key, kind });
  const run = [C('a', 'review'), C('b', 'review'), C('c', 'review'), C('d', 'review'), C('e', 'review')];
  const merged = mergeArrivals(run, 1, [C('b', 'review'), C('x', 'new'), C('y', 'review')], (c) => c.key).map((c) => c.key).join(' ');
  check('cards up to the current one stay put; new card spread ahead; new review at the end; no duplicates',
    merged === 'a b c d x e y', merged);
  check('nothing new → same array', mergeArrivals(run, 1, [C('a', 'review')], (c) => c.key) === run);
  const done = mergeArrivals(run, 5, [C('x', 'new')], (c) => c.key).map((c) => c.key).join(' ');
  check('a finished run picks up arrivals at the end', done === 'a b c d e x', done);

  console.log('\nqueueRepeat — もう一度 comes back after REPEAT_GAP other cards, as practice');
  const rep = queueRepeat(run, 0);
  check(`repeat lands after ${REPEAT_GAP} other cards`, rep.map((c) => c.key).join(' ') === 'a b c d a e', rep.map((c) => c.key).join(' '));
  check('the repeat is marked, the original is not', rep[4].repeat === true && !rep[0].repeat);
  check('near the end it goes last', queueRepeat(run, 3).map((c) => c.key).join(' ') === 'a b c d e d');

  console.log(`\n${passed} passed, ${failed} failed`);
  try { rmSync(TMP); } catch { /* ignore */ }
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
