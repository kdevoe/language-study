import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, Reorder, animate, useDragControls, useMotionValue, useTransform, type PanInfo } from 'framer-motion';
import { Check, ChevronLeft, GripVertical, Plus, Shuffle } from 'lucide-react';
import { CreateButton } from './PodcastSheet';
import { Collage, Grabber, MusicToast, NameField, coverOf, fmtDuration, sheetBackdrop, sheetPanel, sheetSpring, useToast } from './MusicParts';
import { useScrollLock } from '../hooks/useScrollLock';
import type { Song } from '../services/songs';
import { styleLabel } from '../data/songStyles';
import {
  type Playlist, addToPlaylist, createPlaylist, removeFromPlaylist, renamePlaylist, reorderPlaylist, restoreToPlaylist,
} from '../services/playlists';

// A list's page, the song picker and the new-list sheet (mockup
// docs/mockups/music-lists.html, flow C; music-playlists.html option 3).

const EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';
const REMOVE_AT = 0.35; // a left swipe past this share of the row takes the song out

export const shuffled = <T,>(xs: T[]) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

// ── List page ────────────────────────────────────────────────────────────────
// Collage, name (tap to rename), count and length, then 再生 (the lifted
// button) with シャッフル beside it. Songs as rows: drag the grip to reorder,
// swipe left to take one out (元に戻す in the toast). ＋ 曲を追加 opens the picker.
// `fixed` is the built-in すべての曲 list: every song, newest first, nothing to edit.
export function PlaylistPage({ list, songs, covers, onBack, onPlay, onPick, fixed = false }: {
  list: Playlist;
  fixed?: boolean;
  songs: Song[];
  covers: Record<string, string>;
  onBack: () => void;
  onPlay: (song: Song, queue: Song[]) => void;
  onPick: () => void;
}) {
  const byId = new Map(songs.map((s) => [s.id, s]));
  const listSongs = list.song_ids.map((id) => byId.get(id)).filter((s): s is Song => !!s && s.status === 'ready');
  const [order, setOrder] = useState(listSongs.map((s) => s.id));
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(list.name);
  const { toast, show, hide } = useToast<{ songId: string; index: number }>();
  const dragging = useRef(false);
  const orderRef = useRef(order);
  orderRef.current = order;

  const key = listSongs.map((s) => s.id).join('|');
  useEffect(() => { if (!dragging.current) setOrder(listSongs.map((s) => s.id)); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const ordered = order.map((id) => byId.get(id)).filter((s): s is Song => !!s);
  const minutes = Math.max(1, Math.round(ordered.reduce((n, s) => n + (s.duration_ms ?? s.minutes * 60_000), 0) / 60_000));

  const commitName = () => {
    setRenaming(false);
    if (name.trim() && name.trim() !== list.name) renamePlaylist(list.id, name).catch(() => setName(list.name));
    else setName(list.name);
  };
  const remove = (songId: string) => {
    const index = list.song_ids.indexOf(songId);
    removeFromPlaylist(list.id, songId).catch(() => {});
    show({ songId, index });
  };

  return (
    <div className="fade-in" style={{ paddingBottom: '7rem' }}>
      <button onClick={onBack} aria-label="戻る" style={{ height: 44, width: 44, margin: '-0.4rem 0 0.4rem -0.6rem', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <ChevronLeft size={24} strokeWidth={1.5} />
      </button>

      <div style={{ textAlign: 'center' }}>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <Collage urls={ordered.slice(0, 4).map((s) => coverOf(s, covers))} size={168} radius={20} shadow="0 10px 30px rgba(0,0,0,0.12)" />
        </div>
        {renaming ? (
          <div style={{ maxWidth: 280, margin: '0.9rem auto 0', textAlign: 'center' }}>
            <NameField value={name} onChange={setName} onSubmit={commitName} />
            <button onClick={commitName} className="serif" style={{ marginTop: '0.6rem', border: 'none', background: 'none', cursor: 'pointer', fontSize: '0.85rem', color: 'var(--text-main)' }}>保存</button>
          </div>
        ) : (
          <h1 onClick={() => { if (!fixed) setRenaming(true); }} className="serif" style={{ fontSize: '1.5rem', fontWeight: 500, marginTop: '1.1rem', color: 'var(--text-main)', cursor: fixed ? 'default' : 'text', lineHeight: 1.35 }}>{list.name}</h1>
        )}
        <div style={{ fontSize: '0.72rem', fontWeight: 500, color: 'var(--text-muted)', marginTop: '0.15rem' }}>{ordered.length}曲{ordered.length > 0 && ` · 約${minutes}分`}</div>
      </div>

      {ordered.length === 0 ? (
        <div style={{ textAlign: 'center', marginTop: '2.4rem' }}>
          <div className="serif" style={{ fontSize: '1.05rem', color: 'var(--text-main)' }}>まだ曲がありません</div>
          <div style={{ marginTop: '1.1rem', display: 'flex', justifyContent: 'center' }}><CreateButton ready busy={false} onClick={onPick} label="曲を選ぶ" /></div>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '1.6rem', margin: '1.2rem 0 1.6rem' }}>
            <CreateButton ready busy={false} onClick={() => onPlay(ordered[0], ordered)} label="▶ 再生" />
            <button onClick={() => { const q = shuffled(ordered); onPlay(q[0], q); }} className="serif" style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '0.95rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <Shuffle size={16} strokeWidth={1.5} /> シャッフル
            </button>
          </div>

          <Reorder.Group axis="y" values={order} onReorder={setOrder} style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {ordered.map((s) => (
              <SongRow
                key={s.id}
                song={s}
                fixed={fixed}
                cover={coverOf(s, covers)}
                onTap={() => onPlay(s, ordered)}
                onRemove={() => remove(s.id)}
                onDragStart={() => { dragging.current = true; }}
                onDragEnd={() => { dragging.current = false; reorderPlaylist(list.id, orderRef.current).catch(() => {}); }}
              />
            ))}
          </Reorder.Group>
        </>
      )}

      {ordered.length > 0 && !fixed && (
        <button onClick={onPick} className="serif" style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', padding: '0.55rem 0', border: 'none', background: 'none', cursor: 'pointer', fontSize: '1rem', color: 'var(--text-muted)', width: '100%' }}>
          <span style={{ width: 48, height: 48, borderRadius: 10, backgroundColor: 'var(--bg-card)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Plus size={20} strokeWidth={1.5} /></span>
          曲を追加
        </button>
      )}

      {toast && (
        <MusicToast onDismiss={hide} action="元に戻す" onAction={() => { restoreToPlaylist(list.id, toast.songId, toast.index).catch(() => {}); hide(); }}>
          外しました
        </MusicToast>
      )}
    </div>
  );
}

function SongRow({ song, fixed, cover, onTap, onRemove, onDragStart, onDragEnd }: {
  song: Song;
  fixed: boolean;
  cover?: string;
  onTap: () => void;
  onRemove: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const controls = useDragControls();
  const x = useMotionValue(0);
  const reveal = useTransform(x, [-60, 0], [1, 0]);
  const rowRef = useRef<HTMLDivElement>(null);
  const swallow = useRef(false);

  const endSwipe = (_: unknown, info: PanInfo) => {
    const width = rowRef.current?.offsetWidth ?? 340;
    if (x.get() < -width * REMOVE_AT || info.velocity.x < -900) {
      animate(x, -width, { duration: 0.2 });
      onRemove();
    } else {
      animate(x, 0, { type: 'spring', stiffness: 600, damping: 45 });
    }
  };

  return (
    <Reorder.Item value={song.id} dragListener={false} dragControls={controls} onDragStart={onDragStart} onDragEnd={onDragEnd} style={{ position: 'relative', listStyle: 'none' }}>
      {!fixed && (
        <motion.div style={{ opacity: reveal, position: 'absolute', inset: '2px 0', borderRadius: 14, backgroundColor: 'var(--accent-danger)', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: '1.2rem' }}>
          <span className="serif" style={{ fontSize: '0.9rem', color: 'var(--text-main)' }}>外す</span>
        </motion.div>
      )}
      <motion.div
        ref={rowRef}
        drag={fixed ? false : 'x'}
        dragDirectionLock
        dragConstraints={{ left: -10_000, right: 0 }}
        dragElastic={{ left: 0, right: 0.05 }}
        dragMomentum={false}
        onDragStart={() => { swallow.current = true; }}
        onDragEnd={endSwipe}
        onPointerDown={() => { swallow.current = false; }}
        onClick={() => { if (!swallow.current) onTap(); }}
        style={{ x, position: 'relative', display: 'flex', alignItems: 'center', gap: '0.85rem', padding: '0.55rem 0', backgroundColor: 'var(--bg-color)', cursor: 'pointer', touchAction: 'pan-y', userSelect: 'none', WebkitUserSelect: 'none' }}
      >
        <div style={{ width: 48, height: 48, borderRadius: 10, flex: 'none', backgroundColor: 'var(--bg-card)', backgroundImage: cover ? `url("${cover}")` : undefined, backgroundSize: 'cover' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="serif" style={{ fontSize: '1rem', color: 'var(--text-main)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{song.title}</div>
          <div style={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.06em', color: 'var(--text-muted)' }}>{styleLabel(song.style_key)}</div>
        </div>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{fmtDuration(song.duration_ms)}</span>
        {!fixed && <span
          onPointerDown={(e) => { e.stopPropagation(); controls.start(e); }}
          onClick={(e) => e.stopPropagation()}
          aria-label="並べ替え"
          style={{ color: 'var(--border-light)', display: 'flex', padding: '0.6rem 0 0.6rem 0.3rem', cursor: 'grab', touchAction: 'none' }}
        >
          <GripVertical size={18} strokeWidth={1.5} />
        </span>}
      </motion.div>
    </Reorder.Item>
  );
}

// ── Song picker ──────────────────────────────────────────────────────────────
// The covers with a check circle each (§6.8's select pattern); picked ones lift.
// The bar over the nav shows the count and 追加. Songs already in the list start
// checked; unchecking one takes it out.
export function SongPicker({ list, songs, covers, onDone }: {
  list: Playlist;
  songs: Song[];
  covers: Record<string, string>;
  onDone: () => void;
}) {
  const ready = songs.filter((s) => s.status === 'ready');
  const [sel, setSel] = useState<Set<string>>(() => new Set(list.song_ids));
  const toggle = (id: string) => setSel((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const adding = ready.filter((s) => sel.has(s.id) && !list.song_ids.includes(s.id)).map((s) => s.id);
  const dropping = list.song_ids.filter((id) => !sel.has(id) && ready.some((s) => s.id === id));
  const changed = adding.length > 0 || dropping.length > 0;

  const save = () => {
    if (adding.length) addToPlaylist(list.id, adding).catch(() => {});
    for (const id of dropping) removeFromPlaylist(list.id, id).catch(() => {});
    onDone();
  };

  return (
    <div className="fade-in" style={{ paddingBottom: '8rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: '2.75rem' }}>
        <h1 className="serif" style={{ fontSize: '1.5rem', fontWeight: 500, color: 'var(--text-main)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{list.name}</h1>
        <button onClick={onDone} className="serif" style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '0.95rem', color: 'var(--text-muted)', flex: 'none' }}>あとで</button>
      </div>
      <div style={{ fontSize: '0.72rem', fontWeight: 500, color: 'var(--text-muted)', marginBottom: '1.3rem' }}>曲を選ぶ</div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.6rem 0.9rem' }}>
        {ready.map((s) => {
          const on = sel.has(s.id);
          const cover = coverOf(s, covers);
          return (
            <div key={s.id} role="checkbox" aria-checked={on} tabIndex={0} onClick={() => toggle(s.id)} style={{ cursor: 'pointer', userSelect: 'none' }}>
              <div style={{ aspectRatio: '1', borderRadius: 16, position: 'relative', overflow: 'hidden', backgroundColor: 'var(--bg-card)', backgroundImage: cover ? `url("${cover}")` : undefined, backgroundSize: 'cover', boxShadow: on ? '0 0 0 3px var(--bg-pure), 0 6px 18px rgba(0,0,0,0.14)' : '0 4px 25px rgba(0,0,0,0.06)', transform: on ? 'translateY(-1px)' : 'none', transition: `all 0.4s ${EASE}` }}>
                <span style={{ position: 'absolute', top: 8, right: 8, width: 24, height: 24, borderRadius: '50%', border: `1.5px solid ${on ? 'var(--text-main)' : 'rgba(255,255,255,0.95)'}`, backgroundColor: on ? 'var(--text-main)' : 'rgba(45,45,45,0.15)', color: 'var(--bg-pure)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {on && <Check size={14} strokeWidth={2.5} />}
                </span>
              </div>
              <div className="serif" style={{ fontSize: '1.05rem', lineHeight: 1.45, marginTop: '0.6rem', color: 'var(--text-main)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{s.title}</div>
              <div style={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.06em', color: 'var(--text-muted)', marginTop: '0.2rem' }}>{styleLabel(s.style_key)}</div>
            </div>
          );
        })}
      </div>

      <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 30, backgroundColor: 'var(--bg-pure)', borderTop: '1px solid var(--border-light)', padding: '0.9rem 1.4rem calc(1rem + env(safe-area-inset-bottom))' }}>
        <div style={{ maxWidth: 600, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{sel.size}曲</span>
          <CreateButton ready={changed} busy={false} onClick={save} label={adding.length || !dropping.length ? '追加' : '完了'} />
        </div>
      </div>
    </div>
  );
}

// ── New list (from the shelf) ────────────────────────────────────────────────
// Title and one hero input; 作る makes the list and goes straight to the picker.
export function NewListSheet({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (list: Playlist) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useScrollLock(open);
  useEffect(() => { if (open) { setName(''); setError(false); } }, [open]);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const list = await createPlaylist(name);
      onClose();
      onCreated(list);
    } catch (e) {
      console.error('[lists] create failed:', e);
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div key="nl-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} style={sheetBackdrop} />
          <motion.div key="nl-sheet" role="dialog" aria-label="新しいリスト" initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={sheetSpring} style={sheetPanel}>
            <Grabber />
            <h2 className="serif" style={{ fontSize: '1.3rem', fontWeight: 600, marginBottom: '1.1rem', color: 'var(--text-main)' }}>新しいリスト</h2>
            <NameField value={name} onChange={setName} onSubmit={create} />
            {error && <div role="alert" style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.6rem' }}>作れませんでした。もう一度試してください。</div>}
            <div style={{ marginTop: '1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
              <button onClick={onClose} className="serif" style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '0.95rem', color: 'var(--text-muted)', padding: 0 }}>やめる</button>
              <CreateButton ready={!!name.trim() && !busy} busy={busy} onClick={create} />
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
