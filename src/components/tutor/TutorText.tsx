import { useEffect, useState } from 'react';
import { FuriganaText } from '../FuriganaText';
import { tokenizeToDisplay, type DisplayToken } from '../../services/tokenizer';
import type { useWordLookup } from '../../hooks/useWordLookup';

type Lookup = ReturnType<typeof useWordLookup>;

type Part = { fix: boolean; text: string; was?: string; why?: string };

/** Split on <fix was="…" why="…">…</fix> (ハルカ's recasts). An unclosed tag
 *  while streaming is already a fix; a half-typed tag at the end is hidden. */
function parseFix(text: string): Part[] {
  const clean = text.replace(/<[^>]*$/, '');
  const out: Part[] = [];
  const re = /<fix([^>]*)>([\s\S]*?)(<\/fix>|$)/g;
  let last = 0;
  for (let m = re.exec(clean); m; m = re.exec(clean)) {
    if (m.index > last) out.push({ fix: false, text: clean.slice(last, m.index) });
    const attr = (name: string) => m![1].match(new RegExp(`${name}="([^"]*)"`))?.[1]?.trim() || undefined;
    out.push({ fix: true, text: m[2], was: attr('was'), why: attr('why') });
    last = m.index + m[0].length;
    if (m[0].length === 0) break;
  }
  if (last < clean.length) out.push({ fix: false, text: clean.slice(last) });
  return out.filter((p) => p.text);
}

/** What a tapped recast says: what they wrote and why, under the line. */
function FixNote({ part }: { part: Part }) {
  return (
    <span className="tutor-fixnote">
      {part.was
        ? <>You wrote <span lang="ja">「{part.was}」</span>{part.why ? ` — ${part.why}` : ''}</>
        : part.why ?? 'Your words, said back the natural way.'}
    </span>
  );
}

/** The sentence around a character offset, for the lookup's grammar insight. */
function sentenceAt(text: string, at: number): string {
  const start = Math.max(text.lastIndexOf('。', at - 1), text.lastIndexOf('？', at - 1), text.lastIndexOf('！', at - 1)) + 1;
  const ends = ['。', '？', '！'].map((c) => text.indexOf(c, at)).filter((i) => i >= 0);
  return text.slice(start, ends.length ? Math.min(...ends) + 1 : text.length).trim();
}

let seq = 0;

/**
 * One of ハルカ's Japanese lines: words are tappable (the same word panel as the
 * Reader) and long-press shows furigana. While a reply streams it renders as
 * plain text; it's tokenized once complete.
 */
export function TutorText({ text, streaming, lookup }: { text: string; streaming?: boolean; lookup?: Lookup }) {
  const parts = parseFix(text);
  const [tokens, setTokens] = useState<DisplayToken[][] | null>(null);
  const [id] = useState(() => `tt${++seq}`);
  const [openFix, setOpenFix] = useState<number | null>(null);

  // A recast is one tap target (not word-by-word): it opens its note under the line.
  const fixButton = (p: Part, i: number) => (
    <button key={i} type="button" className={`fix${openFix === i ? ' on' : ''}`} disabled={streaming}
      onClick={() => setOpenFix(openFix === i ? null : i)} aria-expanded={openFix === i}>
      {p.text}
    </button>
  );
  const note = openFix !== null && parts[openFix]?.fix ? <FixNote part={parts[openFix]} /> : null;

  useEffect(() => {
    if (streaming || !lookup) return;
    let live = true;
    Promise.all(parseFix(text).map((p) => tokenizeToDisplay(p.text)))
      .then((t) => { if (live) setTokens(t); })
      .catch(() => { /* plain text is fine */ });
    return () => { live = false; };
  }, [text, streaming, lookup]);

  if (!tokens || !lookup || tokens.length !== parts.length) {
    return <>{parts.map((p, i) => (p.fix ? fixButton(p, i) : <span key={i}>{p.text}</span>))}{note}</>;
  }

  const plain = parts.map((p) => p.text).join('');
  let offset = 0;
  return (
    <>
      {parts.map((p, i) => {
        if (p.fix) { offset += p.text.length; return fixButton(p, i); }
        const inner = tokens[i].map((t, j) => {
          const at = offset;
          offset += t.text.length;
          if (!t.isInteractive) return <span key={j}>{t.text}</span>;
          const tokenId = `${id}-${i}-${j}`;
          const lemma = t.lemma && t.lemma !== '*' ? t.lemma : t.text;
          return (
            <FuriganaText
              key={j}
              word={t.text}
              furigana={t.furigana}
              isSelected={lookup.activeHighlightId === tokenId}
              onClick={(e) => lookup.lookupWord(lemma, sentenceAt(plain, at), e, tokenId)}
            />
          );
        });
        return <span key={i}>{inner}</span>;
      })}
      {note}
    </>
  );
}
