// Deterministic checks on what the quarantined research model reports
// (CLAUDE.md › Security › Prompt injection; _shared/lookup.ts and _shared/research.ts).
//
// The research model reads raw web pages, so it can be fooled into passing an
// instruction along in its own words ("the page says the tutor should save a
// note…"). Nothing it writes reaches ハルカ until it passes these checks, which
// are plain code: a bounded shape, short declarative facts, no links or contact
// details, nothing addressed to the agent or the learner, and every fact tied to
// a page the search actually returned. A fact that fails is withheld, not fixed.
//
// No imports: scripts/eval-research-filter.mjs bundles this file for Node.

export interface Finding { fact: string; source: string }
export interface Withheld { fact: string; reason: string }
export interface FilteredReport { answerable: boolean; facts: Finding[]; withheld: Withheld[] }

export const MAX_FINDINGS = 5;
export const MAX_FACT_CHARS = 240;

// Where research may search. Broad, reputable sources a learner of Japanese
// would ask about: news, encyclopedias, travel. Subdomains are covered.
// The open web minus the noisiest sources: social media, forums, Q&A and
// content farms. Questions are general ("where was this weekend's F1 race?"),
// and an allowlist can't cover them: most big news sites block Anthropic's
// crawler, and one blocked allowed domain fails the whole request (Oct 17 2026).
// Safety comes from the quarantine and the checks below, not from the list.
export const RESEARCH_BLOCKED_DOMAINS = [
  'x.com', 'twitter.com', 'facebook.com', 'instagram.com', 'tiktok.com', 'threads.net',
  'reddit.com', 'quora.com', 'pinterest.com', 'medium.com', 'substack.com',
  'chiebukuro.yahoo.co.jp', '5ch.net', '2ch.sc', 'note.com', 'ameblo.jp', 'hatenablog.com',
];

const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|net|org|jp|io|co|info|biz|xyz|app|link)(?:\/\S*)?\b/i;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const DIGIT_RUN_RE = /\+?\d[\d\s().-]{6,}\d/g;

