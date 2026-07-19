/**
 * One-time user_word_progress cleanup after the JLPT retag.
 *
 * Applies scripts/jlpt_progress_fix.json:
 *   - remap: move a row from a wrong-homograph entry id to the entry the user
 *     actually read. If the user already has a row for the target entry, the
 *     source row is deleted instead (their knowledge is already tracked there).
 *   - delete: remove rows for dictionary-noise entries.
 *
 * Runs for ALL users (the bad tags served everyone the same junk).
 * study_history rows are left untouched (append-only event log).
 *
 * The client-side counterpart is TOMBSTONED_WORD_IDS in
 * src/services/vocabCleanup.ts, which stops stale local caches from
 * re-uploading removed rows. Run this AFTER that change is deployed, or
 * re-run it once clients have updated.
 *
 * Usage:
 *   node scripts/fix_progress_rows.cjs           # dry run
 *   node scripts/fix_progress_rows.cjs --apply
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    let v = t.slice(i + 1).trim();
    while ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
    process.env[t.slice(0, i).trim()] = v;
  }
}
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}
const APPLY = process.argv.includes('--apply');

function sb(method, urlPath, body) {
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
        'Accept': 'application/json',
        'Prefer': method === 'GET' ? 'count=none' : 'return=minimal',
      },
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(method === 'GET' ? JSON.parse(data) : data);
        } else reject(new Error(`Supabase ${res.statusCode}: ${data.slice(0, 300)}`));
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  console.log(`🔷 Progress-row cleanup ${APPLY ? '(APPLY)' : '(dry run)'}`);
  const plan = JSON.parse(fs.readFileSync(path.join(__dirname, 'jlpt_progress_fix.json'), 'utf8'));
  const remap = plan.remap || {};
  const deletes = new Set(plan.delete || []);
  const touchedIds = [...Object.keys(remap), ...deletes];

  // Fetch every affected row across all users (well under 1000 rows).
  const rows = await sb('GET',
    `/rest/v1/user_word_progress?word_id=in.(${touchedIds.join(',')})&select=user_id,word_id,mastery_level,times_seen,streak,last_seen_at&limit=1000`);
  console.log(`   affected rows: ${rows.length}`);

  let nDelete = 0, nMove = 0, nMergeDelete = 0;
  for (const row of rows) {
    const uid = row.user_id;
    if (deletes.has(row.word_id)) {
      nDelete++;
      console.log(`   delete  ${row.word_id} (${row.mastery_level}, seen ${row.times_seen}) user ${uid.slice(0, 8)}`);
      if (APPLY) {
        await sb('DELETE', `/rest/v1/user_word_progress?user_id=eq.${uid}&word_id=eq.${row.word_id}`);
      }
      continue;
    }
    const target = remap[row.word_id];
    const existing = await sb('GET',
      `/rest/v1/user_word_progress?user_id=eq.${uid}&word_id=eq.${target}&select=word_id&limit=1`);
    if (existing.length > 0) {
      nMergeDelete++;
      console.log(`   merge   ${row.word_id} -> ${target} exists; dropping source (user ${uid.slice(0, 8)})`);
      if (APPLY) {
        await sb('DELETE', `/rest/v1/user_word_progress?user_id=eq.${uid}&word_id=eq.${row.word_id}`);
      }
    } else {
      nMove++;
      console.log(`   move    ${row.word_id} -> ${target} (${row.mastery_level}, seen ${row.times_seen}) user ${uid.slice(0, 8)}`);
      if (APPLY) {
        // PK is (user_id, word_id): PATCHing word_id moves the row wholesale,
        // preserving mastery/streak/schedule columns untouched.
        await sb('PATCH',
          `/rest/v1/user_word_progress?user_id=eq.${uid}&word_id=eq.${row.word_id}`,
          { word_id: target });
      }
    }
  }
  console.log(`\n   deletes: ${nDelete}, moves: ${nMove}, merge-deletes: ${nMergeDelete}`);
  if (!APPLY) console.log('🔎 Dry run — no changes. Re-run with --apply to write.');
  else console.log('🎉 Done.');
}

main().catch(err => { console.error('❌ Failed:', err.message); process.exit(1); });
