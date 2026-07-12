/**
 * Read-only audit for the forward-reseed plan (study-pacing flood fix).
 *
 * Pulls the user's user_word_progress rows, classifies each active word as
 * "stays active" (genuine exposure) vs "→ queue" (no real history), estimates
 * the forward-anchored FSRS interval each active word would get, and predicts
 * steady-state reviews/day + initial-ramp load. Breaks down by JLPT level so we
 * can see the "easy N5 words I already know" cohort.
 *
 * READ ONLY — no writes. Usage: node scripts/audit-reseed.cjs [email]
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// ─── Load .env (mirror scripts/enrich_jlpt.cjs) ──────────────
const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const i = t.indexOf('=');
    if (i === -1) return;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    // Values may be nested-quoted, e.g. "'https://...'": strip repeatedly.
    while (v.length >= 2 && ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')))) {
      v = v.slice(1, -1);
    }
    process.env[k] = v;
  });
}

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}
const EMAIL = process.argv[2] || 'kpdevoe@gmail.com';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

// ─── Seed math (mirror src/services/srs.ts) ──────────────────
const SEED_S_MIN = 0.5, SEED_S_MAX = 21, SEED_K = 1.5;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
function seedStability(difficulty) {
  const d = clamp(difficulty, 1, 10);
  return SEED_S_MAX * Math.pow((10 - d) / 9, SEED_K) + SEED_S_MIN;
}
// FSRS-6 first interval at request_retention 0.85 ≈ 1.906 * S (per database/23 comment).
const intervalFromStability = (S) => 1.906 * S;

// Forward-reseed stability estimate: base(difficulty) boosted by spaced exposure.
// distinctDays isn't stored server-side; times_seen is the proxy. We report a RANGE:
//   optimistic  = exposures grew memory a lot  (longer intervals → LOWER load)
//   conservative= exposures grew memory little (shorter intervals → HIGHER load)
function estStability(difficulty, timesSeen, boostK) {
  const base = seedStability(difficulty ?? 6);
  const exposures = Math.max(0, (timesSeen ?? 0) - 1);
  return base * (1 + boostK * exposures);
}

async function resolveUserId(email) {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = (data.users || []).find((u) => (u.email || '').toLowerCase() === email.toLowerCase());
    if (hit) return hit.id;
    if (!data.users || data.users.length < 200) break;
  }
  return null;
}

async function fetchAllProgress(userId) {
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('user_word_progress')
      .select('word_id, difficulty, times_seen, streak, stability, due_at, reps, intake_status, promoted_at')
      .eq('user_id', userId)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

async function fetchJlpt(wordIds) {
  const map = new Map();
  const CHUNK = 400;
  for (let i = 0; i < wordIds.length; i += CHUNK) {
    const chunk = wordIds.slice(i, i + CHUNK);
    const { data, error } = await sb.from('jmdict_entries').select('id, jlpt_level').in('id', chunk);
    if (error) throw error;
    (data || []).forEach((r) => map.set(String(r.id), r.jlpt_level ?? null));
  }
  return map;
}

function bucket(map, key) { map.set(key, (map.get(key) || 0) + 1); }
function fmt(map, order) {
  return (order || [...map.keys()]).map((k) => `${k}: ${map.get(k) || 0}`).join('  ');
}

(async () => {
  console.log(`\n🔍 Auditing forward-reseed for ${EMAIL}\n${'─'.repeat(60)}`);
  const userId = await resolveUserId(EMAIL);
  if (!userId) { console.error(`❌ No auth user for ${EMAIL}`); process.exit(1); }

  const rows = await fetchAllProgress(userId);
  const now = Date.now();
  console.log(`Total user_word_progress rows: ${rows.length}`);

  // Active = the pool the deck draws from (intake_status='active' OR has a schedule).
  const active = rows.filter((r) => r.intake_status === 'active' || r.stability != null);
  const dueNow = active.filter((r) => r.due_at && new Date(r.due_at).getTime() <= now);
  const grandfathered = active.filter((r) => !r.promoted_at); // seed-on-sight, never promoted
  console.log(`Active words: ${active.length}   (due right now: ${dueNow.length},  grandfathered/never-promoted: ${grandfathered.length})`);

  // Classification under the plan: timesSeen<=1 → back to queue; else stays active.
  const staysActive = active.filter((r) => (r.times_seen ?? 0) >= 2);
  const toQueue = active.filter((r) => (r.times_seen ?? 0) < 2);
  console.log(`\nUnder the plan:`);
  console.log(`  → stay active (times_seen ≥ 2): ${staysActive.length}`);
  console.log(`  → back to queue (times_seen ≤ 1): ${toQueue.length}  (drain at 3/day = ${Math.ceil(toQueue.length / 3)} days)`);

  // Exposure & difficulty distributions (active pool).
  const seenDist = new Map(), diffDist = new Map();
  for (const r of active) {
    const ts = r.times_seen ?? 0;
    const b = ts <= 1 ? '0-1' : ts <= 4 ? '2-4' : ts <= 9 ? '5-9' : ts <= 24 ? '10-24' : '25+';
    bucket(seenDist, b);
    bucket(diffDist, String(r.difficulty ?? 'null'));
  }
  console.log(`\ntimes_seen distribution (active):  ${fmt(seenDist, ['0-1', '2-4', '5-9', '10-24', '25+'])}`);
  console.log(`difficulty distribution (active):  ${fmt(diffDist, ['1','2','3','4','5','6','7','8','9','10','null'])}`);

  // ── Policy sweep ───────────────────────────────────────────
  // Each policy decides which active words STAY active (become forward-scheduled
  // flashcards); the rest go to the queue. For each we compute the steady-state
  // review demand Σ(1/interval). A daily cap C is only SUSTAINABLE if demand ≤ C —
  // otherwise the overdue pile grows without bound. We use the conservative boost
  // (k=0.2 → higher demand) as the planning number, and add a floor on the seeded
  // interval to model "seed-on-sight difficulty is unreliable, don't slam hard
  // words due-now" (raises min interval → fewer daily reviews).
  const K_PLAN = 0.2;         // conservative exposure→stability boost
  const MIN_INTERVAL_D = 3;   // floor: never seed a re-seeded word due in < 3 days

  function demand(pool) {
    let perDay = 0; const iv = [];
    for (const r of pool) {
      const S = estStability(r.difficulty, r.times_seen, K_PLAN);
      const I = Math.max(MIN_INTERVAL_D, intervalFromStability(S));
      iv.push(I); perDay += 1 / I;
    }
    iv.sort((a, b) => a - b);
    return { perDay, median: iv.length ? iv[Math.floor(iv.length / 2)] : 0 };
  }

  const POLICIES = [
    { name: 'A. timesSeen≥2 (original plan)',        keep: (r) => (r.times_seen ?? 0) >= 2 },
    { name: 'B. timesSeen≥2 AND difficulty≤6',       keep: (r) => (r.times_seen ?? 0) >= 2 && (r.difficulty ?? 6) <= 6 },
    { name: 'C. timesSeen≥3 AND difficulty≤5',       keep: (r) => (r.times_seen ?? 0) >= 3 && (r.difficulty ?? 6) <= 5 },
    { name: 'D. timesSeen≥5 AND difficulty≤5',       keep: (r) => (r.times_seen ?? 0) >= 5 && (r.difficulty ?? 6) <= 5 },
    { name: 'E. "known" only: diff≤4 AND seen≥3',    keep: (r) => (r.difficulty ?? 6) <= 4 && (r.times_seen ?? 0) >= 3 },
    { name: 'F. USER MODEL: easy(diff≤3)→SRS, else→queue', keep: (r) => (r.difficulty ?? 6) <= 3 },
  ];

  console.log(`\nPOLICY SWEEP  (planning boost k=${K_PLAN}, min interval ${MIN_INTERVAL_D}d)`);
  console.log(`${'─'.repeat(78)}`);
  console.log('policy'.padEnd(38) + 'active'.padStart(7) + 'queue'.padStart(7) + '  rev/day'.padStart(9) + '  medIv'.padStart(7) + '  cap OK?');
  for (const p of POLICIES) {
    const keep = active.filter(p.keep);
    const q = active.length - keep.length;
    const d = demand(keep);
    // Sustainable cap = smallest of {10,20,30,50} that ≥ demand (else "none <50").
    const ok = [10, 20, 30, 50].find((c) => c >= d.perDay);
    console.log(
      p.name.padEnd(38) +
      String(keep.length).padStart(7) +
      String(q).padStart(7) +
      `~${d.perDay.toFixed(0)}`.padStart(9) +
      `${d.median.toFixed(0)}d`.padStart(7) +
      `  ${ok ? `${ok}/day` : '>50/day'}`
    );
  }

  // JLPT breakdown of the full active pool (the "easy N5 I already know" cohort).
  try {
    const jlpt = await fetchJlpt([...new Set(active.map((r) => String(r.word_id)))]);
    const byLevelKnown = new Map(), byLevelAll = new Map();
    for (const r of active) {
      const lv = jlpt.get(String(r.word_id));
      const key = lv == null ? 'none' : `N${lv}`;
      bucket(byLevelAll, key);
      if ((r.difficulty ?? 6) <= 4) bucket(byLevelKnown, key); // "already easy for me"
    }
    console.log(`\nActive by JLPT (all):        ${fmt(byLevelAll, ['N5', 'N4', 'N3', 'N2', 'N1', 'none'])}`);
    console.log(`Active by JLPT (diff≤4=easy): ${fmt(byLevelKnown, ['N5', 'N4', 'N3', 'N2', 'N1', 'none'])}`);
  } catch (e) {
    console.log(`\n(JLPT breakdown skipped: ${e.message})`);
  }

  console.log(`\n${'─'.repeat(78)}`);
  console.log(`"cap OK?" = smallest daily cap whose ceiling ≥ steady-state demand (sustainable — pile drains).`);
  console.log(`If demand > cap, the overdue pile GROWS every day: the cap must exceed true demand.\n`);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
