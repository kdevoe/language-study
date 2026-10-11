import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, animate, motion, useMotionValue, useTransform } from 'framer-motion';
import type { PanInfo } from 'framer-motion';
import { Check, ChevronDown, Plus, Search, Trash2, X } from 'lucide-react';
import { findIn, matchItem } from '../services/archiveSearch';
import type { SearchCorpus, Snippet } from '../services/archiveSearch';
import type { UiLabelId } from '../services/uiLabels';
import { PageHeading } from './PageHeading';
import { useAdaptiveText } from './AdaptiveLabel';

// The archive list behind LISTEN (聴く) and LIBRARY (書庫), mockup
// docs/mockups/archive-organize.html. iPhotos-like: items group by month, the
// newest month open and older ones collapsed; a search line matches Japanese
// or English; swipe a card left to delete it (a long swipe deletes outright);
// long-press enters select mode for deleting several. Deletes wait behind a
// 元に戻す toast for a few seconds before they reach the server.

const EASE = [0.4, 0, 0.2, 1] as const;
const LONG_PRESS_MS = 500;
const MOVE_SLOP_PX = 8;
const REVEAL_PX = 96;
const FULL_SWIPE = 0.55;
const UNDO_MS = 5000;

export interface ArchiveCard {
  tag: string;
  status: ReactNode;
  title: string;
  /** Muted when the item has no real title yet (e.g. still being made). */
  titleMuted?: boolean;
  meta: ReactNode;
  /** 0–1, drawn as a thin bar along the bottom edge. */
  progress?: number;
  /** White card (e.g. the daily digest) instead of the soft card fill. */
  featured?: boolean;
  /** False for items that can't be opened yet; taps do nothing. */
  openable: boolean;
}

interface Props<T extends { id: string }> {
  titleId: UiLabelId;
  /** The + beside the settings mark in the page heading. */
  onAdd: () => void;
  addLabel: string;
  items: T[];
  isLoading: boolean;
  createdAt: (item: T) => string;
  card: (item: T) => ArchiveCard;
  /** Japanese/English body text per id, fetched on first search. */
  loadSearchText: () => Promise<SearchCorpus>;
  /** Counted on a collapsed month's summary line (未再生 / 未読). */
  isUnfinished: (item: T) => boolean;
  unfinishedLabel: string;
  /** Counter for a month's summary line (本 / 作品). */
  unit: string;
  onOpen: (item: T) => void;
  /** Server delete; the parent drops the rows from its state when it resolves. */
  onDelete: (ids: string[]) => Promise<void>;
  /** Rendered above the months (e.g. an import in progress). */
  leading?: ReactNode;
  empty: ReactNode;
  /** Remembers which months were opened or closed while the app is open. */
  memoryKey: string;
}

const collapseMemory = new Map<string, Map<string, boolean>>();

const monthKeyOf = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

function Highlight({ text, query }: { text: string; query: string }) {
  const i = findIn(text, query);
  if (i < 0) return <>{text}</>;
  const n = query.trim().length;
  return (
    <>
      {text.slice(0, i)}
      <mark style={markStyle}>{text.slice(i, i + n)}</mark>
      {text.slice(i + n)}
    </>
  );
}

const markStyle = { backgroundColor: 'var(--accent-primary)', color: 'var(--text-main)', borderRadius: '3px', padding: '0 2px' };

