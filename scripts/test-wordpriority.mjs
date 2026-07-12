/**
 * Standalone test runner for the shared Word Priority comparators (#69/#72).
 *
 *   node scripts/test-wordpriority.mjs
 *
 * No test framework (matches test-srs.mjs / test-intake.mjs / the eval-harness style):
 * supabase/functions/_shared/wordPriority.ts is a pure, dependency-free module, so we
 * bundle it with esbuild and assert on the comparators with fixed inputs. Exits
 * non-zero on any failure so it can gate CI later.
 *
 * What it locks in (#72 — feed genuinely-due words into the article review floor):
 *   • compareByDue: soonest due_at first; never-scheduled (null) words sort last
 *   • compareByDue: ties on due_at break by lower stability (more fragile first)
 *   • compareByDue: fully-tied words fall back to the compareStuck staleness order
 *   • compareStuck (baseline): never-seen stalest, then hardest, then least-seen
 */
import esbuild from 'esbuild';
import { pathToFileURL } from 'node:url';
import { rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const TMP = path.join('scripts', '.tmp-wordpriority-bundle.mjs');

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

// Terse WordSignal builder — only the fields the comparators read.
const sig = (entryId, o = {}) => ({
  entryId,
  jlptLevel: null,
  freqRank: null,
  isCommon: false,
  dueAt: o.dueAt ?? null,
  stability: o.stability ?? null,
  intervalDays: o.intervalDays ?? null,
  difficulty: o.difficulty ?? null,
  timesSeen: o.timesSeen ?? null,
  lastSeenAt: o.lastSeenAt ?? null,
});

async function main() {
  mkdirSync('scripts', { recursive: true });
  await esbuild.build({
    entryPoints: ['supabase/functions/_shared/wordPriority.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: TMP,
    logLevel: 'silent',
  });
  const { compareByDue, compareStuck, preDueUrgency, selectPreDueFloor, preDueWindowDays } = await import(pathToFileURL(TMP).href);

  console.log('\ncompareByDue — genuinely-due words first (#72)');
  // Two overdue words, one future, one never-scheduled. Expect: most-overdue → later
  // due → future → unscheduled last.
  const overdue = sig('overdue', { dueAt: '2026-07-01T00:00:00.000Z', stability: 5 });
  const dueLater = sig('dueLater', { dueAt: '2026-07-10T00:00:00.000Z', stability: 5 });
  const future = sig('future', { dueAt: '2026-12-01T00:00:00.000Z', stability: 50 });
  const unscheduled = sig('unscheduled', { dueAt: null, difficulty: 9, lastSeenAt: '2020-01-01T00:00:00.000Z' });
  const order = [future, unscheduled, dueLater, overdue].sort(compareByDue).map((s) => s.entryId);
  check('soonest due_at sorts first', order[0] === 'overdue', order.join(','));
  check('later due_at next', order[1] === 'dueLater', order.join(','));
  check('future due_at ahead of unscheduled', order[2] === 'future', order.join(','));
  check('unscheduled (null due_at) sorts last', order[3] === 'unscheduled', order.join(','));

  console.log('\ncompareByDue — same due date breaks by fragility (lower stability first)');
  const sameA = sig('fragile', { dueAt: '2026-07-05T00:00:00.000Z', stability: 2 });
  const sameB = sig('sturdy', { dueAt: '2026-07-05T00:00:00.000Z', stability: 40 });
  const tieOrder = [sameB, sameA].sort(compareByDue).map((s) => s.entryId);
  check('more fragile (lower stability) first', tieOrder[0] === 'fragile', tieOrder.join(','));

  console.log('\ncompareByDue — fully-tied words fall back to staleness (compareStuck)');
  // Identical due_at + stability → compareStuck: never-seen (no lastSeenAt) is stalest.
  const seen = sig('seen', { dueAt: '2026-07-05T00:00:00.000Z', stability: 5, lastSeenAt: '2026-07-04T00:00:00.000Z' });
  const neverSeen = sig('neverSeen', { dueAt: '2026-07-05T00:00:00.000Z', stability: 5, lastSeenAt: null });
  const fbOrder = [seen, neverSeen].sort(compareByDue).map((s) => s.entryId);
  check('never-seen sorts ahead of recently-seen on a tie', fbOrder[0] === 'neverSeen', fbOrder.join(','));

  console.log('\ncompareStuck — staleness baseline (unchanged by #72)');
  const older = sig('older', { lastSeenAt: '2026-01-01T00:00:00.000Z' });
  const newer = sig('newer', { lastSeenAt: '2026-07-01T00:00:00.000Z' });
  check('older last-seen sorts first', [newer, older].sort(compareStuck)[0].entryId === 'older');
  const hard = sig('hard', { lastSeenAt: '2026-07-01T00:00:00.000Z', difficulty: 9 });
  const easy = sig('easy', { lastSeenAt: '2026-07-01T00:00:00.000Z', difficulty: 3 });
  check('same last-seen → hardest first', [easy, hard].sort(compareStuck)[0].entryId === 'hard');

  // ── Pre-due surfacing window (flashcards augment reading) ──────────────────
  const NOW_MS = Date.parse('2026-07-12T00:00:00.000Z');
  const inDays = (d) => new Date(NOW_MS + d * 86_400_000).toISOString();

  console.log('\npreDueWindowDays — proportional to interval, clamped');
  check('~a week for a 2-month card', Math.round(preDueWindowDays(sig('x', { intervalDays: 60 }))) === 7,
    String(preDueWindowDays(sig('x', { intervalDays: 60 }))));
  check('tiny interval floored to ≥1 day', preDueWindowDays(sig('x', { intervalDays: 3 })) === 1);
  check('huge interval capped at 21 days', preDueWindowDays(sig('x', { intervalDays: 365 })) === 21);
  check('falls back to stability when no interval', preDueWindowDays(sig('x', { stability: 30 })) > 0);
  check('unscheduled → null window', preDueWindowDays(sig('x', {})) === null);

  console.log('\npreDueUrgency — 0 at window start, 1 at due, >1 overdue, null before window');
  // 60-day card → 7-day window. Due in 10 days → not yet in window.
  check('due beyond its window → null (not surfaced)', preDueUrgency(sig('x', { intervalDays: 60, dueAt: inDays(10) }), NOW_MS) === null);
  // Due in 3 days, 7-day window → in window, urgency ~0.57.
  const u = preDueUrgency(sig('x', { intervalDays: 60, dueAt: inDays(3) }), NOW_MS);
  check('inside window → urgency in (0,1)', u > 0 && u < 1, String(u));
  check('exactly due → urgency ~1', Math.abs(preDueUrgency(sig('x', { intervalDays: 60, dueAt: inDays(0) }), NOW_MS) - 1) < 0.01);
  check('overdue → urgency > 1', preDueUrgency(sig('x', { intervalDays: 60, dueAt: inDays(-5) }), NOW_MS) > 1);
  check('unscheduled (no dueAt) → null', preDueUrgency(sig('x', { intervalDays: 60, dueAt: null }), NOW_MS) === null);
  // No interval signal: only urgent once actually due.
  check('no-interval word not urgent before due', preDueUrgency(sig('x', { dueAt: inDays(2) }), NOW_MS) === null);
  check('no-interval word urgent once due', preDueUrgency(sig('x', { dueAt: inDays(-1) }), NOW_MS) > 0);

  console.log('\nselectPreDueFloor — most-urgent in-window words first, capped');
  // Long-interval word gets its window EARLY (absolute days) vs a short one.
  const pdLong = sig('long', { intervalDays: 120, dueAt: inDays(10) });   // 14d window → in window now
  const pdShort = sig('short', { intervalDays: 5, dueAt: inDays(3) });     // 1d window → NOT in window
  const pdOverdue = sig('overdue', { intervalDays: 30, dueAt: inDays(-2) }); // overdue → most urgent
  const pdNotYet = sig('notYet', { intervalDays: 30, dueAt: inDays(20) });   // due far off → excluded
  const picked = selectPreDueFloor([pdLong, pdShort, pdOverdue, pdNotYet], NOW_MS, 2).map((s) => s.entryId);
  check('overdue word surfaces first', picked[0] === 'overdue', picked.join(','));
  check('long-interval word in its early window is included', picked.includes('long'), picked.join(','));
  check('short-card not-yet-in-window excluded', !picked.includes('short'), picked.join(','));
  check('due-far-off word excluded', !picked.includes('notYet'), picked.join(','));
  check('respects the limit', picked.length === 2, picked.join(','));

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
