/**
 * JLPT Level Enrichment Script
 * 
 * Downloads N1-N5 vocab CSVs from jamsinclair/open-anki-jlpt-decks,
 * matches words to JMDict entries via kanji/kana surface forms,
 * and tags entries with jlpt_level in Supabase.
 * 
 * Prerequisites:
 *   - 07_jmdict_jlpt.sql has been run in Supabase
 *   - SUPABASE_SERVICE_ROLE_KEY is set in .env
 * 
 * Usage:
 *   node scripts/enrich_jlpt.cjs
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

// ─── CSV Sources ─────────────────────────────────────────────
const BASE_URL = 'https://raw.githubusercontent.com/jamsinclair/open-anki-jlpt-decks/main/src';
const LEVELS = [
  { file: 'n5.csv', level: 5 },
  { file: 'n4.csv', level: 4 },
  { file: 'n3.csv', level: 3 },
  { file: 'n2.csv', level: 2 },
  { file: 'n1.csv', level: 1 },
];

// ─── Helpers ─────────────────────────────────────────────────
function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  // Skip header
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    // Simple CSV parse handling quoted fields
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (const ch of lines[i]) {
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === ',' && !inQuotes) { fields.push(current); current = ''; continue; }
      current += ch;
    }
    fields.push(current);
    if (fields.length >= 2) {
      // expression may contain multiple forms separated by "; "
      const expressions = fields[0].split(/;\s*/).map(s => s.trim()).filter(Boolean);
      const readings = fields[1].split(/;\s*/).map(s => s.trim()).filter(Boolean);
      rows.push({ expressions, readings });
    }
  }
  return rows;
}

function supabaseRpc(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const url = new URL(urlPath, SUPABASE_URL);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=minimal',
      }
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`Supabase ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function supabaseGet(urlPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, SUPABASE_URL);
    const options = {
      method: 'GET',
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Accept': 'application/json',
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data));
        else reject(new Error(`Supabase GET ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── Main ────────────────────────────────────────────────────
async function main() {
  console.log('🔷 JLPT Level Enrichment');
  console.log('──────────────────────────────────');

  let totalMatched = 0;
  let totalWords = 0;

  // Process from N5 → N1. If a word appears in multiple levels, 
  // the hardest (lowest number) wins since we process N1 last.
  for (const { file, level } of LEVELS) {
    const url = `${BASE_URL}/${file}`;
    console.log(`\n📥 Downloading ${file}...`);
    const text = await fetchText(url);
    const words = parseCSV(text);
    console.log(`   ${words.length} words in N${level}`);
    totalWords += words.length;

    let matched = 0;
    let batch = [];
    
    for (const word of words) {
      // Try to find matching JMDict entry by kanji surface form first, then by kana
      let entryIds = [];
      
      for (const expr of word.expressions) {
        // Try kanji match
        const kanjiResults = await supabaseGet(
          `/rest/v1/jmdict_kanji?text=eq.${encodeURIComponent(expr)}&select=entry_id&limit=5`
        );
        if (kanjiResults.length > 0) {
          entryIds.push(...kanjiResults.map(r => r.entry_id));
        }
      }

      // If no kanji match, try kana
      if (entryIds.length === 0) {
        for (const reading of word.readings) {
          const kanaResults = await supabaseGet(
            `/rest/v1/jmdict_kana?text=eq.${encodeURIComponent(reading)}&select=entry_id&limit=5`
          );
          if (kanaResults.length > 0) {
            entryIds.push(...kanaResults.map(r => r.entry_id));
          }
        }
      }

      // Deduplicate
      entryIds = [...new Set(entryIds)];

      if (entryIds.length > 0) {
        matched++;
        batch.push(...entryIds);
      }

      // Flush in batches of 200 entry IDs
      if (batch.length >= 200) {
        const ids = [...new Set(batch)];
        await supabaseRpc('PATCH',
          `/rest/v1/jmdict_entries?id=in.(${ids.join(',')})`,
          { jlpt_level: level }
        );
        batch = [];
      }
    }

    // Flush remaining
    if (batch.length > 0) {
      const ids = [...new Set(batch)];
      await supabaseRpc('PATCH',
        `/rest/v1/jmdict_entries?id=in.(${ids.join(',')})`,
        { jlpt_level: level }
      );
    }

    totalMatched += matched;
    console.log(`   ✅ Matched ${matched}/${words.length} words → tagged as N${level}`);
  }

  console.log('\n──────────────────────────────────');
  console.log(`🎉 Done! Tagged ${totalMatched}/${totalWords} total JLPT words.`);

  // Summary query
  for (let l = 5; l >= 1; l--) {
    const count = await supabaseGet(
      `/rest/v1/jmdict_entries?jlpt_level=eq.${l}&select=id&limit=1&offset=0`
    );
    // We can't get count from this easily, but we'll just report success
  }
  console.log('   Run this query in Supabase to verify:');
  console.log('   SELECT jlpt_level, COUNT(*) FROM jmdict_entries WHERE jlpt_level IS NOT NULL GROUP BY jlpt_level ORDER BY jlpt_level;');
}

main().catch(err => {
  console.error('❌ Enrichment failed:', err.message);
  process.exit(1);
});
