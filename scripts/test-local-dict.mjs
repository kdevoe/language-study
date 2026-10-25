/**
 * Checks the on-device dictionary against the full tables it was trimmed from.
 *
 *   node scripts/build-jmdict-offline.mjs   (leaves the raw export in the temp dir)
 *   node scripts/test-local-dict.mjs
 *
 * For EVERY entry, the word panel's details (reading, meaning, POS, JLPT, furigana)
 * built from the local copy must equal those built from the full rows the way
 * fetchEntries shapes them. For every surface with several entries, pickBestEntry
 * must choose the same one (each coarse POS, kanji and kana lemmas), so offline
 * enrichment links the same words. Exits non-zero on any mismatch.
 */
import esbuild from 'esbuild';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath, pathToFileURL } from 'url';

const root = path.resolve(fileURLToPath(import.meta.url), '../..');
const cacheDir = path.join(os.tmpdir(), 'yugen-jmdict-export');
const outDir = path.join(root, 'public', 'jmdict');

// jmdict.ts imports the Supabase client; nothing here queries it.
const stubSupabase = {
  name: 'stub-supabase',
  setup(build) {
    build.onResolve({ filter: /\/supabase$/ }, () => ({ path: 'supabase', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const supabase = {};', loader: 'js' }));
  },
};
const bundle = path.join(os.tmpdir(), 'yugen-test-local-dict.mjs');
await esbuild.build({
  stdin: {
    contents: `export { jmdictToWordDetails, pickBestEntry } from './src/services/jmdict';
               export { fromRow, toResult } from './src/services/localDict';`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: bundle,
  plugins: [stubSupabase],
  logLevel: 'error',
});
const { jmdictToWordDetails, pickBestEntry, fromRow, toResult } = await import(pathToFileURL(bundle).href);

const load = (t) => JSON.parse(fs.readFileSync(path.join(cacheDir, `${t}.json`), 'utf8'));
const group = (rows) => {
  const m = new Map();
  for (const r of rows.sort((a, b) => a.id - b.id)) {
    if (!m.has(r.entry_id)) m.set(r.entry_id, []);
    m.get(r.entry_id).push(r);
  }
  return m;
};
const entries = load('jmdict_entries');
const kanji = group(load('jmdict_kanji'));
const kana = group(load('jmdict_kana'));
const senses = group(load('jmdict_senses'));

// Server shape, as fetchEntries builds it.
const full = new Map(entries.map((e) => [e.id, {
  entryId: e.id,
  kanji: (kanji.get(e.id) ?? []).map((k) => k.text),
  readings: (kana.get(e.id) ?? []).map((k) => k.text),
  senses: (senses.get(e.id) ?? []).map((s) => ({ pos: s.pos || [], gloss: s.gloss || [], field: [], misc: s.misc || [] })),
  jlptLevel: e.jlpt_level,
  freqRank: e.freq_rank ?? null,
  isCommon: e.common || false,
}]));

const local = new Map();
const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
for (const shard of manifest.shards) {
  for (const row of JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(outDir, shard))).toString())) {
    const r = toResult(fromRow(row));
    local.set(r.entryId, r);
  }
}

let failures = 0;
const fail = (msg) => { if (failures++ < 20) console.error('✗', msg); };

if (local.size !== full.size) fail(`entry count ${local.size} ≠ ${full.size}`);

// 1. Word-panel details for every entry.
const detailKeys = ['reading', 'meaning', 'pos', 'jlptLevel', 'freqRank', 'furiganaMap'];
for (const [id, f] of full) {
  const l = local.get(id);
  if (!l) { fail(`${id} missing locally`); continue; }
  const surface = f.kanji[0] ?? f.readings[0] ?? '';
  const a = jmdictToWordDetails(surface, f);
  const b = jmdictToWordDetails(surface, l);
  for (const k of detailKeys) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) fail(`${id} ${surface} ${k}: ${JSON.stringify(a[k])} ≠ ${JSON.stringify(b[k])}`);
  }
}

// 2. Same pick among homographs, as lookupLemmasBatch makes it.
const bySurface = (m) => {
  const out = new Map();
  for (const [id, rows] of m) for (const r of rows) {
    if (!out.has(r.text)) out.set(r.text, new Set());
    out.get(r.text).add(id);
  }
  return out;
};
let picks = 0;
for (const [forms, kanaLemma] of [[bySurface(kanji), false], [bySurface(kana), true]]) {
  for (const [text, ids] of forms) {
    if (ids.size < 2) continue;
    for (const pos of [undefined, 'verb', 'noun', 'adjective', 'adverb']) {
      const a = pickBestEntry([...ids].map((id) => full.get(id)), pos, kanaLemma).entryId;
      const b = pickBestEntry([...ids].map((id) => local.get(id)), pos, kanaLemma).entryId;
      picks++;
      if (a !== b) fail(`pick ${text} (${pos ?? 'any'}): ${a} ≠ ${b}`);
    }
  }
}

if (failures) {
  console.error(`\n${failures} mismatch(es).`);
  process.exit(1);
}
console.log(`✓ ${full.size} entries match on ${detailKeys.join(', ')}; ${picks} homograph picks match.`);
