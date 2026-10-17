import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, X } from 'lucide-react';
import { useTutor } from './TutorProvider';
import { TutorText } from './TutorText';
import { useAppStore } from '../../services/store';
import { useScrollLock } from '../../hooks/useScrollLock';
import { useWordLookup } from '../../hooks/useWordLookup';
import { WordModal } from '../WordModal';
import { GRAMMAR_POINTS } from '../../services/grammar/catalogue';
import { lookupWord as jmdictLookup } from '../../services/jmdict';
import {
  endTutorThread, fetchTutorHistory, streamTutor,
  type ScreenContext, type TutorAction, type TutorRecap,
} from '../../services/tutor';

// ハルカ's side panel (docs/mockups/tutor.html, design-system §6.17). Slides in
// from the hand side over any screen; the screen stays visible beside it. One
// running conversation per day: opening from a new place adds the new screen as
// context instead of starting over.

interface Line {
  key: string;
  role: 'user' | 'assistant' | 'context';
  text: string;
  pending?: boolean;
}

const COMMIT_PX = 70;

export function TutorPanel() {
  const { open, drag, options, openSeq, closeTutor, snapshot } = useTutor();
  const hand = useAppStore((s) => s.tutorHand);
  const gradeDiscoverWord = useAppStore((s) => s.gradeDiscoverWord);
  const setGrammarMastery = useAppStore((s) => s.setGrammarMastery);

  const [lines, setLines] = useState<Line[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [ctx, setCtx] = useState<ScreenContext | null>(null);
  const [chipOff, setChipOff] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);   // null idle · '' replying · tool label
  const [actions, setActions] = useState<TutorAction[]>([]);
  const [recap, setRecap] = useState<TutorRecap | null>(null);
  const [ending, setEnding] = useState(false);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [opener, setOpener] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lookup = useWordLookup();

  useScrollLock(open);
  useDimmedStatusBar(open);

  // Each open: snapshot the screen (or the asked-about item), load today's thread once.
  useEffect(() => {
    if (!open) return;
    const screen = options.ask ?? snapshot();
    setCtx(screen?.detail ? screen : null);
    setChipOff(false);
    setOpener(options.opener ?? screen?.opener ?? null);
    if (!loaded) {
      fetchTutorHistory().then(({ threadId: id, messages }) => {
        setThreadId(id);
        setLines(messages.filter((m) => m.text || m.role === 'context').map((m) => ({
          key: m.id, role: m.role, text: m.role === 'context' ? (m.context?.chip ?? '') : (m.text ?? ''),
        })).filter((l) => l.text));
        setLoaded(true);
      }).catch(() => setLoaded(true));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, openSeq]);

  // Keep the newest line in view, including when the keyboard shrinks the panel.
  const [typing, setTyping] = useState(false);
  const keyboard = useKeyboardViewport(typing);
  const keyboardHeight = keyboard?.height;
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, busy, actions, open, keyboardHeight]);

  const sendText = useCallback(async (raw: string) => {
    const message = raw.trim();
    if (!message || busy !== null) return;
    setDraft('');
    const sentCtx = ctx && !chipOff ? ctx : undefined;
    const sentOpener = opener && !lines.some((l) => l.role !== 'context') ? opener : undefined;
    const pendingKey = `p-${Date.now()}`;
    setLines((prev) => [
      ...prev,
      ...(sentCtx?.chip && !prev.some((l) => l.role === 'context' && l.text === sentCtx.chip)
        ? [{ key: `c-${Date.now()}`, role: 'context' as const, text: sentCtx.chip }] : []),
      ...(sentOpener ? [{ key: `o-${Date.now()}`, role: 'assistant' as const, text: sentOpener }] : []),
      { key: `u-${Date.now()}`, role: 'user', text: message },
      { key: pendingKey, role: 'assistant', text: '', pending: true },
    ]);
    setOpener(null);
    setBusy('');
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await streamTutor({ message, context: sentCtx, opener: sentOpener }, (e) => {
        if (e.type === 'thread') setThreadId(e.threadId);
        else if (e.type === 'text') {
          setBusy('');
          setLines((prev) => prev.map((l) => (l.key === pendingKey ? { ...l, text: l.text + e.text } : l)));
        } else if (e.type === 'tool') setBusy(TOOL_LABEL[e.name] ?? '考えています…');
        else if (e.type === 'action') setActions((prev) => [...prev, e.action]);
        else if (e.type === 'error') {
          setLines((prev) => prev.map((l) => (l.key === pendingKey ? { ...l, text: l.text || e.error } : l)));
        }
      }, ac.signal);
    } catch (err) {
      if (!ac.signal.aborted) {
        const code = String(err instanceof Error ? err.message : err).match(/\d{3}/)?.[0];
        setLines((prev) => prev.map((l) => (l.key === pendingKey
          ? { ...l, text: l.text || `接続できませんでした。もう一度どうぞ。${code ? `（${code}）` : ''}` } : l)));
      }
    } finally {
      setLines((prev) => prev.map((l) => (l.key === pendingKey ? { ...l, pending: false } : l)).filter((l) => l.text));
      setBusy(null);
      abortRef.current = null;
    }
  }, [busy, ctx, chipOff, opener, lines]);

  const end = async () => {
    if (ending) return;
    setEnding(true);
    abortRef.current?.abort();
    const r = await endTutorThread(threadId).catch(() => null);
    setEnding(false);
    const offered = actions.filter((a): a is Extract<TutorAction, { type: 'add_to_deck' }> => a.type === 'add_to_deck');
    setRecap(r ?? { corrections: [], newWords: offered.map(({ word, reading, meaning }) => ({ word, reading, meaning })), usedWords: [] });
  };

  const finish = () => {
    // The thread is over: next open starts a new one.
    setRecap(null);
    setLines([]);
    setThreadId(null);
    setActions([]);
    setAdded(new Set());
    closeTutor();
  };

  const addWord = async (w: { word: string; reading: string; meaning: string }) => {
    if (added.has(w.word)) return;
    setAdded((prev) => new Set(prev).add(w.word));
    try {
      const hit = (await jmdictLookup(w.word))[0];
      if (!hit) return;
      gradeDiscoverWord({
        entryId: hit.entryId, word: w.word, reading: hit.readings[0] ?? w.reading,
        meaning: hit.senses[0]?.gloss.slice(0, 3).join('; ') || w.meaning,
        jlptLevel: hit.jlptLevel, freqRank: hit.freqRank,
      }, 'medium');
    } catch (e) {
      console.warn('[tutor] add to deck failed:', e);
    }
  };

  // Swipe the open panel back toward its edge to close.
  const swipe = useRef<{ x: number; y: number; locked: boolean | null } | null>(null);
  const [closeDrag, setCloseDrag] = useState(0);
  const onTouchStart = (e: React.TouchEvent) => {
    swipe.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, locked: null };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const s = swipe.current;
    if (!s) return;
    const dx = e.touches[0].clientX - s.x;
    const dy = e.touches[0].clientY - s.y;
    if (s.locked === null && Math.abs(dx) + Math.abs(dy) > 10) s.locked = Math.abs(dx) > Math.abs(dy) * 1.5;
    if (!s.locked) return;
    const toward = hand === 'right' ? dx : -dx;
    setCloseDrag(Math.max(0, toward));
  };
  const onTouchEnd = () => {
    if (closeDrag > COMMIT_PX) closeTutor();
    setCloseDrag(0);
    swipe.current = null;
  };

  const side = hand === 'left' ? 'l' : 'r';
  const sign = side === 'r' ? 1 : -1;
  const width = Math.min(window.innerWidth * 0.88, 420);
  const offset = open ? closeDrag : drag !== null ? Math.max(0, width - drag) : width * 1.05;
  const dragging = drag !== null || closeDrag > 0;
  const backdropOn = open || (drag !== null && drag > 8);

  const showChip = !!ctx?.chip && !chipOff && !recap;
  const firstLine = opener && !lines.some((l) => l.role !== 'context') ? opener : null;
  const learnerSpoke = lines.some((l) => l.role === 'user');

  return (
    <>
      <div className={`tutor-backdrop${backdropOn ? ' on' : ''}`} onClick={closeTutor} />
      <aside
        className={`tutor-panel ${side}${dragging ? ' dragging' : ''}${keyboard ? ' kb' : ''}`}
        style={{
          transform: `translateX(${sign * offset}px)`,
          visibility: open || drag !== null ? 'visible' : 'hidden',
          ...(keyboard && { top: keyboard.top, height: keyboard.height, bottom: 'auto' }),
        }}
        aria-hidden={!open}
        aria-label="ハルカ"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <div className="tutor-vgrab" />
        <div className="tutor-head">
          <div className="tutor-who"><div className="tutor-av">ハ</div><b>ハルカ</b></div>
          {recap ? null : learnerSpoke
            ? <button className="tutor-link" onClick={end} disabled={ending}>{ending ? 'まとめています…' : '終わる'}</button>
            : <button className="tutor-link" onClick={closeTutor} aria-label="閉じる"><X size={20} strokeWidth={1.5} /></button>}
        </div>

        {showChip && (
          <div className="tutor-chip">
            <span>{ctx!.chip}</span>
            <button onClick={() => setChipOff(true)} aria-label="この画面を外す"><X size={14} /></button>
          </div>
        )}

        {recap ? (
          <Recap recap={recap} added={added} onAdd={addWord} onDone={finish} />
        ) : (
          <>
            <div className="tutor-thread" ref={threadRef}>
              {firstLine && <div className="tutor-t"><TutorText text={firstLine} lookup={lookup} /></div>}
              {lines.map((l) => l.role === 'context'
                ? <div key={l.key} className="tutor-ctx">{l.text}</div>
                : l.role === 'user'
                  ? <div key={l.key} className="tutor-u">{l.text}</div>
                  : <AssistantLine key={l.key} text={l.text} pending={l.pending} lookup={lookup} />)}
              {busy && <div className="tutor-busy">{busy}</div>}
              {actions.map((a, i) => (
                <ActionNote key={i} action={a} onRate={(id, r) => { setGrammarMastery(id, r); setActions((prev) => prev.filter((x) => x !== a)); }}
                  onDismiss={() => setActions((prev) => prev.filter((x) => x !== a))} />
              ))}
            </div>
            <div className="tutor-input">
              {/* The wrapper's ::after holds a hidden copy of the draft and sizes the
                  textarea to it; with the keyboard up that also fits its width, so the
                  draft reads as the outgoing bubble forming at the end of the thread. */}
              <div className="tutor-draft" data-value={draft || 'ハルカに話しかける…'}>
                <textarea
                  ref={inputRef}
                  rows={1}
                  value={draft}
                  placeholder="ハルカに話しかける…"
                  enterKeyHint="send"
                  onFocus={() => setTyping(true)}
                  onBlur={() => setTyping(false)}
                  autoComplete="off"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); sendText(draft); }
                  }}
                />
              </div>
              <button onClick={() => sendText(draft)} disabled={!draft.trim() || busy !== null} aria-label="送る">
                <ArrowUp size={21} strokeWidth={1.6} />
              </button>
            </div>
          </>
        )}
        <div className="tutor-foot" />
      </aside>
      <WordModal {...lookup.modalProps} />
    </>
  );
}

