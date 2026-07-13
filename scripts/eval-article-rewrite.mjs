/**
 * process-article rewrite eval harness (issue #65).
 *
 * Scores the Pass-1 article-rewrite on a fixed golden set and produces a
 * per-model scorecard — the yardstick the prompt restructure (#66) is measured
 * against, and the evidence for the flash-vs-pro decision.
 *
 * DESIGN — freeze the palette, isolate the variable. The harness measures the
 * *rewrite (prompt + model)* only, NOT the palette pipeline (Groq keywords →
 * JMDict → bucketing). Each fixture (scripts/eval-fixtures/*.json) ships a frozen
 * palette + profile, so the harness makes NO Supabase/Groq calls — only Gemini.
 * The prompt is built by the SAME shared module the edge function ships
 * (supabase/functions/_shared/rewritePrompt.ts), bundled on the fly, so what we
 * score is exactly what production sends.
 *
 * Usage:
 *   node scripts/eval-article-rewrite.mjs                      # all fixtures, model=flash, judge on
 *   node scripts/eval-article-rewrite.mjs --models flash,pro   # flash-vs-pro scorecard
 *   node scripts/eval-article-rewrite.mjs --fixture EVAL-001   # a single case
 *   node scripts/eval-article-rewrite.mjs --judge off          # deterministic scores only
 *   node scripts/eval-article-rewrite.mjs --print-prompt EVAL-001   # offline: print the built prompt, no API
 *   node scripts/eval-article-rewrite.mjs --list-models        # print the ids your key can call
 *
 * Requires GEMINI_API_KEY in the environment (or a .env with it). Makes REAL,
 * paid Gemini calls: ~1 rewrite + ~1 judge call per (fixture × model). A full run
 * over N fixtures and M models is N×M rewrites + N×M judge calls.
 *
 * Reports print to stdout; a full JSON report is written to
 * scripts/eval-reports/<runId>.json (git-ignored).
 */

import esbuild from 'esbuild';
import kuromoji from '@sglkc/kuromoji';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

// ── Model registry ───────────────────────────────────────────────────────────
// Aliases → live API model ids (confirmed via --list-models, July 2026), plus
// per-1M-token USD pricing. See docs/phase-c-eval-notes.md for the landscape.
//   flash → gemini-3.5-flash        : GA, stable, the current pin ($1.50/$9).
//   pro   → gemini-3.1-pro-preview  : newest Pro tier this key exposes (flash-vs-pro target).
//   (there is NO gemini-3.1-pro or gemini-3.5-pro id — the 3.1 pro ships as -preview.)
// Run `--list-models` to refresh these against your key.
const MODEL_ALIASES = {
  flash: 'gemini-3.5-flash',
  pro: 'gemini-3.1-pro-preview',
  'pro-3': 'gemini-3-pro-preview',
  'pro-2.5': 'gemini-2.5-pro',
  'flash-lite': 'gemini-3.1-flash-lite',
  'flash-3': 'gemini-3-flash-preview',
};
// USD per 1,000,000 tokens (in / out). Values marked "est." lack a confirmed
// public price row — verify before quoting. Unknown models report cost as n/a.
const PRICES = {
  'gemini-3.5-flash': { in: 1.5, out: 9 },
  'gemini-3.1-pro-preview': { in: 4, out: 20 }, // est.
  'gemini-3-pro-preview': { in: 4, out: 20 }, // est.
  'gemini-2.5-pro': { in: 1.25, out: 10 },
  'gemini-3.1-flash-lite': { in: 0.3, out: 2.5 }, // est.
  'gemini-3-flash-preview': { in: 1, out: 6 }, // est.
};
const DEFAULT_JUDGE = 'gemini-3.1-pro-preview';
// Generous cap so *thinking* models (e.g. 3.1-pro-preview burns ~2.7k thought
// tokens) don't truncate the JSON answer before its closing bracket.
const MAX_OUTPUT_TOKENS = 8192;