// Each pattern catches text aimed at a model or at the learner rather than a
// fact about the world. False positives only cost one withheld fact.
const SUSPICIOUS: [RegExp, string][] = [
  [/\b(ignore|disregard|forget|override|bypass)\b[^.]{0,40}\b(instructions?|rules?|prompts?|above|previous|prior|guidelines?)\b/i, 'override attempt'],
  [/\b(system prompt|developer (message|mode)|jailbreak|prompt injection|new instructions?)\b/i, 'talks about prompts'],
  [/\b(you are now|act as|pretend (to be|you)|role-?play|from now on)\b/i, 'role change'],
  [/\b(tutor|haruka|assistant|ai|model|chatbot|bot|claude|agent)\s+(should|must|needs? to|has to|is (told|instructed|required) to|will now)\b/i, 'addresses the agent'],
  [/ハルカ|はるか/, 'addresses the agent'],
  [/\b(you|your|you're|yourself)\b/i, 'addresses the reader'],
  [/\b(save_note|set_preference|record_usage|request_content|add_to_deck|suggest_grammar_rating|lookup_word|get_text|search_history|report_findings|tool[_ ]?(call|use)|function call)\b/i, 'names a tool'],
  [/\b(save|remember|record|store)\s+(that|this|the following)\b/i, 'asks to remember'],
  [/\b(click|tap|download|subscribe|sign[ -]?up|log[ -]?in|enter (your|the)|password|credit card|bank (details|account)|wallet address|gift card|verify your)\b/i, 'call to action'],
  [/[<>{}`]|\[\[/, 'markup'],
  [/(指示|命令|ルール).{0,10}(無視|従|忘れ)|ください|なさい|しろ[。！!]?$|してね/, 'Japanese instruction'],
];

/** True when text carries a link, email address or phone-like number. */
export function hasContact(text: string): boolean {
  if (URL_RE.test(text) || EMAIL_RE.test(text)) return true;
  for (const m of text.matchAll(DIGIT_RUN_RE)) if ((m[0].match(/\d/g) ?? []).length >= 10) return true;
  return false;
}

/** Bare lower-case hostname of a URL or domain-ish string, without www. */
export function hostOf(s: string): string {
  const raw = String(s ?? '').trim().toLowerCase();
  if (!raw) return '';
  try {
    const host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname;
    return host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** host is domain, or a subdomain of it. */
export const underDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

// Quoted speech, which a dossier note may carry ("'Ask what you can do,' he said").
const QUOTED_RE = /"[^"\n]*"|“[^”\n]*”|「[^」\n]*」|『[^』\n]*』|'[^'\n]{8,}'/g;

// Long notes and feature prose (dossiers, long-read sources) are about the world
// at length, AI included: "regulators say AI must be labelled", "wetlands act as
// sponges". There the agent and role patterns name only this app's own actors.
const LONG_PATTERNS: [RegExp, string][] = SUSPICIOUS.map(([re, why]) =>
  why === 'addresses the agent' && re.source.startsWith('\\b(tutor')
    ? [/\b(tutor|haruka|assistant|chatbot|claude)\s+(should|must|needs? to|has to|is (told|instructed|required) to|will now)\b/i, why]
    : why === 'role change'
      ? [/\b(you are now|pretend (to be|you)|role-?play as|from now on,? (you|the (assistant|tutor|ai|model)))\b/i, why]
      : [re, why]);

function problem(fact: string, max = MAX_FACT_CHARS, opts: { long?: boolean } = {}): string | null {
  if (fact.length < 8) return 'too short';
  if (fact.length > max) return 'too long';
  if (/[\r\n]/.test(fact)) return 'multi-line';
  if (URL_RE.test(fact)) return 'link';
  if (EMAIL_RE.test(fact)) return 'email';
  if (hasContact(fact)) return 'phone or account number';
  for (const [re, why] of opts.long ? LONG_PATTERNS : SUSPICIOUS) {
    // In a long note, "you" inside a quotation is the speaker's, not the note addressing the reader.
    const text = opts.long && why === 'addresses the reader' ? fact.replace(QUOTED_RE, '""') : fact;
    if (re.test(text)) return why;
  }
  return null;
}

/**
 * Check the research model's report. `seenHosts` are the hosts of every page
 * the search returned in this call; a fact whose source isn't one of them is
 * withheld (the model can't cite a page it never saw). A source under
 * `blockedDomains` is withheld too (the search shouldn't return one).
 */
export function filterReport(report: unknown, seenHosts: string[], blockedDomains: string[] = RESEARCH_BLOCKED_DOMAINS): FilteredReport {
  const r = (report ?? {}) as { answerable?: unknown; findings?: unknown };
  const list = Array.isArray(r.findings) ? r.findings : [];
  const seen = new Set(seenHosts.map(hostOf).filter(Boolean));
  const facts: Finding[] = [];
  const withheld: Withheld[] = [];
  const dupes = new Set<string>();

  for (const item of list) {
    const f = item as { fact?: unknown; source?: unknown };
    const fact = typeof f?.fact === 'string' ? f.fact.trim() : '';
    const host = hostOf(typeof f?.source === 'string' ? f.source : '');
    const reason = !fact ? 'empty'
      : facts.length >= MAX_FINDINGS ? 'over the limit'
      : problem(fact)
        ?? (!host ? 'no source'
          : ![...seen].some((s) => underDomain(host, s) || underDomain(s, host)) ? 'source not in the search results'
          : blockedDomains.some((d) => underDomain(host, d)) ? 'source blocked'
          : dupes.has(fact.toLowerCase()) ? 'duplicate'
          : null);
    if (reason) {
      withheld.push({ fact: fact.slice(0, 300), reason });
      continue;
    }
    dupes.add(fact.toLowerCase());
    facts.push({ fact, source: host });
  }
  return { answerable: r.answerable === true && facts.length > 0, facts, withheld };
}

/** The checked facts as plain lines for ハルカ (fenced by the caller). */
export function renderFacts(r: FilteredReport): string {
  if (!r.facts.length) return 'No usable facts were found.';
  const lines = r.facts.map((f) => `- ${f.fact} (${f.source})`);
  if (r.withheld.length) lines.push(`(${r.withheld.length} other line(s) were withheld by the safety filter.)`);
  return lines.join('\n');
}

// ── Dossiers (research.ts): the deep research behind a long read ─────────────
// Longer notes than a lookup's facts, read only by the long-read writer (which
// has no tools). The same checks apply, in their long form (LONG_PATTERNS), with
// "you" allowed inside quotations.

export const DOSSIER_SECTIONS = ['background', 'timeline', 'people', 'places', 'story', 'detail', 'recent'] as const;
export type DossierSection = typeof DOSSIER_SECTIONS[number];
export interface DossierNote { section: DossierSection; text: string; source: string }
export interface FilteredDossier { notes: DossierNote[]; withheld: Withheld[]; chars: number }

export const MAX_NOTES = 32;
export const MAX_NOTE_CHARS = 900;

/** Check the research model's dossier, note by note (a failing note is withheld, not fixed). */
export function filterDossier(report: unknown, seenHosts: string[], blockedDomains: string[] = RESEARCH_BLOCKED_DOMAINS): FilteredDossier {
  const r = (report ?? {}) as { notes?: unknown };
  const list = Array.isArray(r.notes) ? r.notes : [];
  const seen = new Set(seenHosts.map(hostOf).filter(Boolean));
  const notes: DossierNote[] = [];
  const withheld: Withheld[] = [];
  const dupes = new Set<string>();

  for (const item of list) {
    const n = item as { section?: unknown; text?: unknown; source?: unknown };
    const text = typeof n?.text === 'string' ? n.text.replace(/\s+/g, ' ').trim() : '';
    const host = hostOf(typeof n?.source === 'string' ? n.source : '');
    const section = (DOSSIER_SECTIONS as readonly string[]).includes(String(n?.section)) ? n.section as DossierSection : 'detail';
    const reason = !text ? 'empty'
      : notes.length >= MAX_NOTES ? 'over the limit'
      : (text.length < 20 ? 'too short' : null)
        ?? problem(text, MAX_NOTE_CHARS, { long: true })
        ?? (!host ? 'no source'
          : ![...seen].some((h) => underDomain(host, h) || underDomain(h, host)) ? 'source not in the search results'
          : blockedDomains.some((d) => underDomain(host, d)) ? 'source blocked'
          : dupes.has(text.toLowerCase()) ? 'duplicate'
          : null);
    if (reason) {
      withheld.push({ fact: text.slice(0, 300), reason });
      continue;
    }
    dupes.add(text.toLowerCase());
    notes.push({ section, text, source: host });
  }
  return { notes, withheld, chars: notes.reduce((n, x) => n + x.text.length, 0) };
}

/** The checked dossier as plain sections for the writer (fenced by the caller). */
export function renderDossier(d: FilteredDossier): string {
  return DOSSIER_SECTIONS
    .map((sec) => {
      const lines = d.notes.filter((n) => n.section === sec).map((n) => `- ${n.text} (${n.source})`);
      return lines.length ? `${sec.toUpperCase()}\n${lines.join('\n')}` : '';
    })
    .filter(Boolean).join('\n\n');
}

/**
 * Screen a generated long-read source paragraph by paragraph: links, contact
 * details, and text aimed at a model (the instruction patterns above, minus the
 * reader "you", which a feature may use in a quote). Returns the paragraphs that
 * failed, with why; the caller drops a few or rejects the piece.
 */
export function screenParagraphs(paragraphs: string[]): { index: number; reason: string }[] {
  const out: { index: number; reason: string }[] = [];
  paragraphs.forEach((p, index) => {
    if (URL_RE.test(p)) return out.push({ index, reason: 'link' });
    if (EMAIL_RE.test(p)) return out.push({ index, reason: 'email' });
    if (hasContact(p)) return out.push({ index, reason: 'phone or account number' });
    for (const [re, why] of LONG_PATTERNS) {
      if (why === 'addresses the reader' || why === 'call to action') continue;
      if (re.test(p)) return out.push({ index, reason: why });
    }
  });
  return out;
}
