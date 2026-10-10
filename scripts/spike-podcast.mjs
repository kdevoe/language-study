/**
 * Podcast TTS spike (docs/podcast-design.md §8 P0) — ElevenLabs v3 vs v4 on our
 * own Japanese content.
 *
 * Source content: the gemini-3.8-flash rewrites in the latest eval report
 * (scripts/eval-reports/*.json) — i.e. exactly what production writes for the
 * eval fixtures. No Supabase access.
 *
 * Pipeline (each step caches to scripts/podcast-spike/, git-ignored):
 *   voices  → list Japanese voices from the ElevenLabs library → voices.html (audition)
 *             and seed cast.json (personas + voice ids; edit it to recast)
 *   script  → Gemini turns each article into a two-host dialogue (one script per
 *             fixture, shared by every TTS model so the comparison is apples-to-apples)
 *   render  → ElevenLabs text-to-dialogue/with-timestamps per (fixture × model)
 *             → audio/*.mp3 + render/*.json (char alignment, latency, credits used)
 *   report  → compare.html: per fixture, v3/v4 players with a synced, clickable transcript
 *
 * Usage:
 *   node scripts/spike-podcast.mjs voices
 *   node scripts/spike-podcast.mjs script [--fixtures EVAL-002,EVAL-004] [--force]
 *   node scripts/spike-podcast.mjs render [--models eleven_v3,eleven_v4] [--force]
 *   node scripts/spike-podcast.mjs report
 *   node scripts/spike-podcast.mjs all            # script + render + report
 *
 * Keys (.env): ELEVENLABS_API_KEY, GEMINI_API_KEY or VITE_GEMINI_API_KEY.
 * Cost: ~1.4k chars per (fixture × model) → default run ≈ 11k chars ≈ $0.90 PAYG.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

try {
  process.loadEnvFile('.env');
} catch {
  // no .env — rely on the shell environment
}

const OUT = 'scripts/podcast-spike';
const XI = 'https://api.elevenlabs.io';
const SCRIPT_MODEL = 'gemini-3.8-flash'; // production pin (models.ts GEMINI_FLASH)
const DEFAULT_MODELS = ['eleven_v3', 'eleven_v4'];
// One per level band; casts alternate so both the standard and dialect pairs get heard.
const DEFAULT_FIXTURES = ['EVAL-002', 'EVAL-004', 'EVAL-010', 'EVAL-006'];
const TARGET_CHARS = 1400; // ≈ 5 min at learner pace
const MAX_REQUEST_CHARS = 1900; // dialogue endpoint guidance: ≤ 2,000 per request
const USD_PER_1K_CHARS = 0.08;

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const force = args.includes('--force');

for (const d of ['', 'scripts', 'render', 'audio']) mkdirSync(path.join(OUT, d), { recursive: true });

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2));

function xiKey() {
  const k = process.env.ELEVENLABS_API_KEY;
  if (!k) {
    console.error('ELEVENLABS_API_KEY is required (add it to .env).');
    process.exit(1);
  }
  return k;
}

async function xi(pathname, { method = 'GET', body, query } = {}) {
  const url = new URL(pathname, XI);
  for (const [k, v] of Object.entries(query ?? {})) if (v != null) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    headers: { 'xi-api-key': xiKey(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${method} ${pathname} → ${res.status}: ${text.slice(0, 500)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return { json: text ? JSON.parse(text) : null, requestId: res.headers.get('request-id') };
}

// ── voices ───────────────────────────────────────────────────────────────────
const DEFAULT_CAST = {
  tokyo: {
    label: '標準語ペア',
    host: { name: 'ハルカ', gender: 'female', dialect: '標準語', persona: '明るく好奇心旺盛な司会。リスナーと同じ目線で素朴な質問をする。', voice_id: null },
    guest: { name: 'ソウタ', gender: 'male', dialect: '標準語', persona: '落ち着いた解説役。難しいことを短い文でやさしく説明する。', voice_id: null },
  },
  kansai: {
    label: '関西弁 × 標準語',
    host: { name: 'ケンジ', gender: 'male', dialect: '関西弁（大阪・やわらかめ）', persona: '気さくでノリのいい司会。ツッコミ役で、リスナーの気持ちを代弁する。', voice_id: null },
    guest: { name: 'ミオ', gender: 'female', dialect: '標準語', persona: '丁寧で知的なゲスト。具体例を使って説明する。', voice_id: null },
  },
};

const isJapaneseVoice = (v) =>
  v.language === 'ja' || (v.verified_languages ?? []).some((l) => l.language === 'ja');
const isKansai = (v) => /kansai|osaka|kyoto|関西|大阪|京都/i.test(`${v.accent} ${v.locale} ${v.description} ${v.name}`);

async function cmdVoices() {
  const voices = [];
  for (let page = 0; page < 5; page++) {
    const { json } = await xi('/v1/shared-voices', {
      query: { language: 'ja', page_size: 100, page, sort: 'usage_character_count_1y' },
    });
    voices.push(...json.voices);
    if (!json.has_more) break;
  }
  const ja = voices.filter(isJapaneseVoice);
  writeJson(path.join(OUT, 'voices.json'), ja);
  console.log(`${ja.length} Japanese library voices (${ja.filter(isKansai).length} tagged Kansai/Osaka/Kyoto).`);

  const castPath = path.join(OUT, 'cast.json');
  if (!existsSync(castPath)) {
    const used = new Set();
    const pick = (gender, kansai) => {
      const pool = ja.filter((v) => v.gender === gender && !used.has(v.voice_id));
      const v = (kansai && pool.find(isKansai)) || pool.find((x) => !isKansai(x)) || pool[0];
      if (!v) return null;
      used.add(v.voice_id);
      return { voice_id: v.voice_id, public_owner_id: v.public_owner_id, voice_name: v.name };
    };
    const cast = structuredClone(DEFAULT_CAST);
    for (const pair of Object.values(cast)) {
      for (const role of ['host', 'guest']) {
        const p = pair[role];
        Object.assign(p, pick(p.gender, p.dialect.includes('関西')) ?? {});
      }
    }
    writeJson(castPath, cast);
    console.log(`Seeded ${castPath} — audition voices.html and edit voice ids to recast.`);
  }
  writeFileSync(path.join(OUT, 'voices.html'), voicesHtml(ja));
  console.log(`Audition page: ${path.join(OUT, 'voices.html')}`);
}

function voicesHtml(voices) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const rows = voices
    .map((v) => {
      const jaPreview = (v.verified_languages ?? []).find((l) => l.language === 'ja')?.preview_url ?? v.preview_url;
      return `<tr class="${isKansai(v) ? 'kansai' : ''}"><td><b>${esc(v.name)}</b><br><code>${esc(v.voice_id)}</code></td>
<td>${esc(v.gender)}</td><td>${esc(v.age)}</td><td>${esc(v.accent)}${v.locale ? ` · ${esc(v.locale)}` : ''}</td>
<td>${esc(v.descriptive)} · ${esc(v.use_case)}<br><small>${esc((v.description ?? '').slice(0, 160))}</small></td>
<td>${Math.round((v.usage_character_count_1y ?? 0) / 1e6)}M</td>
<td>${jaPreview ? `<audio controls preload="none" src="${esc(jaPreview)}"></audio>` : ''}</td></tr>`;
    })
    .join('\n');
  return `<!doctype html><meta charset="utf-8"><title>Japanese voices</title>
<style>body{font:14px/1.5 Inter,system-ui,sans-serif;margin:24px;color:#2b2b2b;background:#faf8f4}
table{border-collapse:collapse;width:100%}td,th{padding:8px;border-bottom:1px solid #e6e1d8;vertical-align:top;text-align:left}
tr.kansai{background:#fff3e0}code{font-size:11px;color:#888}audio{height:32px}</style>
<h1>Japanese library voices (${voices.length})</h1>
<p>Sorted by 1-year usage. Kansai-tagged rows are highlighted. Copy a <code>voice_id</code> into <code>cast.json</code> to recast.</p>
<table><tr><th>Voice</th><th>Gender</th><th>Age</th><th>Accent</th><th>Style</th><th>Usage 1y</th><th>Preview</th></tr>${rows}</table>`;
}

// ── script ───────────────────────────────────────────────────────────────────
function latestFlashOutputs() {
  const reports = readdirSync('scripts/eval-reports').filter((f) => f.endsWith('.json')).sort().reverse();
  for (const f of reports) {
    const r = readJson(path.join('scripts/eval-reports', f));
    const rows = r.rows.filter((x) => x.model === SCRIPT_MODEL && !x.error && x.rawText);
    if (rows.length) return { report: f, rows: new Map(rows.map((x) => [x.fixtureId, x])) };
  }
  throw new Error(`No ${SCRIPT_MODEL} rows in scripts/eval-reports — run the eval harness first.`);
}

function fixtureById(id) {
  const file = readdirSync('scripts/eval-fixtures').filter((f) => f.endsWith('.json')).find((f) => readJson(path.join('scripts/eval-fixtures', f)).id === id);
  if (!file) throw new Error(`Fixture ${id} not found`);
  return readJson(path.join('scripts/eval-fixtures', file));
}

function parseJsonLoose(text) {
  const t = text.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '');
  return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
}

function buildScriptPrompt({ title, paragraphs, readLevel, pair }) {
  const listenLevel = Math.min(5, readLevel + 1); // listening one level easier (N4 → N5)
  const who = (role) => `- ${role}: ${pair[role].name}（${pair[role].gender === 'female' ? '女性' : '男性'}）— ${pair[role].persona} 話し方: ${pair[role].dialect}`;
  return `You are writing the script for a short Japanese-language podcast episode for a learner.
The learner reads at JLPT N${readLevel}; listening is harder than reading, so write the dialogue at N${listenLevel} or easier.

Speakers:
${who('host')}
${who('guest')}

Write a natural two-person conversation (対談) about the article below.
Listening rules:
- Reuse the article's own key words; do not introduce harder vocabulary than the article uses.
- Short sentences (mostly under 40 characters). Plain, spoken register (です/ます for the standard speakers).
- Repeat each key term 2–3 times naturally across the conversation; the host sometimes rephrases ("つまり…ということですね").
- Open with a short greeting and topic intro; close with a one-line recap and sign-off.
- A 関西弁 speaker keeps it mild and consistent (〜やん、〜へん、ほんま、〜やで) so a learner can follow.
- Total length about ${TARGET_CHARS} Japanese characters (±10%), 14–30 turns, speakers alternate.

Output JSON only: {"title": "<short Japanese episode title>", "turns": [{"speaker": "host" | "guest", "text": "<Japanese>"}]}
Plain Japanese text only — no furigana, romaji, stage directions, speaker names inside text, or markdown.

Article title: ${title}
Article:
${paragraphs.join('\n\n')}`;
}

async function cmdScript() {
  const key = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY (or VITE_GEMINI_API_KEY) is required.');
  const castPath = path.join(OUT, 'cast.json');
  const cast = existsSync(castPath) ? readJson(castPath) : DEFAULT_CAST; // voice ids not needed to script
  const castIds = Object.keys(cast);
  const { report, rows } = latestFlashOutputs();
  const fixtures = (flag('fixtures') ?? DEFAULT_FIXTURES.join(',')).split(',');
  const model = new GoogleGenerativeAI(key).getGenerativeModel({
    model: SCRIPT_MODEL,
    generationConfig: { responseMimeType: 'application/json', temperature: 0.8, maxOutputTokens: 16384 },
  });
  console.log(`Source: ${report} (${SCRIPT_MODEL} rewrites)`);

  const forcedCast = flag('cast');
  for (const [i, id] of fixtures.entries()) {
    const out = path.join(OUT, 'scripts', `${id}${forcedCast ? `.${forcedCast}` : ''}.json`);
    if (existsSync(out) && !force) {
      console.log(`${id}: cached`);
      continue;
    }
    const row = rows.get(id);
    if (!row) throw new Error(`${id} has no ${SCRIPT_MODEL} output in ${report}`);
    const fixture = fixtureById(id);
    const blocks = parseJsonLoose(`{"b":${row.rawText.trim().replace(/^```(?:json)?|```$/g, '')}}`).b;
    const paragraphs = blocks.filter((b) => b.type === 'paragraph').map((b) => b.text);
    const castId = forcedCast ?? castIds[i % castIds.length];
    const prompt = buildScriptPrompt({
      title: fixture.source.title,
      paragraphs,
      readLevel: fixture.profile.jlptLevel,
      pair: cast[castId],
    });
    const t0 = Date.now();
    const res = await model.generateContent(prompt);
    const script = parseJsonLoose(res.response.text());
    const chars = script.turns.reduce((n, t) => n + t.text.length, 0);
    writeJson(out, {
      fixtureId: id,
      sourceTitle: fixture.source.title,
      readLevel: fixture.profile.jlptLevel,
      castId,
      article: paragraphs,
      ...script,
      chars,
      latencyMs: Date.now() - t0,
    });
    console.log(`${id}: ${script.turns.length} turns, ${chars} chars, cast=${castId}, ${Date.now() - t0}ms — ${script.title}`);
  }
}

// ── render ───────────────────────────────────────────────────────────────────
async function ensureVoiceUsable(person) {
  // Library voices may need adding to the account before the API accepts them.
  if (!person.public_owner_id) return;
  try {
    await xi(`/v1/voices/${person.voice_id}`);
  } catch {
    await xi(`/v1/voices/add/${person.public_owner_id}/${person.voice_id}`, {
      method: 'POST',
      body: { new_name: `spike-${person.name}-${person.voice_name ?? ''}`.slice(0, 60) },
    });
    console.log(`  added library voice ${person.voice_name} (${person.voice_id}) to the account`);
  }
}

function chunkInputs(inputs) {
  const chunks = [[]];
  let n = 0;
  for (const inp of inputs) {
    if (n + inp.text.length > MAX_REQUEST_CHARS && chunks.at(-1).length) {
      chunks.push([]);
      n = 0;
    }
    chunks.at(-1).push(inp);
    n += inp.text.length;
  }
  return chunks;
}

async function characterCount() {
  try {
    return (await xi('/v1/user/subscription')).json.character_count;
  } catch {
    return null; // key may lack user_read permission
  }
}

async function cmdRender() {
  const cast = readJson(path.join(OUT, 'cast.json'));
  const models = (flag('models') ?? DEFAULT_MODELS.join(',')).split(',');
  const scripts = readdirSync(path.join(OUT, 'scripts')).filter((f) => f.endsWith('.json'));
  const ready = new Set();

  for (const f of scripts) {
    const script = readJson(path.join(OUT, 'scripts', f));
    const key = path.basename(f, '.json');
    const pair = cast[script.castId];
    for (const role of ['host', 'guest']) {
      if (!pair[role].voice_id) throw new Error(`cast.json ${script.castId}.${role} has no voice_id`);
      if (!ready.has(pair[role].voice_id)) {
        await ensureVoiceUsable(pair[role]);
        ready.add(pair[role].voice_id);
      }
    }
    const inputs = script.turns.map((t) => ({ text: t.text, voice_id: pair[t.speaker].voice_id, speaker: t.speaker }));

    for (const model of models) {
      const base = `${key}.${model}`;
      const outJson = path.join(OUT, 'render', `${base}.json`);
      if (existsSync(outJson) && !force) {
        console.log(`${base}: cached`);
        continue;
      }
      const before = await characterCount();
      const audio = [];
      const segments = [];
      const requestIds = [];
      let offset = 0;
      let latencyMs = 0;
      let turnBase = 0;
      try {
        for (const chunk of chunkInputs(inputs)) {
          const t0 = Date.now();
          const { json, requestId } = await xi('/v1/text-to-dialogue/with-timestamps', {
            method: 'POST',
            query: { output_format: 'mp3_44100_128' },
            body: {
              model_id: model,
              language_code: 'ja',
              inputs: chunk.map(({ text, voice_id }) => ({ text, voice_id })),
              ...(requestIds.length ? { previous_request_ids: requestIds.slice(-3) } : {}),
            },
          });
          latencyMs += Date.now() - t0;
          if (requestId) requestIds.push(requestId);
          audio.push(Buffer.from(json.audio_base64, 'base64'));
          const al = json.alignment;
          for (const vs of json.voice_segments) {
            const chars = [];
            for (let k = vs.character_start_index; k < vs.character_end_index; k++) {
              chars.push({ c: al.characters[k], s: +(al.character_start_times_seconds[k] + offset).toFixed(3), e: +(al.character_end_times_seconds[k] + offset).toFixed(3) });
            }
            const turn = turnBase + vs.dialogue_input_index;
            segments.push({ turn, speaker: inputs[turn].speaker, start: vs.start_time_seconds + offset, end: vs.end_time_seconds + offset, chars });
          }
          const chunkEnd = Math.max(...json.voice_segments.map((v) => v.end_time_seconds), ...al.character_end_times_seconds);
          offset += chunkEnd;
          turnBase += chunk.length;
        }
      } catch (e) {
        console.error(`${base}: FAILED — ${e.message}`);
        writeJson(outJson, { fixtureId: script.fixtureId, model, error: e.message });
        continue;
      }
      writeFileSync(path.join(OUT, 'audio', `${base}.mp3`), Buffer.concat(audio));
      const after = await characterCount();
      const chars = inputs.reduce((n, i) => n + i.text.length, 0);
      const result = {
        fixtureId: script.fixtureId,
        model,
        castId: script.castId,
        chars,
        requests: requestIds.length || audio.length,
        latencyMs,
        durationSec: +offset.toFixed(2),
        charsPerMin: Math.round(chars / (offset / 60)),
        creditsUsed: before != null && after != null ? after - before : null,
        estUsd: +((chars / 1000) * USD_PER_1K_CHARS).toFixed(3),
        segments,
      };
      writeJson(outJson, result);
      console.log(`${base}: ${result.durationSec}s audio, ${chars} chars, ${latencyMs}ms, credits=${result.creditsUsed ?? '?'}`);
    }
  }
}

// ── report ───────────────────────────────────────────────────────────────────
function cmdReport() {
  const cast = readJson(path.join(OUT, 'cast.json'));
  const episodes = readdirSync(path.join(OUT, 'scripts'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const script = readJson(path.join(OUT, 'scripts', f));
      const key = path.basename(f, '.json');
      const renders = readdirSync(path.join(OUT, 'render'))
        .filter((r) => r.startsWith(`${key}.eleven_`))
        .map((r) => readJson(path.join(OUT, 'render', r)));
      const pair = cast[script.castId];
      return {
        id: key,
        title: script.title,
        sourceTitle: script.sourceTitle,
        readLevel: script.readLevel,
        cast: { label: pair.label, host: `${pair.host.name}（${pair.host.dialect}・${pair.host.voice_name ?? ''}）`, guest: `${pair.guest.name}（${pair.guest.dialect}・${pair.guest.voice_name ?? ''}）` },
        names: { host: pair.host.name, guest: pair.guest.name },
        renders,
      };
    });
  writeFileSync(path.join(OUT, 'compare.html'), compareHtml(episodes));
  console.log(`Report: ${path.resolve(OUT, 'compare.html')}`);
}

function compareHtml(episodes) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Podcast spike — v3 vs v4</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@400;600&family=Inter:wght@400;500;600&display=swap">
<style>
:root{--bg:#faf8f4;--card:#fff;--text:#2b2b2b;--muted:#8a857c;--accent:#b5523b;--line:#e6e1d8}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 Inter,system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 120px}
h1{font-weight:600;font-size:20px}h2{font:600 22px/1.4 'Shippori Mincho',serif;margin:48px 0 4px}
.meta{color:var(--muted);font-size:12px}
.tabs{display:flex;gap:8px;margin:16px 0 8px;flex-wrap:wrap}
.tabs button{font:500 12px Inter;border:1px solid var(--line);background:none;padding:6px 12px;border-radius:999px;cursor:pointer;color:var(--muted)}
.tabs button.on{border-color:var(--accent);color:var(--accent)}
.stats{font-size:12px;color:var(--muted);margin-bottom:8px}
audio{width:100%;margin:8px 0}
.ctl{display:flex;gap:12px;align-items:center;font-size:12px;color:var(--muted)}
.transcript{font:18px/2.1 'Shippori Mincho',serif;max-height:60vh;overflow:auto;padding:8px 4px;scroll-behavior:smooth}
.turn{margin:0 0 14px}.who{font:600 10px Inter;letter-spacing:.08em;color:var(--muted);display:block;line-height:1.4}
.turn.guest{padding-left:1.2em}
.sent{border-radius:4px;transition:background .2s;cursor:pointer}
.sent.cur{background:rgba(181,82,59,.10)}
.ch.on{color:var(--accent)}
.tag{display:none}
.err{color:var(--accent)}
</style>
<main><h1>Podcast spike — ElevenLabs v3 vs v4</h1>
<p class="meta">Same script per episode across models. Click any sentence to seek. Listen for: naturalness, kanji misreadings, dialect, pacing, speaker distinction.</p>
<div id="eps"></div></main>
<script>
const EPISODES = ${JSON.stringify(episodes)};
const root = document.getElementById('eps');
for (const ep of EPISODES) {
  const sec = document.createElement('section');
  sec.innerHTML = '<h2>' + ep.title + '</h2><div class="meta">' + ep.id + ' · read N' + ep.readLevel + ' → listen N' + Math.min(5, ep.readLevel + 1) +
    ' · ' + ep.cast.label + ' · host ' + ep.cast.host + ' / guest ' + ep.cast.guest + '<br>source: ' + ep.sourceTitle + '</div>';
  const tabs = document.createElement('div'); tabs.className = 'tabs'; sec.appendChild(tabs);
  const panes = [];
  ep.renders.sort((a, b) => a.model.localeCompare(b.model)).forEach((r, i) => {
    const b = document.createElement('button'); b.textContent = r.model; tabs.appendChild(b);
    const pane = document.createElement('div'); pane.hidden = i > 0; sec.appendChild(pane);
    panes.push([b, pane]);
    b.onclick = () => { panes.forEach(([bb, pp]) => { bb.classList.toggle('on', bb === b); pp.hidden = pp !== pane; pp.querySelector('audio')?.pause(); }); };
    if (i === 0) b.classList.add('on');
    if (r.error) { pane.innerHTML = '<p class="err">' + r.error + '</p>'; return; }
    pane.innerHTML = '<div class="stats">' + r.durationSec + 's audio · ' + r.chars + ' chars · ' + r.charsPerMin + ' chars/min · ' + r.requests +
      ' request(s) · gen ' + (r.latencyMs / 1000).toFixed(1) + 's · credits ' + (r.creditsUsed ?? '?') + ' · ≈$' + r.estUsd + '</div>' +
      '<audio controls preload="metadata" src="audio/' + ep.id + '.' + r.model + '.mp3"></audio>' +
      '<div class="ctl">speed <select><option>0.75</option><option>0.9</option><option selected>1</option><option>1.15</option></select>' +
      '<label><input type="checkbox" checked> auto-scroll</label><label><input type="checkbox" class="kar"> karaoke</label></div><div class="transcript"></div>';
    build(pane, r, ep.names);
  });
  root.appendChild(sec);
}

function build(pane, r, names) {
  const audio = pane.querySelector('audio'), tr = pane.querySelector('.transcript');
  const [speed, auto, kar] = pane.querySelectorAll('select, input');
  speed.onchange = () => { audio.playbackRate = +speed.value; };
  const flat = []; // {s, el, sent}
  for (const seg of r.segments) {
    const turn = document.createElement('div'); turn.className = 'turn ' + seg.speaker;
    turn.innerHTML = '<span class="who">' + (names[seg.speaker] || seg.speaker) + '</span>';
    let sent = null, inTag = false;
    for (const ch of seg.chars) {
      if (!sent) { sent = document.createElement('span'); sent.className = 'sent'; sent.dataset.t = ch.s; turn.appendChild(sent); }
      const el = document.createElement('span'); el.className = 'ch'; el.textContent = ch.c;
      if (ch.c === '[') inTag = true;
      if (inTag) el.classList.add('tag');
      if (ch.c === ']') inTag = false;
      sent.appendChild(el); flat.push({ s: ch.s, el, sent });
      if ('。！？!?'.includes(ch.c)) sent = null;
    }
    tr.appendChild(turn);
  }
  tr.onclick = (e) => { const s = e.target.closest('.sent'); if (s) { audio.currentTime = +s.dataset.t; audio.play(); } };
  let userScrollUntil = 0;
  tr.addEventListener('wheel', () => { userScrollUntil = Date.now() + 4000; });
  tr.addEventListener('touchmove', () => { userScrollUntil = Date.now() + 4000; });
  let curSent = null, curCh = null;
  const tick = () => {
    const t = audio.currentTime;
    let lo = 0, hi = flat.length - 1, idx = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (flat[m].s <= t) { idx = m; lo = m + 1; } else hi = m - 1; }
    const f = flat[idx];
    if (f && f.sent !== curSent) {
      curSent?.classList.remove('cur'); curSent = f.sent; curSent.classList.add('cur');
      if (auto.checked && Date.now() > userScrollUntil) tr.scrollTo({ top: curSent.offsetTop - tr.offsetTop - tr.clientHeight * 0.4 });
    }
    if (f && f.el !== curCh) { curCh?.classList.remove('on'); curCh = kar.checked ? f.el : null; curCh?.classList.add('on'); }
    if (!audio.paused) requestAnimationFrame(tick);
  };
  audio.addEventListener('play', () => requestAnimationFrame(tick));
  audio.addEventListener('seeked', tick);
}
</script>`;
}

// ── voice QC ─────────────────────────────────────────────────────────────────
// Cast admission check: noise floor (quietest 10% of 50ms windows), integrated
// loudness (EBU R128) → the gain that levels the voice to TARGET_LUFS, and median
// pitch (autocorrelation over voiced frames).
const QC_SR = 16000;
const TARGET_LUFS = -20;
const MAX_NOISE_FLOOR_DB = -50;

function decodeMono(file) {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(QC_SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  if (out.status !== 0) throw new Error(`ffmpeg decode failed for ${file}: ${out.stderr}`);
  return new Float32Array(out.stdout.buffer, out.stdout.byteOffset, out.stdout.byteLength / 4);
}

function integratedLufs(file) {
  const out = spawnSync('ffmpeg', ['-nostats', '-i', file, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = [...out.stderr.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].at(-1);
  return m ? +m[1] : null;
}

const toDb = (x) => 20 * Math.log10(Math.max(x, 1e-7));
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

function framePitch(x, start, len) {
  const minLag = Math.floor(QC_SR / 400);
  const maxLag = Math.floor(QC_SR / 70);
  let energy = 0;
  for (let i = start; i < start + len; i++) energy += x[i] * x[i];
  let best = 0;
  let bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let c = 0;
    let e2 = 0;
    for (let i = start; i < start + len; i++) {
      c += x[i] * x[i + lag];
      e2 += x[i + lag] * x[i + lag];
    }
    const r = c / Math.sqrt(energy * e2 + 1e-12);
    if (r > best) {
      best = r;
      bestLag = lag;
    }
  }
  return best > 0.6 ? QC_SR / bestLag : null;
}

function voiceQc(file) {
  const x = decodeMono(file);
  const win = Math.floor(0.05 * QC_SR);
  const rms = [];
  for (let i = 0; i + win <= x.length; i += win) {
    let s = 0;
    for (let j = i; j < i + win; j++) s += x[j] * x[j];
    rms.push(Math.sqrt(s / win));
  }
  const sorted = [...rms].sort((a, b) => a - b);
  const floorDb = toDb(pct(sorted, 0.1));
  const speechDb = toDb(pct(sorted, 0.7));
  // Pitch on clearly voiced frames only (≥ 20 dB above the floor).
  const frame = Math.floor(0.04 * QC_SR);
  const hop = Math.floor(0.02 * QC_SR);
  const maxLag = Math.floor(QC_SR / 70);
  const f0s = [];
  for (let i = 0; i + frame + maxLag < x.length; i += hop) {
    const w = rms[Math.floor(i / win)] ?? 0;
    if (toDb(w) < floorDb + 20) continue;
    const f = framePitch(x, i, frame);
    if (f) f0s.push(f);
  }
  f0s.sort((a, b) => a - b);
  const lufs = integratedLufs(file);
  return {
    floorDb: +floorDb.toFixed(1),
    snrDb: +(speechDb - floorDb).toFixed(1),
    lufs,
    gainDb: lufs == null ? null : +(TARGET_LUFS - lufs).toFixed(1),
    f0Hz: f0s.length ? Math.round(pct(f0s, 0.5)) : null,
    pass: floorDb < MAX_NOISE_FLOOR_DB,
  };
}

// ── voice design + auditions ─────────────────────────────────────────────────
// Snippets are ≥ 100 chars (Voice Design minimum) and carry a few reading traps
// (今日・一日・関税). Dialect lives in the TEXT; the voice only supplies accent.
const SNIPPETS = {
  standard: 'みなさん、こんにちは。今日のテーマは、外国から入ってくる商品にかかる新しい関税です。つまり、私たちが買い物で払うお金が増えるかもしれない、ということですね。むずかしく聞こえますが、一日一つずつ、ゆっくり考えてみましょう。',
  kansai: 'みなさん、こんにちは！今日のテーマは、外国から入ってくる商品にかかる新しい関税やで。つまり、買い物で払うお金が増えるかもしれへん、ってことやねん。ほんま困るやんなあ。むずかしそうに聞こえるけど、一日一つずつ、ゆっくり考えていこか。',
  hakata: 'みなさん、こんにちは！今日のテーマは、外国から入ってくる商品にかかる新しい関税ばい。つまり、買い物で払うお金が増えるかもしれん、ってことたい。ほんなこつ困るっちゃんね。むずかしそうに聞こえるばってん、一日一つずつ、ゆっくり考えていこうや。',
};

const CLEAN = 'Native Japanese speaker. Studio-quality podcast recording: close microphone, completely clean, no background noise, no hiss, no reverb.';
const DESIGNS = [
  { id: 'kansai-m', label: 'Kansai host (M, 30s)', gender: 'male', dialect: 'kansai', description: `A warm, friendly Japanese man in his 30s from Osaka who speaks natural Kansai dialect with a relaxed, playful radio-host energy and quick comic timing. Medium-low pitch, bright smile in the voice, clear articulation. ${CLEAN}` },
  { id: 'kansai-f', label: 'Kansai co-host (F, late 20s)', gender: 'female', dialect: 'kansai', description: `A cheerful, witty Japanese woman in her late 20s from Osaka who speaks soft, natural Kansai dialect. Low, warm alto voice — not high-pitched, not cutesy. Relaxed and conversational. ${CLEAN}` },
  { id: 'tokyo-f-host', label: 'Standard host (F, 30s, alto)', gender: 'female', dialect: 'standard', description: `A calm, warm Japanese woman in her 30s with a standard Tokyo accent, like an NHK radio presenter. Low alto voice, relaxed and unhurried, grounded and mature — not high-pitched, not anime-like. Very clear articulation for language learners. ${CLEAN}` },
  { id: 'tokyo-f-older', label: 'Standard narrator (F, 50s, low)', gender: 'female', dialect: 'standard', description: `A gentle, composed Japanese woman in her 50s with a standard accent, like a documentary narrator. Low, smooth, rich voice with a calm, reassuring pace. ${CLEAN}` },
  { id: 'tokyo-m-guest', label: 'Standard explainer (M, 40s)', gender: 'male', dialect: 'standard', description: `A calm, knowledgeable Japanese man in his 40s with a standard accent who explains things simply. Warm baritone, measured pace, friendly and patient, like a good teacher on a radio show. ${CLEAN}` },
  { id: 'tokyo-m-young', label: 'Standard co-host (M, 20s)', gender: 'male', dialect: 'standard', description: `A friendly, upbeat Japanese man in his early 20s with a standard accent. Casual and curious, mid pitch, energetic but clear and easy to follow. ${CLEAN}` },
  { id: 'hakata-m', label: 'Hakata host (M, 30s)', gender: 'male', dialect: 'hakata', description: `A good-natured Japanese man in his 30s from Fukuoka who speaks light Hakata dialect. Warm, slightly husky medium-low voice, easygoing and humorous. ${CLEAN}` },
];

// Pre-built library voices for comparison (ids from voices.json), plus the
// current cast so everything is heard on the same snippet + model.
const LIBRARY_COMPARE = [
  { id: '3JDquces8E8bkmvbh6Bc', label: 'Otani (cast: ソウタ)', dialect: 'standard' },
  { id: '4lOQ7A2l7HPuG7UIHiKA', label: 'Kyoko (cast: ハルカ)', dialect: 'standard' },
  { id: 'AP6mVmGgRkbG5mCR7fCS', label: 'Hiyori (cast: ミオ)', dialect: 'kansai' },
  { id: 'RHOImbWK7yOQTNqQwpKB', label: 'Kaito (cast: ケンジ)', dialect: 'kansai' },
  { id: 'nHEVPT3LS1V37bXZNr82', label: 'Hideki — Kansai, calm', dialect: 'kansai' },
  { id: 'ugYcuAusTuWCSOpJD0Xd', label: 'Seyana Seya — Kansai F', dialect: 'kansai' },
  { id: 'wcs09USXSN5Bl7FXohVZ', label: 'Satomi — Kyushu F, 40s', dialect: 'hakata' },
  { id: 'WQz3clzUdMqvBf0jswZQ', label: 'Shizuka — soft F', dialect: 'standard' },
  { id: 'j210dv0vWm7fCknyQpbA', label: 'Hinata — young M', dialect: 'standard' },
  { id: 'sRYzP8TwEiiqAWebdYPJ', label: 'Hatake Kohei — husky M', dialect: 'standard' },
];
const AUDITION_MODEL = 'eleven_v4';

async function cmdDesign() {
  mkdirSync(path.join(OUT, 'designs'), { recursive: true });
  mkdirSync(path.join(OUT, 'auditions'), { recursive: true });
  const only = flag('designs')?.split(',');
  for (const d of DESIGNS.filter((x) => !only || only.includes(x.id))) {
    const out = path.join(OUT, 'designs', `${d.id}.json`);
    if (existsSync(out) && !force) {
      console.log(`${d.id}: cached`);
      continue;
    }
    const { json } = await xi('/v1/text-to-voice/design', {
      method: 'POST',
      body: { voice_description: d.description, model_id: 'eleven_ttv_v3', text: SNIPPETS[d.dialect], guidance_scale: 4 },
    });
    const previews = json.previews.map((p, i) => {
      const file = path.join(OUT, 'auditions', `design-${d.id}-p${i + 1}.mp3`);
      writeFileSync(file, Buffer.from(p.audio_base_64, 'base64'));
      return { generated_voice_id: p.generated_voice_id, file: path.basename(file), qc: voiceQc(file) };
    });
    // Save the cleanest preview as a real voice so it can render dialogue.
    const chosen = [...previews].sort((a, b) => b.qc.pass - a.qc.pass || a.qc.floorDb - b.qc.floorDb)[0];
    const { json: created } = await xi('/v1/text-to-voice', {
      method: 'POST',
      body: {
        voice_name: `yugen-${d.id}`,
        voice_description: d.description.slice(0, 500),
        generated_voice_id: chosen.generated_voice_id,
        labels: { project: 'yugen-podcast', dialect: d.dialect },
        played_not_selected_voice_ids: previews.filter((p) => p !== chosen).map((p) => p.generated_voice_id),
      },
    });
    writeJson(out, { ...d, voice_id: created.voice_id, chosen: chosen.file, previews });
    console.log(`${d.id}: voice ${created.voice_id} from ${chosen.file} — ${previews.map((p) => `${p.file.slice(-6, -4)} floor ${p.qc.floorDb} f0 ${p.qc.f0Hz}`).join(' · ')}`);
  }
}

function libraryVoice(id) {
  const voicesPath = path.join(OUT, 'voices.json');
  return existsSync(voicesPath) ? readJson(voicesPath).find((v) => v.voice_id === id) : undefined;
}

async function renderSnippet(voiceId, text, file) {
  const { json } = await xi('/v1/text-to-dialogue/with-timestamps', {
    method: 'POST',
    query: { output_format: 'mp3_44100_128' },
    body: { model_id: AUDITION_MODEL, language_code: 'ja', inputs: [{ text, voice_id: voiceId }] },
  });
  writeFileSync(file, Buffer.from(json.audio_base64, 'base64'));
}

async function cmdAudition() {
  mkdirSync(path.join(OUT, 'auditions'), { recursive: true });
  const designs = existsSync(path.join(OUT, 'designs'))
    ? readdirSync(path.join(OUT, 'designs')).map((f) => readJson(path.join(OUT, 'designs', f)))
    : [];
  const entries = [
    ...designs.map((d) => ({ key: `designed-${d.id}`, group: 'designed', label: d.label, dialect: d.dialect, voiceId: d.voice_id, design: d })),
    ...LIBRARY_COMPARE.map((l) => ({ key: `library-${l.id}`, group: 'library', label: l.label, dialect: l.dialect, voiceId: l.id })),
  ];
  for (const e of entries) {
    e.file = `${AUDITION_MODEL}-${e.key}.mp3`;
    const file = path.join(OUT, 'auditions', e.file);
    if (!existsSync(file) || force) {
      try {
        await renderSnippet(e.voiceId, SNIPPETS[e.dialect], file);
      } catch (err) {
        // Library voices not yet in the account: add, then retry once.
        const lib = libraryVoice(e.voiceId);
        if (!lib || e.group !== 'library') {
          e.error = err.message;
          console.error(`${e.key}: ${err.message}`);
          continue;
        }
        try {
          await xi(`/v1/voices/add/${lib.public_owner_id}/${e.voiceId}`, { method: 'POST', body: { new_name: `spike-${lib.name}`.slice(0, 60) } });
          await renderSnippet(e.voiceId, SNIPPETS[e.dialect], file);
        } catch (err2) {
          e.error = err2.message;
          console.error(`${e.key}: ${err2.message}`);
          continue;
        }
      }
    }
    e.qc = voiceQc(file);
    console.log(`${e.label.padEnd(32)} floor ${String(e.qc.floorDb).padStart(6)} dB · ${e.qc.lufs} LUFS (gain ${e.qc.gainDb}) · f0 ${e.qc.f0Hz} Hz · ${e.qc.pass ? 'PASS' : 'NOISY'}`);
  }
  writeJson(path.join(OUT, 'auditions.json'), entries);
  writeFileSync(path.join(OUT, 'auditions.html'), auditionsHtml(entries));
  console.log(`Auditions: ${path.resolve(OUT, 'auditions.html')}`);
}

function cmdQc() {
  const dir = path.join(OUT, args[1] ?? 'auditions');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.mp3'))) {
    const q = voiceQc(path.join(dir, f));
    console.log(`${f.padEnd(48)} floor ${String(q.floorDb).padStart(6)} · snr ${q.snrDb} · ${q.lufs} LUFS (gain ${q.gainDb}) · f0 ${q.f0Hz} · ${q.pass ? 'PASS' : 'NOISY'}`);
  }
}

function auditionsHtml(entries) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const qcCells = (q) =>
    q
      ? `<td class="${q.pass ? '' : 'bad'}">${q.floorDb} dB</td><td>${q.lufs ?? '—'} <small>(${q.gainDb > 0 ? '+' : ''}${q.gainDb})</small></td><td>${q.f0Hz ?? '—'} Hz</td>`
      : '<td colspan="3">—</td>';
  // Audio gets the measured gain applied (Web Audio) when "level-matched" is on.
  const row = (e, file, label, q) =>
    `<tr><td>${esc(label)}</td><td>${esc(e.dialect)}</td><td><audio controls preload="none" data-gain="${q?.gainDb ?? 0}" src="auditions/${esc(file)}"></audio></td>${qcCells(q)}</tr>`;
  const section = (title, rows) =>
    `<h2>${title}</h2><table><tr><th>Voice</th><th>Dialect</th><th>Snippet (${AUDITION_MODEL})</th><th>Noise floor</th><th>Loudness LUFS (gain)</th><th>Pitch</th></tr>${rows}</table>`;
  const designed = entries.filter((e) => e.group === 'designed');
  const previews = designed
    .flatMap((e) => e.design.previews.map((p) => row(e, p.file, `${e.label} — preview ${p.file.slice(-6, -4)}${p.file === e.design.chosen ? ' ✓ saved' : ''}`, p.qc)))
    .join('');
  return `<!doctype html><meta charset="utf-8"><title>Voice auditions</title>
<style>body{font:14px/1.5 Inter,system-ui,sans-serif;margin:24px;color:#2b2b2b;background:#faf8f4;max-width:1100px}
table{border-collapse:collapse;width:100%}td,th{padding:6px 8px;border-bottom:1px solid #e6e1d8;text-align:left;vertical-align:middle}
td.bad{color:#b5523b;font-weight:600}audio{height:32px;width:280px}small{color:#8a857c}h2{margin-top:36px}</style>
<h1>Voice auditions</h1>
<p>Same snippet per dialect, all on <b>${AUDITION_MODEL}</b>. Noise floor must be under ${MAX_NOISE_FLOOR_DB} dB (red = noisy). Gain levels each voice to ${TARGET_LUFS} LUFS.
Typical pitch: male about 85–155 Hz, female about 165–255 Hz; lower numbers sound deeper.</p>
<label><input type="checkbox" id="lm" checked> level-matched playback (apply measured gain)</label>
${section('Designed voices (Voice Design, saved to account)', designed.map((e) => row(e, e.file, e.label, e.qc)).join(''))}
${section('Library voices (pre-built)', entries.filter((e) => e.group === 'library').map((e) => (e.error ? `<tr><td>${esc(e.label)}</td><td colspan="5" class="bad">${esc(e.error.slice(0, 160))}</td></tr>` : row(e, e.file, e.label, e.qc))).join(''))}
${section('Design previews (all three per design — tell me if you prefer an unsaved one)', previews)}
<script>
// Web Audio gain is silent on file:// pages (opaque-origin media), so level-match
// with element volume instead: attenuate every voice relative to the quietest one.
const audios = [...document.querySelectorAll('audio')];
const maxGain = Math.max(...audios.map((a) => +a.dataset.gain));
const applyVolume = () => audios.forEach((a) => {
  a.volume = document.getElementById('lm').checked ? Math.pow(10, (+a.dataset.gain - maxGain) / 20) : 1;
});
applyVolume();
document.getElementById('lm').onchange = applyVolume;
for (const a of audios) a.addEventListener('play', () => audios.forEach((o) => o !== a && o.pause()));
</script>`;
}

// ── export-dev ───────────────────────────────────────────────────────────────
// VITE_DEV_MODE has no auth session, so the LISTEN tab can't read real rows.
// Copy one production episode (row + MP3) into public/podcast-dev/ (git-ignored)
// and dev mode serves it (src/services/podcasts.ts devEpisode).
async function cmdExportDev() {
  const id = args[1];
  if (!id) throw new Error('usage: node scripts/spike-podcast.mjs export-dev <episodeId>');
  const clean = (v) => String(v ?? '').trim().replace(/^['"‘’“”]+|['"‘’“”]+$/g, '');
  const url = clean(process.env.VITE_SUPABASE_URL);
  const key = clean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const res = await fetch(`${url}/rest/v1/podcast_episodes?id=eq.${id}&select=*`, { headers });
  const [row] = await res.json();
  if (!row?.audio_path) throw new Error(`episode ${id} not found or has no audio`);
  const audio = await fetch(`${url}/storage/v1/object/podcasts/${row.audio_path}`, { headers });
  if (!audio.ok) throw new Error(`audio download failed: ${audio.status}`);
  const dir = path.join('public', 'podcast-dev');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'episode.mp3'), Buffer.from(await audio.arrayBuffer()));
  writeJson(path.join(dir, 'episode.json'), { ...row, audio_path: '/podcast-dev/episode.mp3', listen_position_ms: 0, listened_at: null });
  console.log(`Exported "${row.title}" → ${dir}/`);
}

// ── main ─────────────────────────────────────────────────────────────────────
const commands = {
  voices: cmdVoices,
  script: cmdScript,
  render: cmdRender,
  report: cmdReport,
  design: cmdDesign,
  audition: cmdAudition,
  qc: cmdQc,
  'export-dev': cmdExportDev,
  all: async () => {
    await cmdScript();
    await cmdRender();
    cmdReport();
  },
};
if (!commands[cmd]) {
  console.error('Usage: node scripts/spike-podcast.mjs <voices|script|render|report|design|audition|qc|all> [--fixtures …] [--designs …] [--models …] [--force]');
  process.exit(1);
}
await commands[cmd]();