// reading_intensity → known/review/new token-share (mirrors process-article/index.ts).
const INTENSITY_RATIOS = {
  leisure: { known: 0.98, review: 0.015, new: 0.005 },
  balanced: { known: 0.95, review: 0.04, new: 0.01 },
  intensive: { known: 0.9, review: 0.08, new: 0.02 },
};

const FIXTURES_DIR = 'scripts/eval-fixtures';
const REPORTS_DIR = 'scripts/eval-reports';
const TMP_BUNDLE = '.tmp_rewrite_prompt.mjs';

// ── CLI parsing ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  return {
    models: (get('--models') ?? 'flash').split(',').map((s) => s.trim()).filter(Boolean),
    judge: get('--judge') ?? DEFAULT_JUDGE, // 'off' to disable
    fixtureId: get('--fixture'), // single fixture by id
    printPrompt: get('--print-prompt'), // fixture id → print prompt and exit (offline)
    listModels: argv.includes('--list-models'), // print the key's generateContent models and exit
    out: get('--out'),
  };
}

// List the model ids the current API key can call generateContent on. Use this to
// discover the real `pro`/`flash` ids to pass to --models (they change over time).
async function listModels(apiKey) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=1000`);
  if (!res.ok) throw new Error(`ListModels ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return (j.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m) => m.name.replace('models/', ''))
    .sort();
}