const TOOL_LABEL: Record<string, string> = {
  lookup_word: '辞書を見ています…',
  get_text: '本文を読んでいます…',
  search_history: '前のことを思い出しています…',
  request_content: '番組を作っています…',
};

/** ハルカ's turn: Japanese lines with tappable words, asides set apart. */
function AssistantLine({ text, pending, lookup }: { text: string; pending?: boolean; lookup: ReturnType<typeof useWordLookup> }) {
  if (pending && !text) return <div className="tutor-typing" role="status" aria-label="ハルカが考えています"><span /><span /><span /></div>;
  // A blank line in her turn is a paragraph: each gets its own line, set close
  // together (the gap between speakers is wider; see .tutor-thread).
  return <>{splitAsides(text).flatMap((part, i) => part.aside
    ? [<div key={i} className="tutor-a">{part.text}</div>]
    : part.text.split(/\n\s*\n/).filter((t) => t.trim()).map((t, j) =>
      <div key={`${i}-${j}`} className="tutor-t"><TutorText text={t.trim()} streaming={pending} lookup={lookup} /></div>))}</>;
}

/** <aside>…</aside> blocks come apart from the Japanese; an unclosed one (still
 *  streaming) is an aside already. */
function splitAsides(text: string): { aside: boolean; text: string }[] {
  const out: { aside: boolean; text: string }[] = [];
  const re = /<aside>([\s\S]*?)(<\/aside>|$)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ aside: false, text: text.slice(last, m.index) });
    out.push({ aside: true, text: m[1] });
    last = m.index + m[0].length;
    if (m[0].length === 0) break;
  }
  if (last < text.length) out.push({ aside: false, text: text.slice(last) });
  return out.map((p) => ({ ...p, text: p.text.replace(/<\/?a?s?i?d?e?$/, '').trim() })).filter((p) => p.text);
}

