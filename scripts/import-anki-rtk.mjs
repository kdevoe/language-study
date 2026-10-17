/**
 * One-off import of an Anki "Remembering the Kanji" deck into the kanji deck
 * (database/35_kanji_deck.sql). Writes a SQL file to run with the Supabase CLI:
 *
 *   cp "~/Library/Application Support/Anki2/User 1/collection.anki2" /tmp/anki.anki2
 *   node scripts/import-anki-rtk.mjs /tmp/anki.anki2 <user-uuid> /tmp/rtk-import.sql
 *   supabase db query --linked --workdir <main checkout> -f /tmp/rtk-import.sql
 *
 * Read a COPY: Anki locks the live file while it's open.
 *
 * What it imports: every RTK card reviewed since the last whole-deck reset (the
 * newest "manual" revlog entry, type 4), keeping Anki's schedule. The due date
 * carries over and S/D are seeded from interval and ease (seedFromAnki in
 * src/services/kanjiDeck.ts, bundled here so the app and the import agree).
 * The reviews since the reset go to kanji_review_log as source 'anki_import'.
 *
 * Safe to re-run: progress rows are upserted, but an existing row is only
 * replaced when Anki has the newer review (a kanji already graded in Yūgen keeps
 * its Yūgen schedule), and the imported log is replaced as a whole.
 */
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import esbuild from 'esbuild';

const [src, userId, out] = process.argv.slice(2);
if (!src || !/^[0-9a-f-]{36}$/.test(userId ?? '') || !out) {
  console.error('usage: node scripts/import-anki-rtk.mjs <collection.anki2 copy> <user-uuid> <out.sql>');
  process.exit(1);
}

// Bundle the app's seeding logic and the RTK list.
const ENTRY = path.join('scripts', '.tmp-import-entry.ts');
const BUNDLE = path.join('scripts', '.tmp-import-bundle.mjs');
writeFileSync(ENTRY, `export { seedFromAnki } from '../src/services/kanjiDeck';\nexport { rtkKanjiList } from '../src/data/rtkKanji';\n`);
await esbuild.build({ entryPoints: [ENTRY], bundle: true, platform: 'node', format: 'esm', outfile: BUNDLE, logLevel: 'silent' });
const { seedFromAnki, rtkKanjiList } = await import(pathToFileURL(BUNDLE).href);
rmSync(ENTRY); rmSync(BUNDLE);

const db = new DatabaseSync(src, { readOnly: true });
const DAY = 86_400_000;

// The RTK note type: the one with the most notes (name columns use Anki's custom
// collation, which plain SQLite can't read, so don't match on names).
const { mid } = db.prepare('select mid, count(*) n from notes group by mid order by n desc limit 1').get();
const { crt } = db.prepare('select crt from col').get();
const reset = db.prepare('select coalesce(max(id), 0) id from revlog where type = 4').get().id;

const cards = db.prepare(`
  select c.id, c.type, c.queue, c.due, c.ivl, c.factor, c.lapses, n.flds
  from cards c join notes n on n.id = c.nid
  where n.mid = ? and c.type != 0`).all(mid);
const reviewsFor = db.prepare('select id, ease, ivl from revlog where cid = ? and id > ? and type < 4 order by id');