// ── Load the SHIPPED prompt builder (bundle the real .ts) ─────────────────────
async function loadPromptBuilder() {
  await esbuild.build({
    entryPoints: ['supabase/functions/_shared/rewritePrompt.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: TMP_BUNDLE,
    logLevel: 'silent',
  });
  return import(pathToFileURL(TMP_BUNDLE).href);
}

function buildTokenizer() {
  const pkg = require.resolve('@sglkc/kuromoji/package.json');
  const dicPath = path.join(path.dirname(pkg), 'dict');
  return new Promise((resolve, reject) => {
    kuromoji.builder({ dicPath }).build((err, t) => (err ? reject(err) : resolve(t)));
  });
}

function loadFixtures(fixtureId) {
  const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json'));
  let fixtures = files.map((f) => JSON.parse(readFileSync(path.join(FIXTURES_DIR, f), 'utf8')));
  fixtures.sort((a, b) => a.id.localeCompare(b.id));
  if (fixtureId) fixtures = fixtures.filter((x) => x.id === fixtureId);
  return fixtures;
}

// Assemble the RewriteInput the shared builder expects from a fixture. Mirrors
// how process-article/index.ts maps user_preferences + palette onto the prompt.
function toRewriteInput(fx) {
  const p = fx.profile;
  const ratios = INTENSITY_RATIOS[p.readingIntensity] ?? INTENSITY_RATIOS.balanced;
  const reviewPalette = fx.palette.review ?? [];
  return {
    title: fx.source.title,
    sourceText: fx.source.text,
    targetParagraphs: p.targetParagraphs,
    jlptLevel: p.jlptLevel,
    rtkLevel: p.rtkLevel,
    studyMode: p.studyMode,
    vocabMode: p.vocabMode,
    ratios,
    targetReview: fx.palette.targetReview ?? 1,
    targetNew: fx.palette.targetNew ?? 1,
    knownPalette: fx.palette.known ?? [],
    reviewPalette,
    newPalette: fx.palette.new ?? [],
    vocabTargets: reviewPalette.slice(0, 5), // mirrors index.ts: vocabTargets = reviewPalette.slice(0,5)
    // New cluster path (docs/vocab-palette-redesign.md): undefined for legacy fixtures →
    // the shared builder renders the old flat palette unchanged. A fixture that ships
    // `palette.clusters` exercises the concept-cluster prompt production now sends.
    clusters: fx.palette.clusters,
  };
}

// ── Deterministic scorers (no API) ───────────────────────────────────────────
// Strip the ```json fence the model sometimes adds (mirrors index.ts line ~455).
function stripFence(raw) {
  return String(raw).replace(/^```(json)?[\s\n]*/i, '').replace(/[\s\n]*```$/i, '').trim();
}

// Extract the first balanced JSON value ([...] or {...}) from model text,
// tolerating ```fences``` and any trailing prose a *thinking* model appends after
// the JSON (the judge does this). If no balanced value is found — e.g. the output
// was truncated before its closing bracket — returns from the opening bracket so
// the caller's JSON.parse still surfaces the real (truncation) error.
function extractJsonValue(raw) {
  const s = stripFence(raw);
  const start = s.search(/[\[{]/);
  if (start === -1) return s;
  const open = s[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return s.slice(start); // unbalanced (truncated) — let JSON.parse report it
}

function parseBlocks(raw) {
  try {
    const blocks = JSON.parse(extractJsonValue(raw));
    if (!Array.isArray(blocks)) return { ok: false, error: 'not an array', blocks: [] };
    const bad = blocks.find((b) => {
      if (!b || typeof b.type !== 'string') return true;
      // Per the prompt's output schema, paragraph blocks carry the article `text`;
      // yugen-box blocks carry keyword/reading/description instead (no `text`).
      if (b.type === 'paragraph') return typeof b.text !== 'string';
      if (b.type === 'yugen-box') return typeof b.keyword !== 'string' && typeof b.description !== 'string';
      return false; // unknown block types don't fail validity
    });
    if (bad) return { ok: false, error: 'malformed block', blocks };
    return { ok: true, blocks };
  } catch (e) {
    return { ok: false, error: e.message, blocks: [] };
  }
}

const MARKUP_RE = /[\[\]()（）【】〔〕]/; // ASCII + full-width brackets/parens; 「」 quotes are allowed
function paragraphText(blocks) {
  return blocks.filter((b) => b.type === 'paragraph').map((b) => b.text).join('\n');
}
function allText(blocks) {
  // yugen-box blocks have no `text` — fall back to their keyword/description so
  // regression assertions can scan them too.
  return blocks.map((b) => b.text ?? [b.keyword, b.description].filter(Boolean).join(': ')).join('\n');
}

function scoreDeterministic(raw, fx, tokenizer) {
  const parsed = parseBlocks(raw);
  const out = {
    jsonOk: parsed.ok,
    jsonError: parsed.ok ? null : parsed.error,
    markupClean: null,
    markupOffenders: [],
    paragraphs: 0,
    paragraphOk: null,
    yugenBoxes: 0,
    yugenOk: null,
    palette: null,
    assertions: { total: 0, failed: [] },
  };
  if (!parsed.ok) return out;
  const blocks = parsed.blocks;

  const paras = blocks.filter((b) => b.type === 'paragraph');
  out.paragraphs = paras.length;
  out.paragraphOk = Math.abs(paras.length - fx.profile.targetParagraphs) <= 1;
  out.yugenBoxes = blocks.filter((b) => b.type === 'yugen-box').length;
  out.yugenOk = out.yugenBoxes >= 1;

  const offenders = paras.filter((b) => MARKUP_RE.test(b.text)).map((b) => b.text.slice(0, 40));
  out.markupClean = offenders.length === 0;
  out.markupOffenders = offenders;

  // Palette adherence — substring hits of each frozen palette word in the body,
  // plus an approximate known-token share (kuromoji surfaces ∈ known set / total).
  const body = paragraphText(blocks);
  const hits = (list) => (list ?? []).filter((w) => body.includes(w));
  const knownHit = hits(fx.palette.known);
  const reviewHit = hits(fx.palette.review);
  const newHit = hits(fx.palette.new);
  const tokens = tokenizer.tokenize(body);
  const contentTokens = tokens.filter((t) => t.pos === '名詞' || t.pos === '動詞' || t.pos === '形容詞');
  const knownSet = new Set(fx.palette.known ?? []);
  const knownTokenShare = contentTokens.length
    ? contentTokens.filter((t) => knownSet.has(t.surface_form)).length / contentTokens.length
    : 0;
  out.palette = {
    knownUsed: knownHit.length,
    knownTotal: (fx.palette.known ?? []).length,
    reviewUsed: reviewHit.length,
    reviewTarget: fx.palette.targetReview ?? 0,
    newUsed: newHit.length,
    newTarget: fx.palette.targetNew ?? 0,
    knownTokenShare: Number(knownTokenShare.toFixed(3)),
    reviewWords: reviewHit,
    newWords: newHit,
  };

  // Regression assertions — mustNotContain over ALL output text.
  const full = allText(blocks);
  const mustNot = fx.assertions?.mustNotContain ?? [];
  out.assertions.total = mustNot.length;
  out.assertions.failed = mustNot.filter((pat) => new RegExp(pat).test(full));
  return out;
}

// ── LLM judge (subjective axes) ──────────────────────────────────────────────
function buildJudgePrompt(fx, blocks) {
  const body = blocks
    .map((b) => (b.type === 'paragraph' ? b.text : `[yugen-box] ${b.keyword ?? ''}: ${b.description ?? ''}`))
    .join('\n');
  return `You are grading a Japanese news article written for a JLPT N${fx.profile.jlptLevel} learner, rewritten from an English source. Score three axes from 1 (poor) to 5 (excellent) and give a one-line reason for each.

- factualFidelity: does the article report ONLY facts present in the source, inventing nothing?
- jlptFit: is the grammar/vocabulary appropriate for a JLPT N${fx.profile.jlptLevel} reader — neither too hard nor over-simplified?
- naturalness: does it read like fluent, natural Japanese news prose?

ENGLISH SOURCE:
${fx.source.text}

JAPANESE ARTICLE:
${body}

Respond with ONLY this JSON: {"factualFidelity":<1-5>,"jlptFit":<1-5>,"naturalness":<1-5>,"notes":{"factualFidelity":"...","jlptFit":"...","naturalness":"..."}}`;
}

async function runJudge(genAI, judgeModelId, fx, blocks) {
  const model = genAI.getGenerativeModel({
    model: judgeModelId,
    generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: MAX_OUTPUT_TOKENS },
  });
  const res = await model.generateContent(buildJudgePrompt(fx, blocks));
  const parsed = JSON.parse(extractJsonValue(res.response.text()));
  const usage = res.response.usageMetadata ?? {};
  return { scores: parsed, usage };
}

// ── Cost helper ──────────────────────────────────────────────────────────────
function costUSD(modelId, usage) {
  const price = PRICES[modelId];
  if (!price || !usage) return null;
  const inTok = usage.promptTokenCount ?? 0;
  const outTok = usage.candidatesTokenCount ?? ((usage.totalTokenCount ?? 0) - inTok);
  return (inTok / 1e6) * price.in + (outTok / 1e6) * price.out;
}

// ── Aggregation + reporting ──────────────────────────────────────────────────
function mean(nums) {
  const xs = nums.filter((n) => typeof n === 'number' && !Number.isNaN(n));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}
function fmt(n, digits = 2) {
  return typeof n === 'number' && !Number.isNaN(n) ? n.toFixed(digits) : 'n/a';
}
function pctFmt(nums) {
  const xs = nums.filter((v) => v !== null && v !== undefined);
  if (!xs.length) return 'n/a';
  return `${((xs.filter(Boolean).length / xs.length) * 100).toFixed(0)}%`;
}

function printScorecard(byModel) {
  console.log('\n════════════════════════ SCORECARD (averaged over fixtures) ════════════════════════');
  for (const [model, rows] of Object.entries(byModel)) {
    const ok = rows.filter((r) => !r.error);
    const det = ok.map((r) => r.deterministic).filter(Boolean);
    const judged = ok.map((r) => r.judge).filter(Boolean);
    console.log(`\n■ ${model}  (${rows.length} fixtures, ${rows.filter((r) => r.error).length} errored)`);
    console.log(`  json valid     ${pctFmt(det.map((d) => d.jsonOk))}`);
    console.log(`  markup clean   ${pctFmt(det.map((d) => d.markupClean))}`);
    console.log(`  paragraph ok   ${pctFmt(det.map((d) => d.paragraphOk))}`);
    console.log(`  yugen-box ok   ${pctFmt(det.map((d) => d.yugenOk))}`);
    const assertRows = det.filter((d) => d.assertions.total > 0);
    console.log(`  assertions     ${assertRows.length ? pctFmt(assertRows.map((d) => d.assertions.failed.length === 0)) : 'none'}`);
    console.log(`  known share    ${fmt(mean(det.map((d) => d.palette?.knownTokenShare)) * 100, 1)}%`);
    console.log(`  review used    ${fmt(mean(det.map((d) => d.palette?.reviewUsed)), 1)} / target ${fmt(mean(det.map((d) => d.palette?.reviewTarget)), 1)}`);
    console.log(`  new used       ${fmt(mean(det.map((d) => d.palette?.newUsed)), 1)} / target ${fmt(mean(det.map((d) => d.palette?.newTarget)), 1)}`);
    const judgeErrs = ok.filter((r) => r.judgeError).length;
    if (judged.length || judgeErrs) {
      console.log(`  judged         ${judged.length}/${ok.length}${judgeErrs ? `  (${judgeErrs} judge errors)` : ''}`);
    }
    if (judged.length) {
      console.log(`  fidelity       ${fmt(mean(judged.map((j) => j.scores.factualFidelity)))} / 5`);
      console.log(`  jlpt fit       ${fmt(mean(judged.map((j) => j.scores.jlptFit)))} / 5`);
      console.log(`  naturalness    ${fmt(mean(judged.map((j) => j.scores.naturalness)))} / 5`);
    }
    console.log(`  latency        ${fmt(mean(ok.map((r) => r.latencyMs)), 0)} ms avg`);
    const costs = ok.map((r) => r.costUSD).filter((c) => c !== null);
    console.log(`  cost/article   ${costs.length ? '$' + fmt(mean(costs), 5) : 'n/a'}   (run total $${fmt(costs.reduce((a, b) => a + b, 0), 4)})`);
  }
  console.log('\n═════════════════════════════════════════════════════════════════════════════════════\n');
}

function printFixtureDetail(rows) {
  console.log('── per-fixture ──');
  for (const r of rows) {
    if (r.error) {
      console.log(`  ✗ ${r.fixtureId} [${r.model}] ERROR: ${r.error}`);
      continue;
    }
    const d = r.deterministic;
    const flags = [];
    if (!d.jsonOk) flags.push(`json:${d.jsonError}`);
    if (d.markupClean === false) flags.push('markup');
    if (d.paragraphOk === false) flags.push(`paras=${d.paragraphs}`);
    if (d.yugenOk === false) flags.push('no-yugen');
    if (d.assertions.failed.length) flags.push(`ASSERT-FAIL:${d.assertions.failed.join(',')}`);
    const j = r.judge
      ? ` fid=${r.judge.scores.factualFidelity} jlpt=${r.judge.scores.jlptFit} nat=${r.judge.scores.naturalness}`
      : (r.judgeError ? ' judge:ERR' : '');
    const status = flags.length ? `⚠ ${flags.join(' ')}` : '✓';
    console.log(`  ${status}  ${r.fixtureId} [${r.model}] review ${d.palette?.reviewUsed}/${d.palette?.reviewTarget} new ${d.palette?.newUsed}/${d.palette?.newTarget}${j}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));

  // --list-models: discover the ids this key supports, then exit (no bundle needed).
  if (args.listModels) {
    const apiKey = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY;
    if (!apiKey) {
      console.error('GEMINI_API_KEY (or VITE_GEMINI_API_KEY) is required for --list-models.');
      process.exit(1);
    }
    const models = await listModels(apiKey);
    console.log(models.join('\n'));
    return;
  }

  const { buildRewritePrompt } = await loadPromptBuilder();
  const fixtures = loadFixtures(args.printPrompt ?? args.fixtureId);
  if (!fixtures.length) {
    console.error('No fixtures matched.');
    rmSync(TMP_BUNDLE, { force: true });
    process.exit(1);
  }

  // Offline mode: print the built prompt for one fixture and exit (no API key needed).
  if (args.printPrompt) {
    const prompt = buildRewritePrompt(toRewriteInput(fixtures[0]));
    console.log(prompt);
    rmSync(TMP_BUNDLE, { force: true });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY (or VITE_GEMINI_API_KEY) is required. Set it in your env or .env.');
    console.error('Tip: `node scripts/eval-article-rewrite.mjs --print-prompt EVAL-001` works offline (no key, no API calls).');
    rmSync(TMP_BUNDLE, { force: true });
    process.exit(1);
  }

  const modelIds = args.models.map((m) => MODEL_ALIASES[m] ?? m);
  const judgeOn = args.judge !== 'off';
  const judgeModelId = MODEL_ALIASES[args.judge] ?? args.judge;

  console.log(`Fixtures: ${fixtures.length}  Models: ${modelIds.join(', ')}  Judge: ${judgeOn ? judgeModelId : 'off'}`);
  console.log(`⚠ This makes real, paid Gemini calls: ~${fixtures.length * modelIds.length} rewrite + ~${judgeOn ? fixtures.length * modelIds.length : 0} judge calls.\n`);

  const genAI = new GoogleGenerativeAI(apiKey);
  const tokenizer = await buildTokenizer();

  const byModel = {};
  const allRows = [];
  for (const modelId of modelIds) {
    byModel[modelId] = [];
    for (const fx of fixtures) {
      const input = toRewriteInput(fx);
      const prompt = buildRewritePrompt(input);
      const row = { fixtureId: fx.id, model: modelId, error: null };
      try {
        const model = genAI.getGenerativeModel({
          model: modelId,
          generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: MAX_OUTPUT_TOKENS },
        });
        const t0 = performance.now();
        const res = await model.generateContent(prompt);
        row.latencyMs = performance.now() - t0;
        const raw = res.response.text();
        const usage = res.response.usageMetadata ?? {};
        row.usage = usage;
        row.costUSD = costUSD(modelId, usage);
        row.deterministic = scoreDeterministic(raw, fx, tokenizer);
        row.rawText = raw;
        if (judgeOn && row.deterministic.jsonOk) {
          try {
            row.judge = await runJudge(genAI, judgeModelId, fx, row.deterministic ? parseBlocks(raw).blocks : []);
          } catch (je) {
            row.judgeError = je.message;
          }
        }
        process.stdout.write(row.deterministic.jsonOk ? '.' : 'x');
      } catch (e) {
        row.error = e.message;
        process.stdout.write('E');
      }
      byModel[modelId].push(row);
      allRows.push(row);
    }
  }
  console.log('');

  printScorecard(byModel);
  printFixtureDetail(allRows);

  // Write full JSON report (raw output trimmed for size).
  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = args.out ?? path.join(REPORTS_DIR, `${runId}.json`);
  const report = {
    runId,
    models: modelIds,
    judge: judgeOn ? judgeModelId : null,
    fixtures: fixtures.map((f) => f.id),
    rows: allRows.map((r) => ({ ...r, rawText: (r.rawText ?? '').slice(0, 4000) })),
  };
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Full report → ${outPath}`);

  rmSync(TMP_BUNDLE, { force: true });
}

main().catch((e) => {
  console.error(e);
  rmSync(TMP_BUNDLE, { force: true });
  process.exit(1);
});
