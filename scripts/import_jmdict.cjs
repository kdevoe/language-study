/**
 * JMDict-Simplified Import Script
 * 
 * Downloads the latest jmdict-eng release from GitHub, parses the JSON,
 * and batch-inserts into Supabase tables.
 * 
 * Requirements:
 *   - SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env
 *   - Run the 06_jmdict_schema.sql in Supabase SQL Editor first
 * 
 * Usage:
 *   node scripts/import_jmdict.cjs
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');

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
    // Strip surrounding quotes
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
  console.error('   The service role key is required for bulk inserts (bypasses RLS).');
  console.error('   Find it in: Supabase Dashboard > Settings > API > service_role key');
  process.exit(1);
}

// ─── Config ──────────────────────────────────────────────────
const DOWNLOAD_URL = 'https://github.com/scriptin/jmdict-simplified/releases/latest/download/jmdict-eng-3.6.2+20260406125001.json.tgz';
const TMP_DIR = path.resolve(__dirname, '..', 'tmp');
const TGZ_PATH = path.join(TMP_DIR, 'jmdict-eng.json.tgz');
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

async function batchInsert(table, rows) {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await supabasePost(table, batch);
  }
}

// ─── Main ────────────────────────────────────────────────────
async function main() {
  console.log('🔷 JMDict-Simplified Import');
  console.log('──────────────────────────────────');

  // 1. Download
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  
  if (fs.existsSync(TGZ_PATH)) {
    console.log('📦 Using cached download at', TGZ_PATH);
  } else {
    console.log('⬇️  Downloading jmdict-eng...');
    await download(DOWNLOAD_URL, TGZ_PATH);
    console.log('✅ Downloaded to', TGZ_PATH);
  }

  // 2. Extract
  console.log('📂 Extracting...');
  execSync(`tar -xzf "${TGZ_PATH}" -C "${TMP_DIR}"`);

  // Find the extracted JSON file
  const jsonFile = fs.readdirSync(TMP_DIR).find(f => f.endsWith('.json'));
  if (!jsonFile) {
    console.error('❌ No JSON file found after extraction');
    process.exit(1);
  }
  const jsonPath = path.join(TMP_DIR, jsonFile);
  console.log('📄 Parsing', jsonFile, '...');

  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const words = raw.words;
  console.log(`📊 Found ${words.length} entries`);

  // 3. Transform & Insert
  const entryRows = [];
  const kanjiRows = [];
  const kanaRows = [];
  const senseRows = [];

  for (const entry of words) {
    const entryId = String(entry.id);
    const isCommon = (entry.kanji || []).some(k => k.common) || (entry.kana || []).some(k => k.common);
    
    entryRows.push({ id: entryId, common: isCommon });

    for (const k of (entry.kanji || [])) {
      kanjiRows.push({
        entry_id: entryId,
        text: k.text,
        common: k.common || false,
        info: k.tags || []
      });
    }

    for (const k of (entry.kana || [])) {
      kanaRows.push({
        entry_id: entryId,
        text: k.text,
        common: k.common || false,
        applies_to_kanji: k.appliesToKanji || []
      });
    }

    for (const s of (entry.sense || [])) {
      const glossTexts = (s.gloss || []).map(g => typeof g === 'string' ? g : g.text);
      senseRows.push({
        entry_id: entryId,
        pos: s.partOfSpeech || [],
        field: s.field || [],
        misc: s.misc || [],
        info: s.info || [],
        gloss: glossTexts
      });
    }
  }

  console.log(`\n📤 Inserting into Supabase...`);
  console.log(`   entries: ${entryRows.length}`);
  console.log(`   kanji:   ${kanjiRows.length}`);
  console.log(`   kana:    ${kanaRows.length}`);
  console.log(`   senses:  ${senseRows.length}`);
  console.log('');

  // Insert in dependency order
  console.log('   → jmdict_entries...');
  await batchInsert('jmdict_entries', entryRows);
  console.log('   ✅ entries done');

  console.log('   → jmdict_kanji...');
  await batchInsert('jmdict_kanji', kanjiRows);
  console.log('   ✅ kanji done');

  console.log('   → jmdict_kana...');
  await batchInsert('jmdict_kana', kanaRows);
  console.log('   ✅ kana done');

  console.log('   → jmdict_senses...');
  await batchInsert('jmdict_senses', senseRows);
  console.log('   ✅ senses done');

  console.log('\n🎉 Import complete!');
  console.log(`   Total: ${entryRows.length} entries imported into Supabase.`);

  // Cleanup extracted JSON (keep .tgz for re-runs)
  fs.unlinkSync(jsonPath);
}

main().catch(err => {
  console.error('❌ Import failed:', err.message);
  process.exit(1);
});
