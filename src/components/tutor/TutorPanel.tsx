import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Camera, X } from 'lucide-react';
import { useTutor } from './TutorProvider';
import { TutorText } from './TutorText';
import { useAppStore } from '../../services/store';
import { useScrollLock } from '../../hooks/useScrollLock';
import { useWordLookup } from '../../hooks/useWordLookup';
import { WordModal } from '../WordModal';
import { GRAMMAR_POINTS } from '../../services/grammar/catalogue';
import { lookupWord as jmdictLookup } from '../../services/jmdict';
import {
  endTutorThread, fetchTutorHistory, localDay, pollResearch, streamTutor,
  type ScreenContext, type TutorAction, type TutorRecap,
} from '../../services/tutor';
import { addActivity, useActivityWhile } from '../../services/activity';
import { createEpisode, episodeErrorMessage } from '../../services/podcasts';
import { clearThumbs, keepThumb, preparePhoto, thumbsFor, type PreparedPhoto } from '../../services/tutorPhotos';

// ハルカ's side panel (docs/mockups/tutor.html, design-system §6.17). Slides in
// from the hand side over any screen; the screen stays visible beside it. One
// running conversation per day: opening from a new place adds the new screen as
// context instead of starting over.

interface Line {
  key: string;
  role: 'user' | 'assistant' | 'context';
  text: string;
  pending?: boolean;
  /** A photo you sent: the thumbnail kept on this phone (if any), and what she saved of it. */
  photo?: { id: string; thumb?: string; label?: string; transcript?: string; live?: boolean };
}

const COMMIT_PX = 70;
const RESEARCH_POLL_MS = 3000;
const RESEARCH_GIVE_UP_MS = 120_000;

