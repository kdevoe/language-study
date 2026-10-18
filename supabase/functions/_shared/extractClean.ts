// Jina Reader returns the whole page as markdown. On 2026-10-18 the Guardian's
// came back led by "Skip to main content", an image dialog and a "Support the
// Guardian" banner whose links each carried several hundred characters of
// tracking URL, so the 4,500-char lead budget filled with page chrome and the
// rewrite saw only the headline (3 short paragraphs instead of 5). These keep
// the prose and drop the rest.

/** Headers asking Jina for less chrome to begin with. */
export const JINA_CLEAN_HEADERS: Record<string, string> = {
  'X-Retain-Images': 'none',
  'X-Remove-Selector': 'header, nav, footer, aside, [role="dialog"], [role="navigation"], [role="banner"], [role="contentinfo"]',
};

// Lines that are site furniture, not story, whatever their length.
const BOILERPLATE = new RegExp([
  '^skip to', '^close dialogue', 'toggle caption', '^support (the guardian|us)', '^fund independent journalism',
  '^sign (in|up)', '^subscribe', '^newsletter', '^advertisement', '^share (this|on)', '^cookies?\\b',
  '^accept( all)?( cookies)?$', '^(next|previous) image', '^most viewed', '^related:', '^read more',
  '^photograph:', '^image:', '^explore more on these topics',
].join('|'), 'i');

/**
 * The story's prose from a Jina markdown page: images, links (kept as their
 * text) and bare URLs removed, menu and banner lines dropped, paragraphs kept.
 * A paragraph line is one that reads as a sentence (long enough, or ending in
 * sentence punctuation); short link lists and headings are chrome.
 */
export function cleanExtract(markdown: string): string {
  const text = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')            // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')          // links → their text
    .replace(/<https?:\/\/[^>\s]+>/g, '')
    .replace(/https?:\/\/\S+/g, '');                   // bare URLs
  const keep: string[] = [];
  for (const raw of text.split(/\n/)) {
    const line = raw.replace(/^[#>*\-\s]+/, '').replace(/\s+/g, ' ').trim();
    if (!line || BOILERPLATE.test(line)) continue;
    const sentence = line.length >= 80 || (line.length >= 40 && /[.!?。！？"”’]$/.test(line));
    if (sentence) keep.push(line);
  }
  return keep.join('\n\n');
}
