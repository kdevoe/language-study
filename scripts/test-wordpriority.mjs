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
  const { compareByDue, compareStuck } = await import(pathToFileURL(TMP).href);

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