export function TutorPanel() {
  const { open, drag, options, openSeq, closeTutor, snapshot } = useTutor();
  const hand = useAppStore((s) => s.tutorHand);
  const gradeDiscoverWord = useAppStore((s) => s.gradeDiscoverWord);
  const setGrammarMastery = useAppStore((s) => s.setGrammarMastery);

  const [lines, setLines] = useState<Line[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);       // the first history load has finished, either way
  const [historyOk, setHistoryOk] = useState(false); // ...and succeeded
  const [ctx, setCtx] = useState<ScreenContext | null>(null);
  const [chipOff, setChipOff] = useState(false);
  const [draft, setDraft] = useState('');
  const [photo, setPhoto] = useState<PreparedPhoto | null>(null);   // attached, not sent yet
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);   // null idle · '' replying · tool label
  const [actions, setActions] = useState<TutorAction[]>([]);
  const [recap, setRecap] = useState<TutorRecap | null>(null);
  const [ending, setEnding] = useState(false);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [opener, setOpener] = useState<string | null>(null);
  // Background lookups ハルカ started (research tool): polled until they land,
  // then she shares them, in a followup turn if the chat is quiet.
  const [researching, setResearching] = useState<{ id: string; at: number }[]>([]);
  const [landed, setLanded] = useState<string[]>([]);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lookup = useWordLookup();

  useScrollLock(open);
  useActivityWhile('chat', open);
  useDimmedStatusBar(open);

  // Today's thread from the server. A PWA resumed the next morning used to keep
  // yesterday's lines, because history loaded once per app session (2026-10-18).
  // Now: on a new local day, start clean; after the app was in the background,
  // reload, since the thread may have moved on (a lookup landed, another device).
  const historyDayRef = useRef<string | null>(null);
  const staleRef = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const syncHistory = useCallback(() => {
    const today = localDay();
    if (historyDayRef.current && historyDayRef.current !== today) {
      setLines([]);
      setThreadId(null);
      setActions([]);
      setResearching([]);
      setLanded([]);
      setRecap(null);
      setLoaded(false);
      setHistoryOk(false);
    }
    staleRef.current = false;
    fetchTutorHistory().then(async ({ threadId: id, messages }) => {
      const photoOf = (m: (typeof messages)[number]) => (m.context && 'photo' in m.context ? m.context.photo : undefined);
      const thumbs = await thumbsFor(messages.map((m) => photoOf(m)?.id).filter((x): x is string => !!x));
      if (busyRef.current !== null) return;   // a reply started meanwhile: keep what's on screen
      historyDayRef.current = today;
      setThreadId(id);
      setLines(messages.map((m): Line => {
        const p = photoOf(m);
        return {
          key: m.id, role: m.role,
          text: m.role === 'context' ? (m.context && 'chip' in m.context ? m.context.chip ?? '' : '') : (m.text ?? ''),
          ...(p && { photo: { ...p, thumb: thumbs[p.id] } }),
        };
      }).filter((l) => l.text || l.photo));
      setLoaded(true);
      setHistoryOk(true);
    }).catch(() => setLoaded(true)); // still talkable; the next open tries again
  }, []);

  // Each open: snapshot the screen (or the asked-about item), and load today's
  // thread if it isn't loaded, is from another day, or may be stale.
  useEffect(() => {
    if (!open) return;
    const screen = options.ask ?? snapshot();
    setCtx(screen?.detail ? screen : null);
    setChipOff(false);
    setOpener(options.opener ?? screen?.opener ?? null);
    if (busy === null && (!historyOk || staleRef.current || historyDayRef.current !== localDay())) syncHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, openSeq]);

  // Coming back to the app with the panel open counts the same as opening it.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') { staleRef.current = true; return; }
      if (open && busyRef.current === null) syncHistory();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [open, syncHistory]);

  // Keep the newest line in view, including when the keyboard shrinks the panel.
  const [typing, setTyping] = useState(false);
  const keyboard = useKeyboardViewport(typing);
  const keyboardHeight = keyboard?.height;
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, busy, actions, open, keyboardHeight]);

  // One streamed reply from ハルカ, after `before` lines (the learner's message,
  // a context chip) are shown. Her reply can span tool calls ("調べておくね" →
  // research → the conversation goes on): each stretch of text is its own
  // bubble, like the reloaded history.
  const streamReply = useCallback(async (input: Parameters<typeof streamTutor>[0], before: Line[]) => {
    let pendingKey = `p-${Date.now()}`;
    let bubbleText = '';
    let failed = false;   // the connection failed before she said anything
    setLines((prev) => [...prev, ...before, { key: pendingKey, role: 'assistant', text: '', pending: true }]);
    setBusy('');
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await streamTutor(input, (e) => {
        if (e.type === 'thread') setThreadId(e.threadId);
        else if (e.type === 'photo') {
          setLines((prev) => prev.map((l) => (l.photo?.id === e.id ? { ...l, photo: { ...l.photo, label: e.label, transcript: e.transcript } } : l)));
        }
        else if (e.type === 'text') {
          setBusy('');
          const key = pendingKey;
          const add = bubbleText ? e.text : e.text.trimStart();
          bubbleText += add;
          setLines((prev) => prev.map((l) => (l.key === key ? { ...l, text: l.text + add } : l)));
        } else if (e.type === 'tool') {
          setBusy(TOOL_LABEL[e.name] ?? '考えています…');
          if (bubbleText.trim()) {
            const done = pendingKey;
            const next = `p-${Date.now()}-${e.name}`;
            pendingKey = next;
            bubbleText = '';
            setLines((prev) => [...prev.map((l) => (l.key === done ? { ...l, text: l.text.trimEnd(), pending: false } : l)),
              { key: next, role: 'assistant' as const, text: '', pending: true }]);
          }
        } else if (e.type === 'research') setResearching((prev) => [...prev, { id: e.id, at: Date.now() }]);
        else if (e.type === 'action') setActions((prev) => [...prev, e.action]);
        else if (e.type === 'error') {
          const key = pendingKey;
          setLines((prev) => prev.map((l) => (l.key === key ? { ...l, text: l.text || e.error } : l)));
        }
      }, ac.signal);
    } catch (err) {
      if (!ac.signal.aborted) {
        failed = !bubbleText;
        const code = String(err instanceof Error ? err.message : err).match(/\d{3}/)?.[0];
        const key = pendingKey;
        setLines((prev) => prev.map((l) => (l.key === key
          ? { ...l, text: l.text || `接続できませんでした。もう一度どうぞ。${code ? `（${code}）` : ''}` } : l)));
      }
    } finally {
      setLines((prev) => prev.map((l) => (l.pending ? { ...l, pending: false } : l)).filter((l) => l.text || l.photo));
      setBusy(null);
      abortRef.current = null;
    }
    return !failed;
  }, []);

  const sendText = useCallback(async (raw: string) => {
    const message = raw.trim();
    const sentPhoto = photo;
    if ((!message && !sentPhoto) || busy !== null) return;
    addActivity('turns', 1);
    setDraft('');
    setPhoto(null);
    if (sentPhoto) keepThumb(sentPhoto.upload.id, localDay(), sentPhoto.thumb);
    const sentCtx = ctx && !chipOff ? ctx : undefined;
    const sentOpener = opener && !lines.some((l) => l.role !== 'context') ? opener : undefined;
    const before: Line[] = [
      ...(sentCtx?.chip && !lines.some((l) => l.role === 'context' && l.text === sentCtx.chip)
        ? [{ key: `c-${Date.now()}`, role: 'context' as const, text: sentCtx.chip }] : []),
      ...(sentOpener ? [{ key: `o-${Date.now()}`, role: 'assistant' as const, text: sentOpener }] : []),
      { key: `u-${Date.now()}`, role: 'user', text: message,
        ...(sentPhoto && { photo: { id: sentPhoto.upload.id, thumb: sentPhoto.thumb, live: true } }) },
    ];
    setOpener(null);
    // Anything that landed is in the thread now: she sees it in this turn.
    setLanded([]);
    const ok = await streamReply({ message, context: sentCtx, opener: sentOpener, image: sentPhoto?.upload }, before);
    // Nothing got through: hand the message back so it isn't lost (a photo isn't re-attached).
    if (!ok && message) setDraft((d) => d || message);
  }, [busy, ctx, chipOff, opener, lines, photo, streamReply]);

  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    try {
      setPhoto(await preparePhoto(file));
    } catch (e) {
      console.warn('[tutor] photo failed:', e);
    }
  };

  // Poll the lookups in flight; drop any that never land.
  useEffect(() => {
    if (!researching.length || !threadId || recap) return;
    const t = setTimeout(async () => {
      const ids = researching.map((r) => r.id);
      const done = await pollResearch(threadId, ids).catch(() => [] as string[]);
      const now = Date.now();
      setResearching((prev) => prev.filter((r) => !done.includes(r.id) && now - r.at < RESEARCH_GIVE_UP_MS));
      if (done.length) setLanded((prev) => [...prev, ...done]);
    }, RESEARCH_POLL_MS);
    return () => clearTimeout(t);
  }, [researching, threadId, recap]);

  // A lookup landed while ハルカ isn't replying: she brings it up herself. The
  // server skips it if the learner spoke since (she already saw it then).
  useEffect(() => {
    // Not while they're typing: their next message carries it instead.
    if (!landed.length || busy !== null || !threadId || recap || ending || draft.trim()) return;
    const researchId = landed[landed.length - 1];
    setLanded([]);
    void streamReply({ action: 'followup', threadId, researchId }, []);
  }, [landed, busy, threadId, recap, ending, draft, streamReply]);

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
    setResearching([]);
    setLanded([]);
    setAdded(new Set());
    setPhoto(null);
    clearThumbs();
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
  const width = Math.min(window.innerWidth * 0.94, 420);
  const offset = open ? closeDrag : drag !== null ? Math.max(0, width - drag) : width * 1.05;
  const dragging = drag !== null || closeDrag > 0;
  const backdropOn = open || (drag !== null && drag > 8);

  const showChip = !!ctx?.chip && !chipOff && !recap;
  // Her opener only once we know today's thread is empty: until the history
  // loads, a fresh-looking opener would hide the conversation you're in.
  const firstLine = loaded && opener && !lines.some((l) => l.role !== 'context') ? opener : null;
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
        {/* No header (docs/mockups/tutor-fullheight.html, B): the thread runs to the
            top edge. Swipe back or tap the dim to close; 終わる lives in the input row. */}

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
              {!loaded && !lines.length && <div className="tutor-typing" role="status" aria-label="読み込み中"><span /><span /><span /></div>}
              {firstLine && <div className="tutor-t"><TutorText text={firstLine} lookup={lookup} /></div>}
              {lines.map((l) => l.role === 'context'
                ? <div key={l.key} className="tutor-ctx">{l.text}</div>
                : l.role === 'user'
                  ? <UserLine key={l.key} line={l} />
                  : <AssistantLine key={l.key} text={l.text} pending={l.pending} lookup={lookup} />)}
              {busy && <div className="tutor-busy">{busy}</div>}
              {busy === null && researching.length > 0 && <div className="tutor-busy">ハルカが調べています…</div>}
              {actions.map((a, i) => (
                <ActionNote key={i} action={a} onRate={(id, r) => { setGrammarMastery(id, r); setActions((prev) => prev.filter((x) => x !== a)); }}
                  onDismiss={() => setActions((prev) => prev.filter((x) => x !== a))} />
              ))}
            </div>
            {photo && (
              <div className="tutor-attach">
                <div className="tutor-photo">
                  <img src={photo.thumb} alt="" />
                  <button className="tutor-photo-x" onClick={() => setPhoto(null)} aria-label="写真を外す"><X size={11} strokeWidth={2.4} /></button>
                </div>
              </div>
            )}
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
                  // Her job is to see your mistakes: no autocorrect, no spellcheck, no
                  // iOS writing suggestions (Safari's writingsuggestions attribute).
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  {...({ writingsuggestions: 'false' } as Record<string, string>)}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); sendText(draft); }
                  }}
                />
              </div>
              {/* 終わる: once you've spoken, and not while typing (the draft is the bubble then). */}
              {learnerSpoke && !keyboard && (
                <button className="tutor-end" onClick={end} disabled={ending}>{ending ? 'まとめています…' : '終わる'}</button>
              )}
              {/* No capture attribute: iOS offers Take Photo or Photo Library. */}
              <input ref={fileRef} type="file" accept="image/*" hidden
                onChange={(e) => { pickPhoto(e.target.files?.[0]); e.target.value = ''; }} />
              <button onClick={() => fileRef.current?.click()} aria-label="写真">
                <Camera size={21} strokeWidth={1.6} />
              </button>
              <button onClick={() => sendText(draft)} disabled={(!draft.trim() && !photo) || busy !== null} aria-label="送る">
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
  research: '調べ始めています…',
  request_content: '番組を作っています…',
};

