/**
 * Kanji JLPT Enrichment Script
 * 
 * Downloads kanji.json from davidluzgouveia/kanji-data (MIT license),
 * extracts kanji with JLPT levels, and inserts into the kanji_jlpt table.
 * 
 * Prerequisites:
 *   - 08_kanji_jlpt.sql has been run in Supabase
 *   - SUPABASE_SERVICE_ROLE_KEY is set in .env
 * 
 * Usage:
 *   node scripts/enrich_kanji_jlpt.cjs
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

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
    if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  });
}

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const KANJI_JSON_URL = 'https://raw.githubusercontent.com/davidluzgouveia/kanji-data/master/kanji.json';
const BATCH_SIZE = 500;

// ─── Helpers ─────────────────────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

function supabasePost(table, rows) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(rows);
    const url = new URL(`/rest/v1/${table}`, SUPABASE_URL);
    const options = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=minimal',
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

// ─── Main ────────────────────────────────────────────────────
async function main() {
  console.log('🔷 Kanji JLPT Enrichment');
  console.log('──────────────────────────────────');

  console.log('📥 Downloading kanji.json...');
  const data = await fetchJSON(KANJI_JSON_URL);
  
  const rows = [];
  let total = 0;
  const levelCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

  for (const [kanji, info] of Object.entries(data)) {
    total++;
    const jlpt = info.jlpt_new;
    if (jlpt != null && jlpt >= 1 && jlpt <= 5) {
      rows.push({
        kanji,
        jlpt_level: jlpt,
        grade: info.grade || null,
        strokes: info.strokes || null,
        freq: info.freq || null
      });
      levelCounts[jlpt]++;
    }
  }

  console.log(`📊 Total kanji in dataset: ${total}`);
  console.log(`📊 Kanji with JLPT levels: ${rows.length}`);
  console.log('');
  for (let l = 5; l >= 1; l--) {
    console.log(`   N${l}: ${levelCounts[l]} kanji`);
  }

  console.log('\n📤 Inserting into Supabase...');
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await supabasePost('kanji_jlpt', batch);
    console.log(`   ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length}`);
  }

  console.log('\n🎉 Done! Kanji JLPT table populated.');
  console.log('   Verify: SELECT jlpt_level, COUNT(*) FROM kanji_jlpt GROUP BY jlpt_level ORDER BY jlpt_level;');
}

main().catch(err => {
  console.error('❌ Failed:', err.message);
  process.exit(1);
});
