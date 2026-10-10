/**
 * Podcast script check (docs/podcast-design.md §4) — builds the production
 * prompt (supabase/functions/_shared/podcastPrompt.ts, bundled on the fly like
 * eval-article-rewrite.mjs does for rewritePrompt.ts) and asks Gemini for
 * scripts, reporting length vs target, turn count and validation. Gemini only —
 * no TTS spend. Source articles: the latest eval report's gemini-3.8-flash
 * rewrites (what production writes for the fixtures).
 *
 * Usage:
 *   node scripts/eval-podcast-script.mjs                         # digest of 3 fixtures, 5 min
 *   node scripts/eval-podcast-script.mjs --kind article --fixture EVAL-004 --minutes 10
 *   node scripts/eval-podcast-script.mjs --kind topic --topic 日本の電車
 *   node scripts/eval-podcast-script.mjs --runs 3                # repeat to see variance
 *   node scripts/eval-podcast-script.mjs --print                 # also print the script
 *
 * Keys: GEMINI_API_KEY or VITE_GEMINI_API_KEY (.env loaded automatically).
 */

import esbuild from 'esbuild';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { readFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

try {
  process.loadEnvFile('.env');
} catch {
  // no .env — rely on the shell environment
}

const MODEL = 'gemini-3.8-flash'; // production pin (models.ts GEMINI_FLASH)
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const kind = flag('kind', 'digest');
const minutes = Number(flag('minutes', '5'));
const runs = Number(flag('runs', '1'));
const print = args.includes('--print');

async function loadModule(entry, name) {
  const outDir = path.join('scripts', '.tmp-podcast');
  mkdirSync(outDir, { recursive: true });
  const outfile = path.join(outDir, `${name}.mjs`);
  await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent' });
  const mod = await import(pathToFileURL(path.resolve(outfile)).href + `?t=${Date.now()}`);
  return { mod, cleanup: () => rmSync(outDir, { recursive: true, force: true }) };
}

function flashOutputs() {
  const dir = 'scripts/eval-reports';
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort().reverse()) {
    const rows = JSON.parse(readFileSync(path.join(dir, f), 'utf8')).rows.filter((x) => x.model === MODEL && !x.error && x.rawText);
    if (rows.length) return new Map(rows.map((x) => [x.fixtureId, x]));
  }
  throw new Error(`no ${MODEL} rows in ${dir} — run the eval harness first`);
}

function fixtureItem(rows, id) {
  const file = readdirSync('scripts/eval-fixtures').filter((f) => f.endsWith('.json'))
    .find((f) => JSON.parse(readFileSync(path.join('scripts/eval-fixtures', f), 'utf8')).id === id);
  const fixture = JSON.parse(readFileSync(path.join('scripts/eval-fixtures', file), 'utf8'));
  const raw = rows.get(id).rawText.trim().replace(/^```(?:json)?|```$/g, '');
  const blocks = JSON.parse(raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1));
  return {
    item: { title: fixture.source.title, text: blocks.filter((b) => b.type === 'paragraph').map((b) => b.text).join('\n\n') },
    level: fixture.profile.jlptLevel,
  };
}

const prompt = await loadModule('supabase/functions/_shared/podcastPrompt.ts', 'podcastPrompt');
const cast = await loadModule('supabase/functions/_shared/podcastCast.ts', 'podcastCast');
const { buildPodcastPrompt, normalizeScript, CHARS_PER_MINUTE } = prompt.mod;
const { pickPairing } = cast.mod;

const rows = flashOutputs();
const fixtureIds = kind === 'digest' ? ['EVAL-004', 'EVAL-006', 'EVAL-010'] : [flag('fixture', 'EVAL-004')];
const loaded = kind === 'topic' ? [] : fixtureIds.map((id) => fixtureItem(rows, id));
const jlptLevel = Number(flag('level', loaded[0]?.level ?? 4));
const targetChars = minutes * CHARS_PER_MINUTE;

const key = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY;
if (!key) throw new Error('GEMINI_API_KEY (or VITE_GEMINI_API_KEY) is required');
const model = new GoogleGenerativeAI(key).getGenerativeModel({
  model: MODEL,
  generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 32768 },
});

const history = [];
for (let r = 0; r < runs; r++) {
  const { host, guest } = pickPairing(history);
  history.unshift({ host: host.id, guest: guest.id });
  const input = {
    kind,
    jlptLevel,
    host,
    guest,
    topic: flag('topic', '日本の電車'),
    items: loaded.map((l) => l.item),
    targetChars,
    dateLabel: '10月9日',
  };
  const t0 = Date.now();
  const res = await model.generateContent(buildPodcastPrompt(input));
  const text = res.response.text().replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '');
  let verdict;
  let script;
  try {
    script = normalizeScript(JSON.parse(text), input);
    verdict = 'valid';
  } catch (e) {
    verdict = `INVALID (${e.message})`;
    try {
      script = JSON.parse(text);
    } catch {
      script = { turns: [] };
    }
  }
  const chars = (script.turns ?? []).reduce((n, t) => n + (t.text?.length ?? 0), 0);
  const estMin = (chars / CHARS_PER_MINUTE).toFixed(1);
  console.log(
    `run ${r + 1}: ${host.name}×${guest.name} · ${kind} · target ${targetChars} chars → ${chars} (${Math.round((chars / targetChars) * 100)}%, ≈${estMin} min) · ${script.turns?.length ?? 0} turns · ${verdict} · ${Date.now() - t0}ms · ${script.title ?? ''}`,
  );
  if (print) for (const t of script.turns ?? []) console.log(`  ${t.speaker === 'host' ? host.name : guest.name}: ${t.text}`);
}
prompt.cleanup();
cast.cleanup();