/** Your turn: the photo (if any) above your bubble. Live, it's the photo as
 *  sent; after a reload, the thumbnail this phone kept, smaller; with none kept
 *  (another device, or the conversation ended), a chip. A tap on either shows
 *  what she saved of it. */
function UserLine({ line }: { line: Line }) {
  const [open, setOpen] = useState(false);
  const p = line.photo;
  const canOpen = !!p?.transcript;
  return (
    <div className="tutor-me">
      {p && (p.thumb
        ? <button className={`tutor-photo${p.live ? '' : ' kept'}`} onClick={() => canOpen && setOpen(!open)} aria-label={p.label ?? '写真'}><img src={p.thumb} alt="" /></button>
        : <button className="tutor-photochip" onClick={() => canOpen && setOpen(!open)}><Camera size={15} strokeWidth={1.6} /><span>写真{p.label ? ` · ${p.label}` : ''}</span></button>)}
      {open && p?.transcript && <div className="tutor-a tutor-transcript">{p.transcript}</div>}
      {line.text && <div className="tutor-u">{line.text}</div>}
    </div>
  );
}

const LEAKED_CALL_RE = /<\/?(?:antml:)?(?:invoke|function_calls|parameter)\b[\s\S]*$/;

/** ハルカ's turn: Japanese lines with tappable words, asides set apart. */
function AssistantLine({ text, pending, lookup }: { text: string; pending?: boolean; lookup: ReturnType<typeof useWordLookup> }) {
  // A tool call she wrote out as text (the server strips and carries it out; hide it while streaming).
  text = text.replace(LEAKED_CALL_RE, '').trimEnd();
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
  if (action.type === 'content_offer') return <ContentOffer action={action} onDismiss={onDismiss} />;
  return null;
}

