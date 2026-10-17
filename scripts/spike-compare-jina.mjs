/**
 * Spike companion: fetch the same URLs through Jina Reader (today's extractor, see
 * process-article extractFullText) and compare with what web_fetch returned.
 *
 *   node scripts/spike-compare-jina.mjs <spike-results.json> <out.json> [extra-url …]
 *
 * "Body words" = words in lines of 25+ words: a rough proxy for article prose that
 * ignores menus, link lists, captions and footers, so the two extractors are
 * compared on what the rewrite actually needs.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [inFile, out, ...extra] = process.argv.slice(2);
const results = JSON.parse(readFileSync(inFile, 'utf8'));

export const bodyWords = (t) => t.split('\n')
  .map((l) => l.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim())
  .filter((l) => l.split(/\s+/).length >= 25)
  .reduce((n, l) => n + l.split(/\s+/).length, 0);
const words = (t) => t.split(/\s+/).filter(Boolean).length;

const targets = new Map();
for (const r of results) {
  for (const f of r.fetches ?? []) if (f.url) targets.set(f.url, { id: r.id, webFetch: f.text });
  if (r.pick?.url && !targets.has(r.pick.url)) targets.set(r.pick.url, { id: r.id, webFetch: null });
}
for (const u of extra) targets.set(u, { id: 'extra', webFetch: null });

const rows = [];
for (const [url, t] of targets) {
  const t0 = Date.now();
  let jina = null, err = null;
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, { headers: { Accept: 'text/plain' }, signal: AbortSignal.timeout(25000) });
    jina = await res.text();
    if (!res.ok) err = `${res.status}`;
  } catch (e) { err = String(e.name ?? e); }
  const row = {
    id: t.id, url, ms: Date.now() - t0, err,
    webFetchWords: t.webFetch ? words(t.webFetch) : null,
    webFetchBody: t.webFetch ? bodyWords(t.webFetch) : null,
    jinaWords: jina && !err ? words(jina) : null,
    jinaBody: jina && !err ? bodyWords(jina) : null,
    jinaText: jina && !err ? jina : null,
  };
  rows.push(row);
  console.log(`${t.id.padEnd(20)} web_fetch ${String(row.webFetchBody ?? '—').padStart(5)} body / ${String(row.webFetchWords ?? 'not fetched').padStart(5)}   jina ${String(row.jinaBody ?? '—').padStart(5)} body / ${String(row.jinaWords ?? err).padStart(5)}  ${(row.ms / 1000).toFixed(1)}s  ${url}`);
}
writeFileSync(out, JSON.stringify(rows, null, 2));
