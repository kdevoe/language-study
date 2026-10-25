/**
 * Build the on-device dictionary (docs/offline-mode-plan.md › Offline word lookups):
 *   public/jmdict/manifest.json   — version, counts, shard names, kanji_jlpt
 *   public/jmdict/entries-NN.json.gz — JMDict entries, trimmed to what lookups use
 *
 * Read from the Supabase tables (the server stays the source of truth), so rerun
 * it after a JMDict import or a JLPT retag. The client (services/localDict.ts)
 * reimports when the manifest's version changes.
 *
 * Trimming keeps lookups identical to the server path: summarizeSenses reads the
 * first 3 glosses of a lone sense or the first gloss of up to 4 senses; posMatches
 * and jmdictToWordDetails read the union of POS codes; isKanaPrimary reads 'uk'.
 * So an entry keeps its glossed senses (max 4; 3 glosses on the first, 1 on the
 * rest), with the POS union and the 'uk' flag on the first sense.
 *
 * Entry row: [id, kanji[], kana[], glosses[][], pos[], uk(0|1), jlpt|null, freq|null, common(0|1)]
 *
 * Needs SUPABASE_SERVICE_ROLE_KEY in .env. Raw table exports are cached under
 * the OS temp dir; pass --refresh to fetch them again.
 *
 * Run: node scripts/build-jmdict-offline.mjs [--refresh]
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const root = path.resolve(fileURLToPath(import.meta.url), '../..');
const outDir = path.join(root, 'public', 'jmdict');
const cacheDir = path.join(os.tmpdir(), 'yugen-jmdict-export');
const SHARD_SIZE = 20_000;
const PAGE = 1000;

process.loadEnvFile(path.join(root, '.env'));
const unquote = (v) => (v ?? '').trim().replace(/^['"]|['"]$/g, '');
const URL_ = unquote(process.env.VITE_SUPABASE_URL);
const KEY = unquote(process.env.SUPABASE_SERVICE_ROLE_KEY);
if (!URL_ || !KEY) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

/** Every row of a table, paged by its key (keyset, so late pages stay fast). */
async function exportTable(table, select, key) {
  const file = path.join(cacheDir, `${table}.json`);
  if (fs.existsSync(file) && !process.argv.includes('--refresh')) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const rows = [];
  let last = null;
  for (;;) {
    const params = new URLSearchParams({ select, order: `${key}.asc`, limit: String(PAGE) });
    if (last != null) params.set(key, `gt.${last}`);
    const res = await fetch(`${URL_}/rest/v1/${table}?${params}`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
    });
    if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    process.stdout.write(`\r${table}: ${rows.length}`);
    if (page.length < PAGE) break;
    last = page[page.length - 1][key];
  }
  process.stdout.write('\n');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rows));
  return rows;
}

const group = (rows) => {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.entry_id)) m.set(r.entry_id, []);
    m.get(r.entry_id).push(r);
  }
  return m;
};

const entries = await exportTable('jmdict_entries', 'id,common,jlpt_level,freq_rank', 'id');
const kanji = group(await exportTable('jmdict_kanji', 'id,entry_id,text', 'id'));
const kana = group(await exportTable('jmdict_kana', 'id,entry_id,text', 'id'));
const senses = group(await exportTable('jmdict_senses', 'id,entry_id,pos,gloss,misc', 'id'));
const kanjiJlpt = await exportTable('kanji_jlpt', 'kanji,jlpt_level', 'kanji');

// Child rows in id order = the order fetchEntries returns them in (insert order).
const byId = (a, b) => a.id - b.id;
const rows = entries.map((e) => {
  const ss = (senses.get(e.id) ?? []).sort(byId);
  const glossed = ss.filter((s) => (s.gloss ?? []).length > 0).slice(0, 4);
  const glosses = glossed.map((s, i) => s.gloss.slice(0, i === 0 ? 3 : 1));
  const pos = [...new Set(ss.flatMap((s) => s.pos ?? []))];
  const uk = ss.some((s) => (s.misc ?? []).includes('uk')) ? 1 : 0;
  return [
    e.id,
    (kanji.get(e.id) ?? []).sort(byId).map((k) => k.text),
    (kana.get(e.id) ?? []).sort(byId).map((k) => k.text),
    glosses,
    pos,
    uk,
    e.jlpt_level ?? null,
    e.freq_rank ?? null,
    e.common ? 1 : 0,
  ];
});

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const hash = crypto.createHash('sha256');
const shards = [];
let raw = 0;
let gz = 0;
for (let i = 0; i < rows.length; i += SHARD_SIZE) {
  const name = `entries-${String(shards.length).padStart(2, '0')}.json.gz`;
  const json = JSON.stringify(rows.slice(i, i + SHARD_SIZE));
  const zipped = zlib.gzipSync(json, { level: 9 });
  fs.writeFileSync(path.join(outDir, name), zipped);
  hash.update(json);
  shards.push(name);
  raw += json.length;
  gz += zipped.length;
}

const kanjiLevels = Object.fromEntries(kanjiJlpt.filter((k) => k.jlpt_level != null).map((k) => [k.kanji, k.jlpt_level]));
hash.update(JSON.stringify(kanjiLevels));
const manifest = {
  version: hash.digest('hex').slice(0, 12),
  builtAt: new Date().toISOString(),
  entries: rows.length,
  shards,
  kanjiJlpt: kanjiLevels,
};
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest));

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log(`${rows.length} entries in ${shards.length} shards: ${mb(raw)} raw, ${mb(gz)} gzipped. Version ${manifest.version}.`);
