import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check } from 'lucide-react';
import { CreateButton } from './PodcastSheet';
import { Grabber, MusicToast, NameField, sheetBackdrop, sheetPanel, sheetSpring, useToast } from './MusicParts';
import { useScrollLock } from '../hooks/useScrollLock';
import type { Song } from '../services/songs';
import { styleLabel } from '../data/songStyles';
import { addToPlaylist, createPlaylist, loadPlaylists, removeFromPlaylist, usePlaylists } from '../services/playlists';

// リストに追加 (mockup docs/mockups/music-lists.html, flows A, B and D): the one
// sheet every add goes through — from the player's back row or a long-pressed
// cover. The song, then the reader's lists (last used first) as pick rows:
// white with a check = the song is in it. Tapping a list adds the song; the row
// lifts, the sheet closes on its own and a toast names the list with 元に戻す.
// Tapping a white row takes the song out and the sheet stays. ＋ 新しいリスト
// swaps in place for a name field; 作る makes the list with this song in it.

const CLOSE_AFTER_MS = 550;

interface Props {
  /** The song to add; null keeps the sheet closed. */
  song: Song | null;
  cover?: string;
  onClose: () => void;
  /** Where the toast sits (the player keeps its back row clear). */
  toastTop?: string;
}

type Toast = { text: string; name?: string; undo?: () => void };

export function AddToListSheet({ song, cover, onClose, toastTop }: Props) {
  const { lists, loaded } = usePlaylists();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [lifted, setLifted] = useState<string | null>(null);
  const { toast, show, hide } = useToast<Toast>();
  const closeTimer = useRef<number | null>(null);
  // The rows keep the order they opened in, so a tapped list never jumps under the finger.
  const [order, setOrder] = useState<string[]>([]);
  const open = !!song;

  useScrollLock(open);
  useEffect(() => { if (open) loadPlaylists(); }, [open]);
  // Each opening starts on the lists (or straight on the name field when there are none).
  useEffect(() => {
    if (!open) return;
    setName('');
    setLifted(null);
    setNaming(loaded && lists.length === 0);
    setOrder(lists.map((l) => l.id));
  }, [open, song?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const rank = (id: string) => { const i = order.indexOf(id); return i < 0 ? -1 : i; }; // new lists first
  const rows = [...lists].sort((a, b) => rank(a.id) - rank(b.id));
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  if (!song && !toast) return null;

  const fail = () => show({ text: '保存できませんでした' });

  const tapList = (id: string, listName: string, isIn: boolean) => {
    if (!song || closeTimer.current) return;
    if (isIn) {
      removeFromPlaylist(id, song.id).catch(fail);
      return;
    }
    setLifted(id);
    const songId = song.id;
    addToPlaylist(id, [songId]).catch(fail);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      onClose();
      show({ text: 'に追加', name: listName, undo: () => { removeFromPlaylist(id, songId).catch(fail); hide(); } });
    }, CLOSE_AFTER_MS);
  };

  const create = async () => {
    if (!song || !name.trim() || busy) return;
    setBusy(true);
    try {
      const list = await createPlaylist(name, [song.id]);
      onClose();
      show({ text: 'を作りました', name: `「${list.name}」` });
    } catch (e) {
      console.error('[lists] create failed:', e);
      fail();
    } finally {
      setBusy(false);
    }
  };

  // Name ideas from the song itself: its theme and its style.
  const suggestions = song ? [song.theme?.trim(), styleLabel(song.style_key)]
    .filter((s): s is string => !!s && s.length <= 20 && !lists.some((l) => l.name === s)) : [];

  return (
    <>
      <AnimatePresence>
        {song && (
          <>
            <motion.div key="atl-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} style={sheetBackdrop} />
            <motion.div
              key="atl-sheet"
              role="dialog"
              aria-label="リストに追加"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={sheetSpring}
              style={sheetPanel}
            >
              <Grabber />
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', marginBottom: '1.3rem' }}>
                <div style={{ width: 44, height: 44, borderRadius: 10, flex: 'none', backgroundColor: 'var(--bg-card)', backgroundImage: cover ? `url("${cover}")` : undefined, backgroundSize: 'cover' }} />
                <div style={{ minWidth: 0 }}>
                  <div className="serif" style={{ fontSize: '1.15rem', fontWeight: 600, color: 'var(--text-main)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{song.title}</div>
                  <div style={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.06em', color: 'var(--text-muted)' }}>{styleLabel(song.style_key)}</div>
                </div>
              </div>

              {lists.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem', maxHeight: naming ? '9.5rem' : '45vh', overflowY: 'auto', margin: '0 -0.4rem', padding: '0.2rem 0.4rem' }}>
                  {rows.map((l) => {
                    const isIn = l.song_ids.includes(song.id);
                    const on = isIn || lifted === l.id;
                    return (
                      <button
                        key={l.id}
                        onClick={() => tapList(l.id, l.name, isIn)}
                        aria-pressed={isIn}
                        className="serif"
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.8rem', padding: '0.8rem 1rem', borderRadius: '16px',
                          border: 'none', cursor: 'pointer', fontSize: '1rem', color: 'var(--text-main)', textAlign: 'left', flex: 'none',
                          backgroundColor: on ? 'var(--bg-pure)' : 'transparent',
                          opacity: on ? 1 : 0.5,
                          boxShadow: on ? '0 2px 8px rgba(0,0,0,0.08)' : 'none',
                          transform: lifted === l.id ? 'translateY(-1px)' : 'none',
                          transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                        }}
                      >
                        <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', minWidth: 0 }}>
                          {on && <Check size={16} strokeWidth={2} style={{ flex: 'none' }} />}
                          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.name}</span>
                        </span>
                        <small className="sans" style={{ fontSize: '0.72rem', color: 'var(--text-muted)', flex: 'none' }}>{l.song_ids.length}曲</small>
                      </button>
                    );
                  })}
                </div>
              )}

              {naming ? (
                <div style={{ marginTop: lists.length ? '1.2rem' : 0 }}>
                  <NameField value={name} onChange={setName} onSubmit={create} suggestions={suggestions} />
                  <div style={{ marginTop: '1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                    <button onClick={() => (lists.length ? setNaming(false) : onClose())} className="serif" style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '0.95rem', color: 'var(--text-muted)', padding: 0 }}>やめる</button>
                    <CreateButton ready={!!name.trim() && !busy} busy={busy} onClick={create} />
                  </div>
                </div>
              ) : (
                <div style={{ height: '2.4rem', marginTop: '0.8rem', display: 'flex', alignItems: 'center' }}>
                  <button onClick={() => setNaming(true)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: '0.8rem', letterSpacing: '0.04em', color: 'var(--text-muted)' }}>
                    ＋ 新しいリスト
                  </button>
                </div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
      {toast && (
        <MusicToast top={toastTop} onDismiss={hide} action={toast.undo ? '元に戻す' : undefined} onAction={toast.undo}>
          {toast.name && <b style={{ fontWeight: 600 }}>{toast.name}</b>}{toast.text}
        </MusicToast>
      )}
    </>
  );
}
