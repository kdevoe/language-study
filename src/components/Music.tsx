import { useCallback, useEffect, useRef, useState } from 'react';
import { ListPlus, Plus, RotateCw, Trash2 } from 'lucide-react';
import { PageHeading, type TitleSwitch } from './PageHeading';
import { AddButton } from './ArchiveList';
import { SongSheet } from './SongSheet';
import { Song, coverUrls, deleteSongs, fetchSongs, isSongInFlight, retrySong, songErrorMessage } from '../services/songs';
import { readListCache, writeListCache } from '../services/listCache';
import { styleLabel } from '../data/songStyles';
import { AddToListSheet } from './AddToListSheet';
import { NewListSheet, PlaylistPage, SongPicker } from './PlaylistPage';
import { Collage, Kicker, MusicToast, coverOf } from './MusicParts';
import { deletePlaylist, forgetSongInPlaylists, loadPlaylists, usePlaylists, type Playlist } from '../services/playlists';

// 聞く › 音楽 (mockup docs/mockups/music.html, phone 1): a grid of covers, newest
// first — title (serif 1.05rem, two lines) over the style. In-flight songs show
// their stage, a failed one offers 再試行. + opens SongSheet. Long-press a
// cover and it splits: リストに追加 over 削除; the delete waits 5s behind
// 元に戻す (undo, not confirm). Tapping a cover plays it, then carries on
// through the grid.
//
// Lists (mockups music-playlists.html option 3, music-lists.html): a shelf above
// the grid — each list's 2×2 collage, name and count, scrolling sideways, ending
// in ＋ 新しいリスト (name it, then pick songs). Tap a list for its page;
// long-press one for 削除 (undo, as for songs). The shelf always opens with
// すべての曲, a built-in list of every song (newest first) for playing or
// shuffling everything; it can't be edited or deleted.

const POLL_MS = 5000;
const LONG_PRESS_MS = 500;
const UNDO_MS = 5000;
const ALL_LIST_ID = 'all';

interface Props {
  /** Play `song`, then carry on through `queue`; `context` names where it was started (a list). */
  onOpenSong: (song: Song, queue: Song[], context?: string) => void;
  titleSwitch?: TitleSwitch;
  /** The open list (kept by App, so coming back from the player lands on it). */
  listId: string | null;
  onListChange: (id: string | null) => void;
}

