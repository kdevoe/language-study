/**
 * JLPT Level Enrichment v2 — strict single-best-entry matcher.
 *
 * Downloads N1-N5 vocab CSVs from jamsinclair/open-anki-jlpt-decks and tags
 * jmdict_entries.jlpt_level. Rewrite of the original enricher, which produced
 * ~16% mistags (see docs/jlpt_vocab_audit.md). Differences:
 *
 *   1. ONE entry per CSV word — the best-scoring candidate — instead of
 *      tagging every entry that shares a surface form (no homograph fanout).
 *   2. Kanji matches also require the entry's reading to match the CSV
 *      reading, so 顔(かんばせ) is not tagged because of 顔(かお).
 *   3. Levels are processed N5 -> N1 and the FIRST (easiest) tag wins, so a
 *      word in both the N5 and N1 decks stays N5.
 *   4. Leading/trailing ～ is stripped so counter/affix words (～円, お～)
 *      match their JMDict entries.
 *   5. Manual judgments live in scripts/jlpt_overrides.json (deny/pin/extra).
 *
 * Usage:
 *   node scripts/enrich_jlpt.cjs             # dry run: writes proposed tags +
 *                                            # diff vs current DB, changes nothing
 *   node scripts/enrich_jlpt.cjs --apply     # wipe all jlpt_level and re-tag
 *
 * Dry-run artifacts (scripts/out/, gitignored):
 *   jlpt_proposed.json  entry_id -> level
 *   jlpt_diff.csv       one row per entry whose tag would change
 *
 * Prerequisites: 07_jmdict_jlpt.sql applied; SUPABASE_SERVICE_ROLE_KEY in .env.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── Load .env ───────────────────────────────────────────────
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
const OUT_DIR = path.join(__dirname, 'out');

const BASE_URL = 'https://raw.githubusercontent.com/jamsinclair/open-anki-jlpt-decks/main/src';
// N5 first: on cross-level overlap the easiest level wins.
const LEVELS = [
  { file: 'n5.csv', level: 5 },
  { file: 'n4.csv', level: 4 },
  { file: 'n3.csv', level: 3 },
  { file: 'n2.csv', level: 2 },
  { file: 'n1.csv', level: 1 },
];

// Senses whose every misc tag is in this set are archaic/rare noise.
const BAD_MISC = new Set(['arch', 'obs', 'rare', 'obsc', 'dated', 'poet', 'hist']);
const KANJI_RE = /[一-龯㐀-䶿々]/;

// ─── HTTP helpers ────────────────────────────────────────────
function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} ${url}`));
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function sbRequest(method, urlPath, body) {
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

async function sbPageAll(base) {
  const out = [];
  for (let off = 0; ; off += 1000) {
    const rows = await sbRequest('GET', `${base}&limit=1000&offset=${off}`);
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

// ─── CSV ─────────────────────────────────────────────────────
function stripAffix(s) {
  return s
    .replace(/[(（][^)）]*[)）]/g, '')      // deck annotations: けっこん (する) -> けっこん
    .replace(/^[～〜]+/, '').replace(/[～〜]+$/, '')
    .trim();
}

// PostgREST in.() values must be double-quoted so commas/parens/spaces in the
// text can't terminate the list early (unencoded ')' silently truncates it).
function inList(values) {
  return values
    .map(v => encodeURIComponent('"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'))
    .join(',');
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = [];
    let cur = '', inQuotes = false;
    for (const ch of lines[i]) {
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === ',' && !inQuotes) { fields.push(cur); cur = ''; continue; }
      cur += ch;
    }
    fields.push(cur);
    if (fields.length >= 2) {
      // cells may pack variants: "回る、回す", "しかく しかくい", "A; B"
      const expressions = fields[0].split(/[;、・]\s*|\s+/).map(s => stripAffix(s.trim())).filter(Boolean);
      const readings = fields[1].split(/[;、・]\s*|\s+/).map(s => stripAffix(s.trim())).filter(Boolean);
      if (expressions.length || readings.length) rows.push({ expressions, readings, raw: fields[0] });
    }
  }
  return rows;
}

// ─── Main ────────────────────────────────────────────────────
async function main() {
  console.log(`🔷 JLPT Enrichment v2 ${APPLY ? '(APPLY)' : '(dry run)'}`);

  const overrides = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'jlpt_overrides.json'), 'utf8')
  );
  const deny = new Set(Object.keys(overrides.deny || {}));

  // 1. Download decks
  const decks = [];
  for (const { file, level } of LEVELS) {
    const words = parseCSV(await fetchText(`${BASE_URL}/${file}`));
    decks.push({ level, words });
    console.log(`   n${level}.csv: ${words.length} words`);
  }

  // 2. Bulk-fetch candidate forms for every surface text in any deck
  const allTexts = new Set();
  const suruBase = t => (t.length > 3 && t.endsWith('する') ? t.slice(0, -2) : null);
  // な-adjectives / adverbs listed with their particle: 生意気な, ゆっくりと, やたらに
  const particleBase = t => (t.length > 2 && /[なとに]$/.test(t) ? t.slice(0, -1) : null);
  for (const { words } of decks) {
    for (const w of words) {
      for (const t of [...w.expressions, ...w.readings]) {
        allTexts.add(t);
        for (const base of [suruBase(t), particleBase(t)]) if (base) allTexts.add(base);
      }
    }
  }
  const texts = [...allTexts];
  console.log(`   ${texts.length} unique surface texts; fetching candidate forms…`);

  const kanjiByText = new Map(); // text -> [{entry_id, common}]
  const kanaByText = new Map();
  for (let i = 0; i < texts.length; i += 100) {
    const chunk = inList(texts.slice(i, i + 100));
    const [kj, kn] = await Promise.all([
      sbPageAll(`/rest/v1/jmdict_kanji?text=in.(${chunk})&select=entry_id,text,common&order=id`),
      sbPageAll(`/rest/v1/jmdict_kana?text=in.(${chunk})&select=entry_id,text,common&order=id`),
    ]);
    for (const r of kj) {
      if (!kanjiByText.has(r.text)) kanjiByText.set(r.text, []);
      kanjiByText.get(r.text).push(r);
    }
    for (const r of kn) {
      if (!kanaByText.has(r.text)) kanaByText.set(r.text, []);
      kanaByText.get(r.text).push(r);
    }
    if (i % 2000 === 0) process.stdout.write(`\r   forms ${i}/${texts.length}`);
  }
  console.log(`\r   forms ${texts.length}/${texts.length}`);

  // Retry pass: texts with zero rows in both maps are either genuinely absent
  // from JMDict or were lost to a poisoned/oversized chunk — refetch them in
  // small batches so one bad neighbor can't sink real words.
  const missing = texts.filter(t => !kanjiByText.has(t) && !kanaByText.has(t));
  let recovered = 0;
  for (let i = 0; i < missing.length; i += 20) {
    const chunk = inList(missing.slice(i, i + 20));
    const [kj, kn] = await Promise.all([
      sbPageAll(`/rest/v1/jmdict_kanji?text=in.(${chunk})&select=entry_id,text,common&order=id`),
      sbPageAll(`/rest/v1/jmdict_kana?text=in.(${chunk})&select=entry_id,text,common&order=id`),
    ]);
    for (const r of kj) {
      if (!kanjiByText.has(r.text)) { kanjiByText.set(r.text, []); recovered++; }
      kanjiByText.get(r.text).push(r);
    }
    for (const r of kn) {
      if (!kanaByText.has(r.text)) { kanaByText.set(r.text, []); recovered++; }
      kanaByText.get(r.text).push(r);
    }
  }
  console.log(`   retry pass: ${missing.length} miss candidates, recovered ${recovered} texts`);

  // 3. Entry metadata + kana readings + sense misc for every candidate entry
  const candidateIds = new Set();
  for (const rows of kanjiByText.values()) rows.forEach(r => candidateIds.add(r.entry_id));
  for (const rows of kanaByText.values()) rows.forEach(r => candidateIds.add(r.entry_id));
  const ids = [...candidateIds];
  console.log(`   ${ids.length} candidate entries; fetching metadata…`);

  const meta = new Map();      // id -> {common, freq_rank}
  const kanaOf = new Map();    // id -> [{text, common}]
  const kanjiCount = new Map();// id -> number of kanji forms
  const allBadMisc = new Map();// id -> boolean
  const hasUk = new Map();     // id -> any sense tagged uk (usually kana)
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150).join(',');
    const [em, kn, kj, sn] = await Promise.all([
      sbPageAll(`/rest/v1/jmdict_entries?id=in.(${chunk})&select=id,common,freq_rank&order=id`),
      sbPageAll(`/rest/v1/jmdict_kana?entry_id=in.(${chunk})&select=entry_id,text,common&order=id`),
      sbPageAll(`/rest/v1/jmdict_kanji?entry_id=in.(${chunk})&select=entry_id&order=id`),
      sbPageAll(`/rest/v1/jmdict_senses?entry_id=in.(${chunk})&select=entry_id,misc&order=id`),
    ]);
    for (const r of em) meta.set(r.id, { common: r.common, freq_rank: r.freq_rank });
    for (const r of kn) {
      if (!kanaOf.has(r.entry_id)) kanaOf.set(r.entry_id, []);
      kanaOf.get(r.entry_id).push(r);
    }
    for (const r of kj) kanjiCount.set(r.entry_id, (kanjiCount.get(r.entry_id) || 0) + 1);
    const byEntry = new Map();
    for (const r of sn) {
      if (!byEntry.has(r.entry_id)) byEntry.set(r.entry_id, []);
      byEntry.get(r.entry_id).push(r.misc || []);
    }
    for (const [eid, senses] of byEntry) {
      allBadMisc.set(eid, senses.length > 0 && senses.every(m => m.some(t => BAD_MISC.has(t))));
      hasUk.set(eid, senses.some(m => m.includes('uk')));
    }
    if (i % 1500 === 0) process.stdout.write(`\r   meta ${i}/${ids.length}`);
  }
  console.log(`\r   meta ${ids.length}/${ids.length}`);

  // 4. Pick the single best entry per CSV word
  function score(entryId, { viaKanji, formCommon, kanaPrimary }) {
    const m = meta.get(entryId) || {};
    let s = 0;
    if (m.common) s += 100;
    if (m.freq_rank != null) s += 50 - m.freq_rank; // nf01 best
    if (formCommon) s += 20;
    if (viaKanji) s += 30;
    // A deck word written in kana IS a kana word: entries with no kanji forms
    // or usually-kana senses must dominate kanji homophones (はい must pick
    // "yes", not 肺, however frequent lungs are).
    if (kanaPrimary && ((kanjiCount.get(entryId) || 0) === 0 || hasUk.get(entryId))) s += 150;
    if (allBadMisc.get(entryId)) s -= 200;
    return s;
  }

  const proposed = new Map(); // entry_id -> level (first/easiest wins)
  const wordLog = [];         // per-word decisions for the report
  for (const { level, words } of decks) {
    let matched = 0;
    for (const w of words) {
      const pinKey = `${level}|${w.raw}`;
      let pick = overrides.pin?.[pinKey] || null;
      let note = pick ? 'pin' : '';

      if (!pick) {
        const readings = new Set(w.readings);
        const cands = new Map(); // entry_id -> best {viaKanji, formCommon}
        for (const expr of w.expressions) {
          if (KANJI_RE.test(expr)) {
            for (const r of kanjiByText.get(expr) || []) {
              // reading must corroborate the kanji match (when the CSV has one)
              const kana = kanaOf.get(r.entry_id) || [];
              if (readings.size && !kana.some(k => readings.has(k.text))) continue;
              const prev = cands.get(r.entry_id);
              if (!prev || (r.common && !prev.formCommon)) {
                cands.set(r.entry_id, { viaKanji: true, formCommon: !!r.common });
              }
            }
          } else {
            for (const r of kanaByText.get(expr) || []) {
              if (!cands.has(r.entry_id)) {
                cands.set(r.entry_id, { viaKanji: false, formCommon: !!r.common, kanaPrimary: true });
              }
            }
          }
        }
        // Fallbacks: kanji match without reading corroboration, then bare kana reading
        if (cands.size === 0) {
          for (const expr of w.expressions) {
            for (const r of kanjiByText.get(expr) || []) {
              cands.set(r.entry_id, { viaKanji: true, formCommon: !!r.common });
            }
          }
          if (cands.size > 0) note = 'relaxed-reading';
        }
        if (cands.size === 0) {
          for (const rd of w.readings) {
            for (const r of kanaByText.get(rd) || []) {
              cands.set(r.entry_id, { viaKanji: false, formCommon: !!r.common });
            }
          }
          if (cands.size > 0) note = 'kana-fallback';
        }
        // ～する compounds and particle-attached forms with no entry of their
        // own: match the base word (けがする -> けが, 生意気な -> 生意気)
        for (const [baseFn, baseNote] of [[suruBase, 'suru-base'], [particleBase, 'particle-base']]) {
          if (cands.size > 0) break;
          for (const t of [...w.expressions, ...w.readings]) {
            const base = baseFn(t);
            if (!base) continue;
            for (const r of (KANJI_RE.test(base) ? kanjiByText : kanaByText).get(base) || []) {
              cands.set(r.entry_id, { viaKanji: KANJI_RE.test(base), formCommon: !!r.common });
            }
          }
          if (cands.size > 0) note = baseNote;
        }

        let best = null, bestScore = -Infinity;
        for (const [eid, info] of cands) {
          if (deny.has(eid)) continue;
          const s = score(eid, info);
          if (s > bestScore || (s === bestScore && best != null && Number(eid) < Number(best))) {
            best = eid; bestScore = s;
          }
        }
        pick = best;
      }

      if (pick) {
        matched++;
        if (!proposed.has(pick)) proposed.set(pick, level);
        else if (proposed.get(pick) !== level) note = `${note} dup->${proposed.get(pick)}`.trim();
      }
      wordLog.push({ level, word: w.raw, reading: w.readings[0] || '', pick: pick || '', note });
    }
    console.log(`   N${level}: matched ${matched}/${words.length}`);
  }
  for (const [eid, lvl] of Object.entries(overrides.extra || {})) {
    if (!deny.has(eid)) proposed.set(eid, lvl);
  }

  // 5. Diff vs current DB
  const current = new Map(
    (await sbPageAll(`/rest/v1/jmdict_entries?jlpt_level=not.is.null&select=id,jlpt_level&order=id`))
      .map(r => [r.id, r.jlpt_level])
  );
  const removals = [], additions = [], changes = [];
  for (const [id, lvl] of current) {
    if (!proposed.has(id)) removals.push({ id, from: lvl });
    else if (proposed.get(id) !== lvl) changes.push({ id, from: lvl, to: proposed.get(id) });
  }
  for (const [id, lvl] of proposed) {
    if (!current.has(id)) additions.push({ id, to: lvl });
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'jlpt_proposed.json'),
    JSON.stringify(Object.fromEntries(proposed), null, 0));
  const esc = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
  fs.writeFileSync(path.join(OUT_DIR, 'jlpt_diff.csv'), [
    'entry_id,action,from,to',
    ...removals.map(r => `${r.id},remove,${r.from},`),
    ...changes.map(r => `${r.id},change,${r.from},${r.to}`),
    ...additions.map(r => `${r.id},add,,${r.to}`),
  ].join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, 'jlpt_word_log.csv'), [
    'level,word,reading,entry_id,note',
    ...wordLog.map(w => [w.level, esc(w.word), esc(w.reading), w.pick, w.note].join(',')),
  ].join('\n'));

  console.log('\n── Diff vs current DB ──');
  console.log(`   currently tagged: ${current.size}`);
  console.log(`   proposed tagged:  ${proposed.size}`);
  console.log(`   removals: ${removals.length}, level changes: ${changes.length}, additions: ${additions.length}`);
  for (let lv = 5; lv >= 1; lv--) {
    const n = [...proposed.values()].filter(l => l === lv).length;
    console.log(`   N${lv}: ${n} entries`);
  }
  console.log(`   artifacts in scripts/out/`);

  if (!APPLY) {
    console.log('\n🔎 Dry run complete — no database changes. Re-run with --apply to write.');
    return;
  }

  // 6. Apply: wipe, then tag level by level
  console.log('\n✏️  Applying: wiping jlpt_level…');
  await sbRequest('PATCH', `/rest/v1/jmdict_entries?jlpt_level=not.is.null`, { jlpt_level: null });
  for (let lv = 5; lv >= 1; lv--) {
    const levelIds = [...proposed].filter(([, l]) => l === lv).map(([id]) => id);
    for (let i = 0; i < levelIds.length; i += 200) {
      await sbRequest('PATCH',
        `/rest/v1/jmdict_entries?id=in.(${levelIds.slice(i, i + 200).join(',')})`,
        { jlpt_level: lv });
    }
    console.log(`   tagged N${lv}: ${levelIds.length}`);
  }
  console.log('🎉 Done.');
}

main().catch(err => { console.error('❌ Failed:', err.message); process.exit(1); });