// Anki due: review cards (type 2, or queue 3 day-learning) count days from the
// collection's creation time; intraday learning (queue 1) is an epoch in seconds.
// Anki shows a card from the start of its due day, so snap day-based due dates to
// local midnight (crt's time of day would otherwise make cards appear hours late).
function ankiDueMs(c) {
  if (c.queue === 1) return c.due * 1000;
  const d = new Date((crt + c.due * 86400) * 1000);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const progress = [];
const log = [];
const problems = [];
const renumbered = [];
for (const c of cards) {
  const f = c.flds.split('\x1f');
  const kanji = f[0].trim();
  // Number from Yūgen's RTK list so the deck agrees with the rest of the app; an
  // Anki deck may order a few frames differently (this one swaps #230/#231).
  const listNo = rtkKanjiList.indexOf(kanji) + 1;
  const ankiNo = Number(f[5]);
  if (listNo === 0) { problems.push(`${kanji} (#${ankiNo}) is not in the RTK list — skipped`); continue; }
  if (listNo !== ankiNo) renumbered.push(`${kanji} #${ankiNo} → #${listNo}`);
  const heisigNo = listNo;
  const reviews = reviewsFor.all(c.id, reset);
  if (reviews.length === 0) continue; // not studied since the reset
  const seed = seedFromAnki({
    intervalDays: c.ivl,
    easeFactor: c.factor || 2500,
    dueAt: ankiDueMs(c),
    lastReviewedAt: reviews[reviews.length - 1].id,
    reps: reviews.filter((r) => r.ease > 1).length,
    lapses: c.lapses,
  });
  progress.push({ kanji, heisigNo, introducedAt: reviews[0].id, ...seed });
  for (const r of reviews) {
    log.push({ kanji, rating: r.ease, intervalDays: r.ivl > 0 ? r.ivl : -r.ivl / 86400, reviewedAt: r.id });
  }
}
progress.sort((a, b) => a.heisigNo - b.heisigNo);

// ── SQL ──
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const ts = (ms) => `${q(new Date(ms).toISOString())}::timestamptz`;
const num = (n) => (Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : 'null');
const lines = ['begin;'];
for (let i = 0; i < progress.length; i += 500) {
  const values = progress.slice(i, i + 500).map((p) => `(${q(userId)}, ${q(p.kanji)}, ${p.heisigNo}, ${num(p.stability)}, ${num(p.fsrsDifficulty)}, ${ts(p.dueAt)}, ${ts(p.lastReviewedAt)}, ${num(p.intervalDays)}, ${p.reps}, ${p.lapses}, 'review', ${ts(p.introducedAt)}, 'anki', now())`);
  lines.push(`insert into public.user_kanji_progress
  (user_id, kanji, heisig_no, stability, fsrs_difficulty, due_at, last_reviewed_at, interval_days, reps, lapses, srs_status, introduced_at, source, updated_at)
values
${values.join(',\n')}
on conflict (user_id, kanji) do update set
  heisig_no = excluded.heisig_no, stability = excluded.stability, fsrs_difficulty = excluded.fsrs_difficulty,
  due_at = excluded.due_at, last_reviewed_at = excluded.last_reviewed_at, interval_days = excluded.interval_days,
  reps = excluded.reps, lapses = excluded.lapses, srs_status = excluded.srs_status,
  introduced_at = excluded.introduced_at, source = excluded.source, updated_at = excluded.updated_at
where user_kanji_progress.last_reviewed_at is null or user_kanji_progress.last_reviewed_at <= excluded.last_reviewed_at;`);
}
lines.push(`delete from public.kanji_review_log where user_id = ${q(userId)} and source = 'anki_import';`);
for (let i = 0; i < log.length; i += 1000) {
  const values = log.slice(i, i + 1000).map((r) => `(${q(userId)}, ${q(r.kanji)}, ${r.rating}, 'anki_import', ${num(r.intervalDays)}, ${ts(r.reviewedAt)})`);
  lines.push(`insert into public.kanji_review_log (user_id, kanji, rating, source, interval_days, reviewed_at) values\n${values.join(',\n')};`);
}
lines.push('commit;');
writeFileSync(out, lines.join('\n\n') + '\n');

// ── Checks ──
const now = Date.now();
const heisig = progress.map((p) => p.heisigNo);
const contiguous = heisig.every((n, i) => n === i + 1);
const dueIn = (d) => progress.filter((p) => p.dueAt <= now + d * DAY).length;
console.log(`reset at ${new Date(reset).toISOString().slice(0, 10)}; note type ${mid}`);
console.log(`kanji: ${progress.length} (Heisig ${heisig[0]}–${heisig[heisig.length - 1]}${contiguous ? ', contiguous' : ', NOT contiguous'})`);
console.log(`reviews: ${log.length} (${new Date(log[0]?.reviewedAt).toISOString().slice(0, 10)} → ${new Date(Math.max(...log.map((r) => r.reviewedAt))).toISOString().slice(0, 10)})`);
console.log(`due now: ${dueIn(0)}, within 7 days: ${dueIn(7)}, within 30 days: ${dueIn(30)}`);
console.log(problems.length ? `problems: ${problems.length}\n  ${problems.slice(0, 10).join('\n  ')}` : 'every kanji is in the RTK 6th-edition list');
if (renumbered.length) console.log(`numbered from Yūgen's list: ${renumbered.join(', ')}`);
console.log(`wrote ${out}`);