export function ArchiveList<T extends { id: string }>(props: Props<T>) {
  const { items, createdAt, card, isUnfinished, onDelete, memoryKey } = props;
  const [query, setQuery] = useState('');
  const searchLabel = useAdaptiveText('search');
  const [corpus, setCorpus] = useState<SearchCorpus | null>(null);
  const corpusRequested = useRef(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ text: string; undo: boolean } | null>(null);
  const [collapseOverrides, setCollapseOverrides] = useState<Map<string, boolean>>(
    () => collapseMemory.get(memoryKey) ?? new Map(),
  );
  const pendingRef = useRef<{ ids: string[]; timer: ReturnType<typeof setTimeout> } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  const mountedRef = useRef(true);

  useEffect(() => { collapseMemory.set(memoryKey, collapseOverrides); }, [memoryKey, collapseOverrides]);

  const showToast = useCallback((text: string, undo: boolean) => {
    setToast({ text, undo });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), UNDO_MS);
  }, []);

  // ── Deleting: hide now, commit after the undo window ──────────────────────
  const commit = useCallback((ids: string[]) => {
    onDelete(ids).catch((e) => {
      console.error('[archive] delete failed:', e);
      if (!mountedRef.current) return;
      setHidden((prev) => { const next = new Set(prev); ids.forEach((id) => next.delete(id)); return next; });
      showToast('削除できませんでした', false);
    });
  }, [onDelete, showToast]);

  const flushPending = useCallback(() => {
    const p = pendingRef.current;
    if (!p) return;
    clearTimeout(p.timer);
    pendingRef.current = null;
    commit(p.ids);
  }, [commit]);

  const remove = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    flushPending();
    setHidden((prev) => new Set([...prev, ...ids]));
    setOpenId(null);
    const timer = setTimeout(flushPending, UNDO_MS);
    pendingRef.current = { ids, timer };
    showToast(`${ids.length}件を削除しました`, true);
  }, [flushPending, showToast]);

  const undo = () => {
    const p = pendingRef.current;
    if (!p) return;
    clearTimeout(p.timer);
    pendingRef.current = null;
    setHidden((prev) => { const next = new Set(prev); p.ids.forEach((id) => next.delete(id)); return next; });
    setToast(null);
  };

  // Leaving the tab (or the page) inside the undo window still deletes.
  const flushRef = useRef(flushPending);
  flushRef.current = flushPending;
  useEffect(() => {
    const onHide = () => flushRef.current();
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      mountedRef.current = false;
      clearTimeout(toastTimer.current);
      flushRef.current();
    };
  }, []);

  // ── Search ────────────────────────────────────────────────────────────────
  const { loadSearchText } = props;
  const ensureCorpus = useCallback(() => {
    if (corpusRequested.current) return;
    corpusRequested.current = true;
    loadSearchText()
      .then((c) => { if (mountedRef.current) setCorpus(c); })
      .catch((e) => {
        console.warn('[archive] search text unavailable; matching titles only:', e);
        corpusRequested.current = false;
      });
  }, [loadSearchText]);

  const q = query.trim();
  const visible = useMemo(() => {
    const rows: { item: T; card: ArchiveCard; snippet?: Snippet }[] = [];
    for (const item of items) {
      if (hidden.has(item.id)) continue;
      const c = card(item);
      const m = matchItem([c.title, c.tag], corpus?.get(item.id), q);
      if (m.hit) rows.push({ item, card: c, snippet: m.snippet });
    }
    return rows;
  }, [items, hidden, card, corpus, q]);

  const months = useMemo(() => {
    const groups = new Map<string, typeof visible>();
    const sorted = [...visible].sort((a, b) => createdAt(b.item).localeCompare(createdAt(a.item)));
    for (const row of sorted) {
      const k = monthKeyOf(createdAt(row.item));
      const list = groups.get(k) ?? [];
      list.push(row);
      groups.set(k, list);
    }
    return [...groups.entries()];
  }, [visible, createdAt]);

  const newestMonth = months[0]?.[0];
  // The newest month is the list itself: no heading, always open. Its heading
  // only appears while searching or selecting (results by month, すべて選択).
  const headless = (k: string) => k === newestMonth && !q && !selecting;
  const isCollapsed = (k: string) => !headless(k) && !q && (collapseOverrides.get(k) ?? k !== newestMonth);
  const toggleMonth = (k: string) => {
    setOpenId(null);
    setCollapseOverrides((prev) => new Map(prev).set(k, !isCollapsed(k)));
  };

  // ── Select mode ───────────────────────────────────────────────────────────
  const enterSelect = (id: string) => {
    setOpenId(null);
    setSelecting(true);
    setSelected(new Set([id]));
    try { navigator.vibrate?.(10); } catch { /* unsupported */ }
  };
  const exitSelect = () => { setSelecting(false); setSelected(new Set()); };
  const toggleSelected = (id: string) =>
    setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const deleteSelected = () => {
    const ids = [...selected].filter((id) => !hidden.has(id));
    exitSelect();
    remove(ids);
  };

  const now = new Date();
  const currentMonth = monthKeyOf(now.toISOString());

  return (
    <div style={{ paddingBottom: '6rem' }}>
      {/* Header: the page heading with search and + below it, or the selection count + 完了 */}
      {selecting ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: '2.75rem', marginBottom: '1rem' }}>
          <div className="serif" style={{ fontSize: '1.4rem', fontWeight: 500, lineHeight: 1.6, color: 'var(--text-main)' }}>
            {selected.size ? `${selected.size}件を選択` : '項目を選択'}
          </div>
          <button onClick={exitSelect} className="serif" style={textBtn(true)}>完了</button>
        </div>
      ) : (
        <PageHeading id={props.titleId} actions={<AddButton onClick={props.onAdd} label={props.addLabel} />} />
      )}

      {/* Search: hero input on a hairline (design-system §6.4), full width */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: q ? '0.8rem' : '1.6rem' }}>
        <label style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '0.6rem', borderBottom: '1px solid var(--border-light)', padding: '0.35rem 0 0.55rem' }}>
          <Search size={18} strokeWidth={1.5} color="var(--text-muted)" style={{ flex: 'none' }} />
          <input
            type="search"
            value={query}
            onChange={(e) => { setQuery(e.target.value); if (e.target.value.trim()) ensureCorpus(); }}
            onFocus={ensureCorpus}
            placeholder={searchLabel}
            aria-label={searchLabel}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="serif archive-search"
            data-placeholder-lang={searchLabel === 'Search' ? 'en' : 'ja'}
            style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', fontSize: '1.15rem', color: 'var(--text-main)' }}
          />
          {query && (
            <button onClick={() => setQuery('')} aria-label="クリア" style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '0.2rem', display: 'flex' }}>
              <X size={16} strokeWidth={1.5} />
            </button>
          )}
        </label>
      </div>
      {q && (
        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 500, marginBottom: '1.4rem' }}>{visible.length}件</div>
      )}

      {props.leading}

      {props.isLoading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {[1, 2].map((i) => (
            <div key={i} className="skeleton-shimmer" style={{ width: '100%', height: '140px', borderRadius: '24px' }} />
          ))}
        </div>
      ) : visible.length === 0 ? (
        q ? (
          <div style={{ textAlign: 'center', padding: '3rem 1rem', color: 'var(--text-muted)' }}>
            <h2 className="serif" style={{ fontSize: '1.3rem', fontWeight: 500, color: 'var(--text-main)', marginBottom: '0.5rem' }}>見つかりません</h2>
            <p style={{ fontSize: '0.85rem' }}>「{q}」</p>
          </div>
        ) : props.empty
      ) : (
        months.map(([k, rows]) => {
          const [y, m] = k.split('-').map(Number);
          const collapsed = isCollapsed(k);
          const unfinished = rows.filter((r) => isUnfinished(r.item)).length;
          const allSelected = rows.every((r) => selected.has(r.item.id));
          return (
            <section key={k} style={{ marginBottom: '2.2rem' }}>
              {!headless(k) && (
                <div
                  onClick={() => !q && toggleMonth(k)}
                  style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', cursor: q ? 'default' : 'pointer', userSelect: 'none', padding: '0.2rem 0' }}
                >
                  <div>
                    <span className="serif" style={{ fontSize: '1.35rem', fontWeight: 500, color: 'var(--text-main)' }}>{m}月</span>
                    {k !== currentMonth && (
                      <span style={{ fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.06em', color: 'var(--text-muted)', marginLeft: '0.45rem' }}>{y}</span>
                    )}
                  </div>
                  {selecting ? (
                    <button
                      className="serif"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelected((prev) => {
                          const next = new Set(prev);
                          rows.forEach((r) => (allSelected ? next.delete(r.item.id) : next.add(r.item.id)));
                          return next;
                        });
                      }}
                      style={textBtn(false, '0.85rem')}
                    >
                      {allSelected ? '選択解除' : 'すべて選択'}
                    </button>
                  ) : (
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.75rem', fontWeight: 500, color: 'var(--text-muted)' }}>
                      {rows.length}
                      {!q && (
                        <ChevronDown
                          size={16}
                          strokeWidth={1.5}
                          style={{ transform: collapsed ? 'rotate(-90deg)' : 'none', transition: `transform 0.4s cubic-bezier(${EASE.join(',')})` }}
                        />
                      )}
                    </span>
                  )}
                </div>
              )}
              {collapsed && (
                <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                  {rows.length}{props.unit}{unfinished > 0 && ` · ${props.unfinishedLabel} ${unfinished}`}
                </div>
              )}
              <AnimatePresence initial={false}>
                {!collapsed && (
                  <motion.div
                    key="body"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.4, ease: EASE }}
                    style={{ overflow: 'hidden', margin: '0 -12px', padding: '0 12px' }}
                  >
                    <div style={{ paddingTop: headless(k) ? 0 : '0.9rem' }}>
                      <AnimatePresence initial={false}>
                        {rows.map(({ item, card: c, snippet }) => (
                          <SwipeRow
                            key={item.id}
                            id={item.id}
                            openId={openId}
                            setOpenId={setOpenId}
                            selecting={selecting}
                            onDelete={() => remove([item.id])}
                            onLongPress={() => enterSelect(item.id)}
                            onTap={() => (selecting ? toggleSelected(item.id) : c.openable && props.onOpen(item))}
                          >
                            <CardBody card={c} query={q} snippet={snippet} selecting={selecting} selected={selected.has(item.id)} />
                          </SwipeRow>
                        ))}
                      </AnimatePresence>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </section>
          );
        })
      )}

      {/* Select-mode action bar, laid over the bottom nav */}
      <AnimatePresence>
        {selecting && (
          <motion.div
            key="actionbar"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            style={{
              position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 30,
              backgroundColor: 'var(--bg-pure)', borderTop: '1px solid var(--border-light)',
              minHeight: 'calc(88px + env(safe-area-inset-bottom))',
              padding: '1rem 1.5rem calc(1rem + env(safe-area-inset-bottom))',
              display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
            }}
          >
            <div style={{ width: '100%', maxWidth: '560px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '0.8rem', fontWeight: 500, color: 'var(--text-muted)' }}>
                {selected.size ? `${selected.size}件` : '項目を選択'}
              </span>
              <button onClick={deleteSelected} disabled={selected.size === 0} className="serif" style={deleteBtn(selected.size > 0)}>
                <Trash2 size={17} strokeWidth={1.5} /> 削除
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Toast (design-system §6.6) with 元に戻す */}
      <AnimatePresence>
        {toast && (
          <motion.div
            key="toast"
            role="status"
            initial={{ y: -80, x: '-50%' }}
            animate={{ y: 0, x: '-50%' }}
            exit={{ y: -80, x: '-50%' }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            style={{
              position: 'fixed', top: 'calc(env(safe-area-inset-top) + 1rem)', left: '50%', zIndex: 60,
              backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-light)', borderRadius: '14px',
              boxShadow: '0 6px 30px rgba(0,0,0,0.12)', padding: toast.undo ? '0.6rem 0.7rem 0.6rem 1.1rem' : '0.75rem 1.1rem',
              fontSize: '0.85rem', color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: '1rem', whiteSpace: 'nowrap',
            }}
          >
            {toast.text}
            {toast.undo && (
              <button
                onClick={undo}
                className="serif"
                style={{ border: 'none', backgroundColor: 'var(--bg-pure)', borderRadius: '100px', padding: '0.35rem 0.85rem', fontSize: '0.85rem', cursor: 'pointer', color: 'var(--text-main)', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' }}
              >
                元に戻す
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── One card's contents ─────────────────────────────────────────────────────
function CardBody({ card, query, snippet, selecting, selected }: {
  card: ArchiveCard; query: string; snippet?: Snippet; selecting: boolean; selected: boolean;
}) {
  return (
    <div
      style={{
        backgroundColor: selected || card.featured ? 'var(--bg-pure)' : 'var(--bg-card)',
        borderRadius: '24px',
        padding: '1.4rem 1.5rem',
        border: '1px solid var(--border-light)',
        boxShadow: selected ? '0 2px 8px rgba(0,0,0,0.1)' : '0 4px 25px rgba(0,0,0,0.03)',
        cursor: selecting || card.openable ? 'pointer' : 'default',
        position: 'relative',
        overflow: 'hidden',
        transition: `background-color 0.4s cubic-bezier(${EASE.join(',')}), box-shadow 0.4s cubic-bezier(${EASE.join(',')})`,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.9rem', gap: '0.6rem' }}>
        <span style={{
          fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.15em',
          backgroundColor: card.featured ? 'var(--accent-primary)' : 'var(--bg-pure)',
          color: card.featured ? 'var(--text-main)' : 'var(--text-muted)',
          padding: '0.3rem 0.7rem', borderRadius: '8px',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '62%',
        }}>
          <Highlight text={card.tag} query={query} />
        </span>
        {selecting ? (
          <span
            aria-hidden
            style={{
              width: 22, height: 22, borderRadius: '50%', flex: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: `1.5px solid ${selected ? 'var(--text-main)' : 'var(--border-light)'}`,
              backgroundColor: selected ? 'var(--text-main)' : 'transparent',
              color: 'var(--bg-pure)',
              transition: `all 0.3s cubic-bezier(${EASE.join(',')})`,
            }}
          >
            {selected && <Check size={13} strokeWidth={3} />}
          </span>
        ) : card.status}
      </div>

      <h3 className="serif" style={{ fontSize: '1.25rem', fontWeight: 500, lineHeight: 1.5, color: card.titleMuted ? 'var(--text-muted)' : 'var(--text-main)', marginBottom: '0.8rem', maxWidth: '95%' }}>
        <Highlight text={card.title} query={query} />
      </h3>

      <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', fontWeight: 500 }}>{card.meta}</div>

      {snippet && (
        <div
          className={snippet.where === 'ja' ? 'serif' : undefined}
          style={{ marginTop: '0.7rem', fontSize: snippet.where === 'ja' ? '0.85rem' : '0.78rem', lineHeight: 1.6, color: 'var(--text-muted)' }}
        >
          <span style={{ fontFamily: 'var(--font-sans)', fontSize: '0.56rem', fontWeight: 800, letterSpacing: '0.15em', marginRight: '0.45rem', verticalAlign: '1px' }}>
            {snippet.where === 'en' ? 'EN' : 'JA'}
          </span>
          {snippet.before}<mark style={markStyle}>{snippet.match}</mark>{snippet.after}
        </div>
      )}

      {(card.progress ?? 0) > 0 && (
        <div style={{ position: 'absolute', bottom: 0, left: 0, height: '3px', width: `${Math.round(Math.min(1, card.progress!) * 100)}%`, backgroundColor: 'var(--accent-primary)' }} />
      )}
    </div>
  );
}

// ── Swipe-to-delete row (same gesture as the Feed) + long-press ─────────────
function SwipeRow({ id, openId, setOpenId, selecting, onDelete, onLongPress, onTap, children }: {
  id: string;
  openId: string | null;
  setOpenId: (id: string | null) => void;
  selecting: boolean;
  onDelete: () => void;
  onLongPress: () => void;
  onTap: () => void;
  children: ReactNode;
}) {
  const x = useMotionValue(0);
  const actionOpacity = useTransform(x, [-40, 0], [1, 0]);
  const rowRef = useRef<HTMLDivElement>(null);
  const press = useRef<{ x: number; y: number; timer?: ReturnType<typeof setTimeout> } | null>(null);
  // Swallow the click that follows a drag, a long-press or closing another row.
  const swallowClick = useRef(false);
  const isOpen = openId === id;

  const spring = { type: 'spring' as const, stiffness: 600, damping: 45 };

  // Close when another row opens (or select mode starts).
  useEffect(() => {
    if (!isOpen && x.get() !== 0) animate(x, 0, spring);
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancelPress = () => {
    if (press.current?.timer) clearTimeout(press.current.timer);
    press.current = null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    swallowClick.current = false;
    if (openId && openId !== id) {
      // First touch elsewhere just closes the open row.
      setOpenId(null);
      swallowClick.current = true;
      return;
    }
    if (selecting) return;
    press.current = {
      x: e.clientX,
      y: e.clientY,
      timer: setTimeout(() => {
        press.current = null;
        swallowClick.current = true;
        onLongPress();
      }, LONG_PRESS_MS),
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = press.current;
    if (p && (Math.abs(e.clientX - p.x) > MOVE_SLOP_PX || Math.abs(e.clientY - p.y) > MOVE_SLOP_PX)) cancelPress();
  };

  const onDragEnd = (_: unknown, info: PanInfo) => {
    const width = rowRef.current?.offsetWidth ?? 360;
    const pos = x.get();
    if (pos < -width * FULL_SWIPE || (info.velocity.x < -1500 && pos < -REVEAL_PX)) {
      animate(x, -width, { duration: 0.2, ease: EASE });
      onDelete();
    } else if (pos < -REVEAL_PX / 2 || info.velocity.x < -500) {
      animate(x, -REVEAL_PX, spring);
      setOpenId(id);
    } else {
      animate(x, 0, spring);
      if (isOpen) setOpenId(null);
    }
  };

  return (
    <motion.div
      ref={rowRef}
      layout="position"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0, height: 'auto', marginBottom: '1rem' }}
      exit={{ opacity: 0, height: 0, marginBottom: 0, transition: { opacity: { duration: 0.15 }, default: { duration: 0.3, ease: EASE } } }}
      style={{ position: 'relative', marginBottom: '1rem' }}
    >
      {/* What a left swipe reveals */}
      <motion.div
        style={{
          opacity: actionOpacity,
          position: 'absolute', inset: 0, borderRadius: '24px', backgroundColor: 'var(--accent-danger)',
          display: selecting ? 'none' : 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: '1.4rem',
        }}
      >
        <button
          onClick={onDelete}
          aria-label="削除"
          className="serif"
          style={{ border: 'none', background: 'none', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.3rem', fontSize: '0.9rem', color: 'var(--text-main)', width: REVEAL_PX - 28 }}
        >
          <Trash2 size={20} strokeWidth={1.5} />
          削除
        </button>
      </motion.div>

      <motion.div
        drag={selecting ? false : 'x'}
        dragDirectionLock
        dragConstraints={{ left: -10_000, right: 0 }}
        dragElastic={{ left: 0, right: 0.05 }}
        dragMomentum={false}
        onDragStart={() => { cancelPress(); swallowClick.current = true; }}
        onDragEnd={onDragEnd}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        onContextMenu={(e) => {
          // Desktop stand-in for long-press; on touch the timer has already fired.
          e.preventDefault();
          if (!selecting && !swallowClick.current) { cancelPress(); onLongPress(); }
        }}
        onClick={() => {
          if (swallowClick.current) { swallowClick.current = false; return; }
          if (isOpen) { setOpenId(null); return; }
          onTap();
        }}
        whileTap={selecting ? undefined : { scale: 0.98 }}
        style={{ x, position: 'relative', touchAction: 'pan-y', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

/** The heading's +: a plain icon beside the settings mark, matching its size and weight (design-system §6.9). */
function AddButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      style={{
        width: '44px', height: '44px', flex: 'none', border: 'none', background: 'none', cursor: 'pointer',
        color: 'var(--text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <Plus size={22} strokeWidth={1.25} />
    </button>
  );
}

function textBtn(strong: boolean, fontSize = '0.95rem'): React.CSSProperties {
  return {
    background: 'none', border: 'none', cursor: 'pointer', fontSize,
    fontWeight: strong ? 600 : 500, color: 'var(--text-main)', padding: '0.4rem 0.1rem',
  };
}

function deleteBtn(ready: boolean): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: '0.45rem', border: 'none',
    cursor: ready ? 'pointer' : 'default', fontSize: '1rem',
    padding: '0.55rem 1.1rem', borderRadius: '100px',
    backgroundColor: ready ? 'var(--accent-danger)' : 'var(--border-light)',
    color: ready ? 'var(--text-main)' : 'var(--text-muted)',
    opacity: ready ? 1 : 0.7,
    boxShadow: ready ? '0 4px 14px rgba(0,0,0,0.08)' : 'none',
    transition: `all 0.4s cubic-bezier(${EASE.join(',')})`,
  };
}