export function Music({ onOpenSong, titleSwitch, listId, onListChange }: Props) {
  const [songs, setSongs] = useState<Song[]>(() => readListCache<Song>('songs') ?? []);
  const [isLoading, setIsLoading] = useState(() => readListCache('songs') === null);
  const [covers, setCovers] = useState<Record<string, string>>({});
  const [sheetOpen, setSheetOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null); // the tile showing リストに追加 / 削除
  const [pendingDelete, setPendingDelete] = useState<Song | null>(null);
  const [addSong, setAddSong] = useState<Song | null>(null); // リストに追加 sheet
  const [picking, setPicking] = useState(false);
  const [newListOpen, setNewListOpen] = useState(false);
  const [armedList, setArmedList] = useState<string | null>(null);
  const [pendingListDelete, setPendingListDelete] = useState<Playlist | null>(null);
  const listDeleteTimer = useRef<number | null>(null);
  const { lists, loaded: listsLoaded } = usePlaylists();
  const mountedRef = useRef(true);
  const pressTimer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const deleteTimer = useRef<number | null>(null);
  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error]);

  const load = useCallback(async () => {
    try {
      const list = await fetchSongs();
      if (mountedRef.current) setSongs(list);
    } catch (e) {
      console.error('[music] fetchSongs failed:', e);
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => { load(); loadPlaylists(); }, [load]);
  useEffect(() => { if (!isLoading) writeListCache('songs', songs); }, [songs, isLoading]);

  const anyInFlight = songs.some(isSongInFlight);
  useEffect(() => {
    if (!anyInFlight) return;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [anyInFlight, load]);

  // Covers: sign the ones not already held.
  const coverKey = songs.map((s) => s.cover_path ?? '').join('|');
  useEffect(() => {
    const paths = songs.map((s) => s.cover_path).filter((p): p is string => !!p);
    if (!paths.length) return;
    coverUrls(paths).then((m) => { if (mountedRef.current) setCovers((prev) => ({ ...prev, ...m })); }).catch(() => {});
  }, [coverKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRetry = async (song: Song) => {
    try {
      const updated = await retrySong(song.id);
      if (mountedRef.current) setSongs((prev) => prev.map((s) => (s.id === song.id ? { ...s, ...updated } : s)));
    } catch (e) {
      if (mountedRef.current) setError(await songErrorMessage(e));
    }
  };

  // ── Delete with undo ──
  const commitDelete = useCallback((song: Song) => {
    forgetSongInPlaylists(song.id);
    deleteSongs([song.id]).catch((e) => {
      console.error('[music] delete failed:', e);
      if (mountedRef.current) { setSongs((prev) => [song, ...prev]); setError('削除できませんでした。'); }
    });
  }, []);
  const handleDelete = (song: Song) => {
    setArmed(null);
    if (pendingDelete) commitDelete(pendingDelete);
    if (deleteTimer.current) clearTimeout(deleteTimer.current);
    setSongs((prev) => prev.filter((s) => s.id !== song.id));
    setPendingDelete(song);
    deleteTimer.current = window.setTimeout(() => { commitDelete(song); setPendingDelete(null); }, UNDO_MS);
  };
  const undoDelete = () => {
    if (!pendingDelete) return;
    if (deleteTimer.current) clearTimeout(deleteTimer.current);
    const song = pendingDelete;
    setSongs((prev) => [...prev, song].sort((a, b) => b.created_at.localeCompare(a.created_at)));
    setPendingDelete(null);
  };
  // Leaving the page doesn't cancel a delete: commit it now.
  const pendingRef = useRef<Song | null>(null);
  pendingRef.current = pendingDelete;
  useEffect(() => () => {
    if (deleteTimer.current) clearTimeout(deleteTimer.current);
    if (pendingRef.current) deleteSongs([pendingRef.current.id]).catch(() => {});
  }, []);

  // ── List delete with undo ──
  const handleDeleteList = (list: Playlist) => {
    setArmedList(null);
    if (pendingListDelete) deletePlaylist(pendingListDelete.id).catch(() => {});
    if (listDeleteTimer.current) clearTimeout(listDeleteTimer.current);
    setPendingListDelete(list);
    listDeleteTimer.current = window.setTimeout(() => {
      deletePlaylist(list.id).catch(() => { if (mountedRef.current) setError('削除できませんでした。'); });
      setPendingListDelete(null);
    }, UNDO_MS);
  };
  const undoListDelete = () => {
    if (listDeleteTimer.current) clearTimeout(listDeleteTimer.current);
    setPendingListDelete(null);
  };
  const pendingListRef = useRef<Playlist | null>(null);
  pendingListRef.current = pendingListDelete;
  useEffect(() => () => {
    if (listDeleteTimer.current) clearTimeout(listDeleteTimer.current);
    if (pendingListRef.current) deletePlaylist(pendingListRef.current.id).catch(() => {});
  }, []);

  const startPress = (song: Song) => {
    longPressed.current = false;
    pressTimer.current = window.setTimeout(() => { longPressed.current = true; setArmed(song.id); }, LONG_PRESS_MS);
  };
  const endPress = () => { if (pressTimer.current) clearTimeout(pressTimer.current); };

  const open = (song: Song) => {
    if (longPressed.current) return;
    if (armed) { setArmed(null); return; }
    if (song.status === 'ready') onOpenSong(song, songs.filter((s) => s.status === 'ready'));
  };

  const listPress = useRef<number | null>(null);
  const listLongPressed = useRef(false);
  const startListPress = (id: string) => {
    listLongPressed.current = false;
    listPress.current = window.setTimeout(() => { listLongPressed.current = true; setArmedList(id); }, LONG_PRESS_MS);
  };
  const endListPress = () => { if (listPress.current) clearTimeout(listPress.current); };

  const readySongs = songs.filter((s) => s.status === 'ready');
  const allList: Playlist = { id: ALL_LIST_ID, name: 'すべての曲', created_at: '', touched_at: '', song_ids: readySongs.map((s) => s.id) };
  const openList = listId === ALL_LIST_ID ? allList : lists.find((l) => l.id === listId && l.id !== pendingListDelete?.id) ?? null;
  // A list that's gone (deleted elsewhere) drops back to the grid.
  useEffect(() => { if (listId && listsLoaded && !openList) onListChange(null); }, [listId, listsLoaded, openList, onListChange]);
  useEffect(() => { if (!listId) setPicking(false); }, [listId]);

  if (openList && picking) {
    return <SongPicker list={openList} songs={songs} covers={covers} onDone={() => { setPicking(false); window.scrollTo(0, 0); }} />;
  }
  if (openList) {
    return (
      <PlaylistPage
        key={openList.id}
        list={openList}
        fixed={openList.id === ALL_LIST_ID}
        songs={songs}
        covers={covers}
        onBack={() => onListChange(null)}
        onPlay={(song, queue) => onOpenSong(song, queue, openList.name)}
        onPick={() => { setPicking(true); window.scrollTo(0, 0); }}
      />
    );
  }

  const byId = new Map(songs.map((s) => [s.id, s]));
  const shelf = [allList, ...lists.filter((l) => l.id !== pendingListDelete?.id)];
  const showShelf = readySongs.length > 0;

  return (
    <>
      <PageHeading id="music" settingsMark={false} titleSwitch={titleSwitch} actions={<AddButton onClick={() => setSheetOpen(true)} label="曲を作る" />} />

      {error && (
        <div role="alert" onClick={() => setError(null)} style={{ marginBottom: '1rem', padding: '0.75rem 1.1rem', borderRadius: '14px', backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-light)', color: 'var(--text-main)', fontSize: '0.85rem', lineHeight: 1.4, cursor: 'pointer', textAlign: 'center' }}>
          {error}
        </div>
      )}

      {isLoading && songs.length === 0 ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.6rem 0.9rem', marginTop: '0.6rem' }}>
          {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton-shimmer" style={{ aspectRatio: '1', borderRadius: '16px' }} />)}
        </div>
      ) : songs.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '4rem 1rem', color: 'var(--text-muted)' }}>
          <h2 className="serif" style={{ fontSize: '1.4rem', marginBottom: '0.8rem', color: 'var(--text-main)' }}>まだ曲がありません</h2>
          <p style={{ fontSize: '0.85rem', lineHeight: 1.7 }}>1日おきに新しい曲が届きます</p>
        </div>
      ) : (
        <>
        {showShelf && (
          <div style={{ marginTop: '0.6rem' }}>
            <Kicker>リスト</Kicker>
            <div className="no-scrollbar" style={{ display: 'flex', alignItems: 'flex-start', gap: '0.9rem', overflowX: 'auto', margin: '0 -1.25rem', padding: '0.2rem 1.25rem 0.6rem', scrollbarWidth: 'none' }}>
              {shelf.map((l) => {
                const ids = l.song_ids.filter((id) => byId.get(id)?.status === 'ready');
                return (
                  <div
                    key={l.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => { if (listLongPressed.current) return; if (armedList) { setArmedList(null); return; } onListChange(l.id); window.scrollTo(0, 0); }}
                    onPointerDown={() => { if (l.id !== ALL_LIST_ID) startListPress(l.id); }}
                    onPointerUp={endListPress}
                    onPointerLeave={endListPress}
                    onContextMenu={(e) => e.preventDefault()}
                    style={{ flex: 'none', width: 116, cursor: 'pointer', WebkitTouchCallout: 'none', userSelect: 'none' }}
                  >
                    <div style={{ position: 'relative' }}>
                      <Collage urls={ids.slice(0, 4).map((id) => coverOf(byId.get(id), covers))} size={116} />
                      {armedList === l.id && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDeleteList(l); }}
                          className="serif"
                          style={{ position: 'absolute', inset: 0, borderRadius: 16, border: 'none', backgroundColor: 'rgba(253, 226, 218, 0.94)', color: 'var(--text-main)', fontSize: '1rem', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem' }}
                        >
                          <Trash2 size={16} strokeWidth={1.5} /> 削除
                        </button>
                      )}
                    </div>
                    <div className="serif" style={{ fontSize: '0.95rem', lineHeight: 1.35, marginTop: '0.5rem', color: 'var(--text-main)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.name}</div>
                    <div style={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.06em', color: 'var(--text-muted)' }}>{ids.length}曲</div>
                  </div>
                );
              })}
              <button
                onClick={() => setNewListOpen(true)}
                style={{ flex: 'none', display: 'block', width: 116, border: 'none', background: 'none', padding: 0, margin: 0, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}
              >
                <div style={{ width: 116, height: 116, borderRadius: 16, backgroundColor: 'var(--bg-card)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
                  <Plus size={22} strokeWidth={1.25} />
                </div>
                <div className="serif" style={{ fontSize: '0.95rem', lineHeight: 1.35, marginTop: '0.5rem', color: 'var(--text-muted)' }}>新しいリスト</div>
              </button>
            </div>
            <Kicker style={{ marginTop: '2rem' }}>曲</Kicker>
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.6rem 0.9rem', marginTop: showShelf ? 0 : '0.6rem', paddingBottom: '6rem' }}>
          {songs.map((song) => {
            const cover = song.cover_path ? covers[song.cover_path] : undefined;
            const working = isSongInFlight(song);
            return (
              <div
                key={song.id}
                role={song.status === 'ready' ? 'button' : undefined}
                tabIndex={song.status === 'ready' ? 0 : undefined}
                onClick={() => open(song)}
                onPointerDown={() => startPress(song)}
                onPointerUp={endPress}
                onPointerLeave={endPress}
                onContextMenu={(e) => e.preventDefault()}
                style={{ cursor: song.status === 'ready' ? 'pointer' : 'default', WebkitTouchCallout: 'none', userSelect: 'none' }}
              >
                <div style={{ aspectRatio: '1', borderRadius: '16px', backgroundColor: 'var(--bg-card)', boxShadow: '0 4px 25px rgba(0,0,0,0.06)', position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {cover && <img src={cover} alt="" draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />}
                  {working && (
                    <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem', fontSize: '0.7rem', fontWeight: 800, color: 'var(--text-muted)' }}>
                      <span className="lucide-spin" style={{ width: 14, height: 14, border: '1.5px solid rgba(74, 93, 35, 0.2)', borderTopColor: '#4a5d23', borderRadius: '50%' }} />
                      {song.status === 'writing' ? '作詞中…' : '作曲中…'}
                    </span>
                  )}
                  {song.status === 'failed' && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleRetry(song); }}
                      style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.7rem', fontWeight: 800, color: '#a8553f', background: 'none', border: 'none', cursor: 'pointer' }}
                    >
                      <RotateCw size={14} strokeWidth={2.5} /> 再試行
                    </button>
                  )}
                  {armed === song.id && (
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
                      {song.status === 'ready' && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setArmed(null); setAddSong(song); }}
                          className="serif"
                          style={{ ...splitBtn, backgroundColor: 'rgba(255, 255, 255, 0.92)' }}
                        >
                          <ListPlus size={16} strokeWidth={1.5} /> リストに追加
                        </button>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(song); }}
                        className="serif"
                        style={{ ...splitBtn, backgroundColor: 'rgba(253, 226, 218, 0.94)' }}
                      >
                        <Trash2 size={16} strokeWidth={1.5} /> 削除
                      </button>
                    </div>
                  )}
                </div>
                <div className="serif" style={{ fontSize: '1.05rem', lineHeight: 1.45, marginTop: '0.6rem', color: song.title ? 'var(--text-main)' : 'var(--text-muted)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {song.title || '曲を準備中'}
                </div>
                <div style={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.06em', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                  {styleLabel(song.style_key)}
                </div>
              </div>
            );
          })}
        </div>
        </>
      )}

      {pendingDelete && (
        <div style={{ position: 'fixed', top: 'calc(1rem + env(safe-area-inset-top))', left: '50%', transform: 'translateX(-50%)', zIndex: 60, display: 'flex', alignItems: 'center', gap: '1.1rem', backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-light)', borderRadius: '14px', boxShadow: '0 6px 30px rgba(0,0,0,0.12)', padding: '0.7rem 1.1rem', fontSize: '0.85rem', whiteSpace: 'nowrap' }}>
          削除しました
          <button onClick={undoDelete} className="serif" style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-main)', padding: 0 }}>元に戻す</button>
        </div>
      )}

      {pendingListDelete && !pendingDelete && (
        <MusicToast onDismiss={() => {}} action="元に戻す" onAction={undoListDelete}>「{pendingListDelete.name}」を削除しました</MusicToast>
      )}

      <SongSheet open={sheetOpen} onClose={() => setSheetOpen(false)} onCreated={(s) => setSongs((prev) => [s, ...prev])} />
      <AddToListSheet song={addSong} cover={coverOf(addSong ?? undefined, covers)} onClose={() => setAddSong(null)} />
      <NewListSheet open={newListOpen} onClose={() => setNewListOpen(false)} onCreated={(l) => { onListChange(l.id); setPicking(true); window.scrollTo(0, 0); }} />
    </>
  );
}

const splitBtn: React.CSSProperties = {
  flex: 1, border: 'none', cursor: 'pointer', color: 'var(--text-main)', fontSize: '1rem',
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem',
};