/** The tutor offers a podcast; it's made only when the learner taps 作る, with
 *  their own session (and so their own limits). The tutor never starts paid
 *  generation by itself, so text in an article can't trigger it (CLAUDE.md › Security). */
function ContentOffer({ action, onDismiss }: {
  action: Extract<TutorAction, { type: 'content_offer' }>;
  onDismiss: () => void;
}) {
  const [state, setState] = useState<'offer' | 'making' | 'made' | 'error'>('offer');
  const [error, setError] = useState('');
  const make = async () => {
    setState('making');
    try {
      await createEpisode({ kind: 'topic', topic: action.topic }, 5, action.angle);
      setState('made');
    } catch (e) {
      setError(await episodeErrorMessage(e));
      setState('error');
    }
  };
  if (state === 'made') return <div className="tutor-ctx">番組「{action.topic}」を作っています · 聞くに届きます</div>;
  return (
    <div className="tutor-a">
      番組「{action.topic}」を作る？
      {state === 'error' && <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: '0.3rem' }}>{error}</div>}
      <div className="tutor-suggestion">
        <button onClick={make} disabled={state === 'making'}>{state === 'making' ? '準備中…' : '作る'}</button>
        <button onClick={onDismiss}>いいえ</button>
      </div>
    </div>
  );
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
