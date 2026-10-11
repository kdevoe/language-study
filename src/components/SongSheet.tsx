import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { SliderToggle } from './SliderToggle';
import { CreateButton } from './PodcastSheet';
import { useScrollLock } from '../hooks/useScrollLock';
import { Song, createSong, songErrorMessage } from '../services/songs';
import { SONG_STYLES } from '../data/songStyles';

// New-song bottom sheet (mockup docs/mockups/music.html, phones 2–3), the same
// three groups as PodcastSheet (design-system §6.2):
//   what     — スタイル | 自分で, then the style picks or a description box
//   optional — "＋ テーマ", swapped for its field in the same slot
//   go       — length slider + 作る
// The pane has one fixed height so switching never moves the sheet.

const REQUEST_MIN_CHARS = 8;
const REQUEST_MAX_CHARS = 600;
const THEME_MAX_CHARS = 80;
const PANE_HEIGHT = '124px';

const MODE_OPTIONS = [
  { value: 'preset', label: 'スタイル' },
  { value: 'custom', label: '自分で' },
] as const;

const LENGTH_OPTIONS = [1, 2, 3].map((m) => ({ value: m, label: `${m}分` }));

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (song: Song) => void;
}

export function SongSheet({ open, onClose, onCreated }: Props) {
  const [mode, setMode] = useState<'preset' | 'custom'>('preset');
  const [style, setStyle] = useState<string | null>(null);
  const [request, setRequest] = useState('');
  const [theme, setTheme] = useState('');
  const [themeOpen, setThemeOpen] = useState(false);
  const [minutes, setMinutes] = useState(2);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const themeRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  useScrollLock(open);
  useEffect(() => { if (themeOpen) themeRef.current?.focus(); }, [themeOpen]);
  useEffect(() => { if (open) setError(null); }, [open]);

  const trimmedRequest = request.trim();
  const hasStyle = mode === 'preset' ? !!style : trimmedRequest.length >= REQUEST_MIN_CHARS;
  const ready = hasStyle && !isCreating;

  const handleCreate = async () => {
    if (!ready) return;
    setIsCreating(true);
    setError(null);
    try {
      const song = await createSong({
        style: mode === 'preset' ? style! : 'custom',
        request: mode === 'custom' ? trimmedRequest : undefined,
        theme: theme.trim() || undefined,
        minutes,
      });
      if (!mountedRef.current) return;
      onCreated(song);
      setRequest('');
      setTheme('');
      setThemeOpen(false);
      onClose();
    } catch (e) {
      console.error('[song-sheet] create failed:', e);
      if (mountedRef.current) setError(await songErrorMessage(e));
    } finally {
      if (mountedRef.current) setIsCreating(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="song-sheet-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(45,45,45,0.35)', zIndex: 40 }}
          />
          <motion.div
            key="song-sheet"
            role="dialog"
            aria-label="新しい曲"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 400, damping: 40 }}
            style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 50, backgroundColor: 'var(--bg-color)', borderRadius: '28px 28px 0 0', padding: '1.5rem 1.5rem calc(2.2rem + env(safe-area-inset-bottom))', boxShadow: '0 -10px 40px rgba(0,0,0,0.15)', maxWidth: '600px', margin: '0 auto' }}
          >
            <div style={{ width: '36px', height: '4px', borderRadius: '2px', backgroundColor: 'var(--border-light)', margin: '0 auto 1.2rem' }} />

            {/* ── what ── */}
            <h2 className="serif" style={{ fontSize: '1.3rem', fontWeight: 600, marginBottom: '1rem', color: 'var(--text-main)' }}>新しい曲</h2>
            <SliderToggle options={MODE_OPTIONS} value={mode} onChange={setMode} ariaLabel="スタイルの選び方" />
            <div style={{ marginTop: '1.3rem', height: PANE_HEIGHT }}>
              {mode === 'preset' ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem 0.4rem' }}>
                  {SONG_STYLES.map((s) => {
                    const on = style === s.id;
                    return (
                      <button
                        key={s.id}
                        onClick={() => setStyle(s.id)}
                        aria-pressed={on}
                        className="serif"
                        style={{
                          border: 'none', cursor: 'pointer', fontSize: '0.92rem', padding: '0.3rem 0.75rem', borderRadius: '100px',
                          backgroundColor: on ? 'var(--bg-pure)' : 'transparent',
                          color: on ? 'var(--text-main)' : 'var(--text-muted)',
                          fontWeight: on ? 600 : 400,
                          boxShadow: on ? '0 2px 8px rgba(0,0,0,0.1)' : 'none',
                          transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                        }}
                      >
                        {s.label}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <textarea
                  value={request}
                  onChange={(e) => setRequest(e.target.value)}
                  placeholder="どんな曲？　雰囲気、テンポ、楽器、声…"
                  maxLength={REQUEST_MAX_CHARS}
                  style={{ width: '100%', height: '100%', border: 'none', outline: 'none', resize: 'none', backgroundColor: 'var(--bg-card)', borderRadius: '16px', padding: '0.8rem 1rem', fontFamily: 'var(--font-sans)', fontSize: '0.85rem', lineHeight: 1.6, color: 'var(--text-main)' }}
                />
              )}
            </div>

            {/* ── optional theme: link and field share one reserved slot ── */}
            <div style={{ height: '2.4rem', marginTop: '0.8rem', display: 'flex', alignItems: 'center' }}>
              {themeOpen ? (
                <input
                  ref={themeRef}
                  value={theme}
                  onChange={(e) => setTheme(e.target.value)}
                  placeholder="例：夏の終わりの帰り道"
                  maxLength={THEME_MAX_CHARS}
                  className="hero-input"
                  style={{ width: '100%', border: 'none', outline: 'none', background: 'transparent', borderBottom: '1px solid var(--border-light)', padding: '0.4rem 0.1rem', fontFamily: 'var(--font-sans)', fontSize: '0.85rem', color: 'var(--text-main)' }}
                />
              ) : (
                <button
                  onClick={() => setThemeOpen(true)}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: '0.8rem', letterSpacing: '0.04em', color: 'var(--text-muted)' }}
                >
                  ＋ テーマ
                </button>
              )}
            </div>

            {error && (
              <div role="alert" style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.6rem', lineHeight: 1.5 }}>{error}</div>
            )}

            {/* ── go ── */}
            <div style={{ marginTop: error ? '1rem' : '1.6rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
              <SliderToggle options={LENGTH_OPTIONS} value={minutes} onChange={setMinutes} width="200px" ariaLabel="長さ" />
              <CreateButton ready={ready} busy={isCreating} onClick={handleCreate} />
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
