/**
 * Word Frequency Backfill
 *
 * jmdict-simplified discards JMDict's frequency bands (it keeps only a `common`
 * boolean). This script reads the granular `nf01`..`nf48` frequency-of-use bands
 * from the ORIGINAL EDRDG JMdict_e.xml, computes the best (lowest) band per entry,
 * and backfills `jmdict_entries.freq_rank` by an exact id match.
 *
 * The XML's <ent_seq> equals jmdict_entries.id, so this is a pure UPDATE -- it does
 * NOT touch jmdict_kanji / jmdict_kana / jmdict_senses. Run the regular
 * scripts/import_jmdict.cjs FIRST so the entries exist, and apply
 * database/12_word_frequency.sql so the column exists.
 *
 * Requirements:
 *   - SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env (service role bypasses RLS)
 *
 * Usage:
 *   node scripts/import_word_frequency.cjs
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ─── Load .env ───────────────────────────────────────────────
const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) return;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes, repeatedly, to tolerate double-wrapped values
    // like "'https://...'" (outer " then inner ').
    while (
      val.length >= 2 &&
      ((val[0] === "'" && val[val.length - 1] === "'") ||
        (val[0] === '"' && val[val.length - 1] === '"'))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  });
}

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  console.error('   The service role key is required to bypass RLS for the UPDATE.');
  process.exit(1);
}

// ─── Config ──────────────────────────────────────────────────
// EDRDG distributes the English-only gzipped XML over plain HTTP from its ftp mirror.
const DOWNLOAD_URL = 'http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz';
const TMP_DIR = path.resolve(__dirname, '..', 'tmp');
const GZ_PATH = path.join(TMP_DIR, 'JMdict_e.gz');
const BATCH_SIZE = 500;

// ─── HTTP Helpers ────────────────────────────────────────────
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const doRequest = (reqUrl) => {
      const lib = reqUrl.startsWith('https') ? https : http;
      lib.get(reqUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          doRequest(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${reqUrl}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', reject);
    };
    doRequest(url);
  });
}

// Upsert with merge-duplicates: only `id` and `freq_rank` are sent, so PostgREST
// updates freq_rank on conflict and leaves every other column (e.g. `common`) intact.
function supabaseUpsert(rows) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(rows);
    const url = new URL('/rest/v1/jmdict_entries?on_conflict=id', SUPABASE_URL);
    const options = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'resolution=merge-duplicates,return=minimal',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`Supabase ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function batchUpsert(rows) {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await supabaseUpsert(batch);
    process.stdout.write(`\r   upserted ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length}`);
  }
  process.stdout.write('\n');
}

// ─── XML parsing ─────────────────────────────────────────────
// Pull the lowest nf## band out of one <entry>...</entry> block.
const SEQ_RE = /<ent_seq>(\d+)<\/ent_seq>/;
const NF_RE = /<(?:ke|re)_pri>nf(\d{2})<\/(?:ke|re)_pri>/g;

function parseEntry(block, out) {
  const seqM = block.match(SEQ_RE);
  if (!seqM) return;
  let min = 99;
  let m;
  NF_RE.lastIndex = 0;
  while ((m = NF_RE.exec(block)) !== null) {
    const n = parseInt(m[1], 10);
    if (n < min) min = n;
  }
  if (min === 99) return; // no nf band on this entry
  out.push({ id: seqM[1], freq_rank: min });
}

// Stream the gunzipped XML and split on </entry> so we never hold the whole file.
function parseFrequencies(gzPath) {
  return new Promise((resolve, reject) => {
    const out = [];
    let buffer = '';
    const stream = fs.createReadStream(gzPath).pipe(zlib.createGunzip());
    stream.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('</entry>')) !== -1) {
        parseEntry(buffer.slice(0, idx), out);
        buffer = buffer.slice(idx + '</entry>'.length);
      }
    });
    stream.on('end', () => resolve(out));
    stream.on('error', reject);
  });
}

// ─── Main ────────────────────────────────────────────────────
async function main() {
  console.log('🔷 JMDict Word Frequency Backfill');
  console.log('──────────────────────────────────');

  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

  if (fs.existsSync(GZ_PATH)) {
    console.log('📦 Using cached download at', GZ_PATH);
  } else {
    console.log('⬇️  Downloading JMdict_e.xml.gz from EDRDG...');
    await download(DOWNLOAD_URL, GZ_PATH);
    console.log('✅ Downloaded to', GZ_PATH);
  }

  console.log('📄 Parsing frequency bands (streaming)...');
  const updates = await parseFrequencies(GZ_PATH);
  console.log(`📊 ${updates.length} entries carry an nf## frequency band`);

  // Sanity: show the band distribution so a bad parse is obvious.
  const byBand = {};
  for (const u of updates) byBand[u.freq_rank] = (byBand[u.freq_rank] || 0) + 1;
  console.log(`   nf01: ${byBand[1] || 0}, nf24: ${byBand[24] || 0}, nf48: ${byBand[48] || 0} (each band holds ≤500)`);

  console.log('\n📤 Backfilling jmdict_entries.freq_rank...');
  await batchUpsert(updates);

  console.log('\n🎉 Done. Entries without an nf band keep freq_rank = NULL.');
}

main().catch(err => {
  console.error('\n❌ Backfill failed:', err.message);
  process.exit(1);
});
