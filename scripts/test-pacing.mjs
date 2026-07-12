/**
 * Standalone test runner for study-pacing reclassification (the flood fix).
 *
 *   node scripts/test-pacing.mjs
 *
 * No framework (matches test-deck.mjs / test-srs.mjs): src/services/pacing.ts is
 * pure (imports srs.ts → ts-fsrs), so we bundle with esbuild and assert. Exits
 * non-zero on any failure.
 *
 * Locks in Policy F:
 *   • easy (difficulty ≤ 3) → keep-active, forward-reseeded far out
 *   • medium+ (difficulty ≥ 4) → requeue
 *   • null difficulty → treated as medium → requeue
 *   • queued / unscheduled words are not "active" (caller skips them)
 *   • exposure history stretches an easy word's interval
 *   • spreadFraction is deterministic per key
 */
import esbuild from 'esbuild';
import { pathToFileURL } from 'node:url';
import { rmSync } from 'node:fs';
import path from 'node:path';

const TMP = path.join('scripts', '.tmp-pacing-bundle.mjs');
const NOW = 1_000_000_000_000;
const DAY = 86_400_000;

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  — ${detail}` : ''}`); }
}

async function main() {
  await esbuild.build({
    entryPoints: ['src/services/pacing.ts'],
    bundle: true, format: 'esm', outfile: TMP, platform: 'node', logLevel: 'silent',
  });
  const { decidePacing, isActiveForPacing, spreadFractionForKey, EASY_MAX_DIFFICULTY } =
    await import(pathToFileURL(TMP).href);

  const inp = (o) => ({ key: 'k', difficulty: 5, distinctExposures: 1, intakeStatus: 'active', stability: 10, ...o });

  console.log('isActiveForPacing — only scheduled/active words qualify');
  check('active status → active', isActiveForPacing(inp({ intakeStatus: 'active', stability: null })));
  check('has stability → active', isActiveForPacing(inp({ intakeStatus: undefined, stability: 5 })));
  check('queued → not active', !isActiveForPacing(inp({ intakeStatus: 'queued', stability: null })));
  check('unscheduled + no status → not active', !isActiveForPacing(inp({ intakeStatus: undefined, stability: null })));

  console.log('\ndecidePacing — easy stays active far-out, medium+ requeues');
  const easy = decidePacing(inp({ key: 'easy', difficulty: 2, distinctExposures: 3 }), NOW);
  check('easy (diff 2) → keep-active', easy.action === 'keep-active');
  check('easy re-seeded into the future', easy.action === 'keep-active' && easy.srs.dueAt > NOW,
    easy.action === 'keep-active' ? `+${Math.round((easy.srs.dueAt - NOW) / DAY)}d` : easy.action);
  check('EASY_MAX_DIFFICULTY is the app easy bucket (3)', EASY_MAX_DIFFICULTY === 3);
  check('diff 3 (boundary) → keep-active', decidePacing(inp({ difficulty: 3 }), NOW).action === 'keep-active');
  check('diff 4 (medium) → requeue', decidePacing(inp({ difficulty: 4 }), NOW).action === 'requeue');
  check('diff 9 (hard) → requeue', decidePacing(inp({ difficulty: 9 }), NOW).action === 'requeue');
  check('null difficulty → treated medium → requeue', decidePacing(inp({ difficulty: null }), NOW).action === 'requeue');

  console.log('\ndecidePacing — exposure history stretches the easy interval');
  const once = decidePacing(inp({ key: 'a', difficulty: 2, distinctExposures: 1 }), NOW);
  const many = decidePacing(inp({ key: 'a', difficulty: 2, distinctExposures: 20 }), NOW);
  check('more distinct exposures → farther-out due date',
    many.srs.dueAt - NOW > (once.srs.dueAt - NOW) * 2,
    `once=+${Math.round((once.srs.dueAt - NOW) / DAY)}d many=+${Math.round((many.srs.dueAt - NOW) / DAY)}d`);

  console.log('\nspreadFractionForKey — deterministic, in [0,1)');
  check('deterministic for a key', spreadFractionForKey('hello') === spreadFractionForKey('hello'));
  check('different keys differ', spreadFractionForKey('hello') !== spreadFractionForKey('world'));
  const f = spreadFractionForKey('anything');
  check('in [0,1)', f >= 0 && f < 1, String(f));

  console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m\n`);
}

main()
  .catch((e) => { console.error(e); failed++; })
  .finally(() => { try { rmSync(TMP, { force: true }); } catch { /* ignore */ } process.exit(failed > 0 ? 1 : 0); });