function ActionNote({ action, onRate, onDismiss }: {
  action: TutorAction;
  onRate: (id: string, r: 'easy' | 'medium' | 'hard') => void;
  onDismiss: () => void;
}) {
  if (action.type === 'grammar_rating') {
    const p = GRAMMAR_POINTS[action.pointId];
    if (!p) return null;
    return (
      <div className="tutor-a">
        {action.why} Mark <span className="serif" style={{ color: 'var(--text-main)' }}>{p.pattern}</span> as {action.rating.toUpperCase()}?
        <div className="tutor-suggestion">
          <button onClick={() => onRate(action.pointId, action.rating)}>そうする</button>
          <button onClick={onDismiss}>そのまま</button>
        </div>
      </div>
    );
  }
  if (action.type === 'content_queued') {
    return <div className="tutor-ctx">番組「{action.topic}」を作っています · 聞くに届きます</div>;
  }
  return null;
}

function Recap({ recap, added, onAdd, onDone }: {
  recap: TutorRecap;
  added: Set<string>;
  onAdd: (w: { word: string; reading: string; meaning: string }) => void;
  onDone: () => void;
}) {
  const empty = !recap.corrections.length && !recap.newWords.length && !recap.usedWords.length;
  return (
    <div className="tutor-recap">
      <h3>今日の会話</h3>
      {empty && <p className="serif" style={{ color: 'var(--text-muted)' }}>また話そうね。</p>}
      {recap.corrections.length > 0 && <>
        <div className="tutor-rk">直したところ</div>
        {recap.corrections.map((c, i) => (
          <div key={i} className="tutor-fixrow"><s>{c.said}</s> → {c.better}<small>{c.note}</small></div>
        ))}
      </>}
      {recap.newWords.length > 0 && <>
        <div className="tutor-rk">新しい単語</div>
        {recap.newWords.map((w) => (
          <div key={w.word} className={`tutor-wrow${added.has(w.word) ? ' added' : ''}`}>
            <span className="jp">{w.word}<small>{w.reading} · {w.meaning}</small></span>
            <button onClick={() => onAdd(w)}>{added.has(w.word) ? '追加しました' : '＋ デッキ'}</button>
          </div>
        ))}
      </>}
      {recap.usedWords.length > 0 && <>
        <div className="tutor-rk">使えた単語</div>
        <div className="tutor-used">{recap.usedWords.map((w) => <span key={w}>{w}</span>)}</div>
      </>}
      <button className="tutor-done" onClick={onDone}>完了</button>
    </div>
  );
}

/** iOS paints the status-bar strip from theme-color, outside the page, so the
 *  backdrop can't dim it. While the panel is open, set it to the current colour
 *  under the backdrop's 35% #2d2d2d, and put the old colour back on close. */
function useDimmedStatusBar(open: boolean) {
  useEffect(() => {
    if (!open) return;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const was = meta?.content;
    if (!meta || !was || !/^#[0-9a-f]{6}$/i.test(was)) return;
    const dim = (i: number) => Math.round(parseInt(was.slice(i, i + 2), 16) * 0.65 + 45 * 0.35).toString(16).padStart(2, '0');
    meta.content = `#${dim(1)}${dim(3)}${dim(5)}`;
    return () => { meta.content = was; };
  }, [open]);
}

/** The visible area while the on-screen keyboard is up, else null. iOS pans the
 *  page to keep a focused input above the keys; pinning the panel to the visual
 *  viewport keeps its header and the latest reply on screen instead. */
function useKeyboardViewport(typing: boolean) {
  const [box, setBox] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!typing || !vv) { setBox(null); return; }
    // Keyed on focus, not on size: iOS may shrink the layout viewport with the
    // keyboard too, so comparing heights can miss it.
    const check = () => setBox({ top: vv.offsetTop, height: vv.height });
    check();
    vv.addEventListener('resize', check);
    vv.addEventListener('scroll', check);
    return () => { vv.removeEventListener('resize', check); vv.removeEventListener('scroll', check); };
  }, [typing]);
  return box;
}
