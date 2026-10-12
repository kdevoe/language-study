import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Play } from 'lucide-react';
import { Song, coverUrls } from '../services/songs';
import { PLAYLIST_NAME_MAX } from '../services/playlists';

// Small pieces shared by 音楽's lists (mockup docs/mockups/music-lists.html):
// cover URLs, the 2×2 list collage, the top toast and the list-name field.

/** Signed cover URLs for these songs, keyed by cover_path. */
export function useCoverMap(songs: Pick<Song, 'cover_path'>[]): Record<string, string> {
  const [covers, setCovers] = useState<Record<string, string>>({});
  const key = songs.map((s) => s.cover_path ?? '').join('|');
  useEffect(() => {
    let alive = true;
    const paths = songs.map((s) => s.cover_path).filter((p): p is string => !!p);
    if (paths.length) coverUrls(paths).then((m) => { if (alive) setCovers((prev) => ({ ...prev, ...m })); }).catch(() => {});
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return covers;
}

export const coverOf = (song: Pick<Song, 'cover_path'> | undefined, covers: Record<string, string>) =>
  song?.cover_path ? covers[song.cover_path] : undefined;

/** A list's cover: its first four songs' covers in a 2×2 grid (repeating when fewer). */
export function Collage({ urls, size, radius = 16, shadow = '0 4px 25px rgba(0,0,0,0.06)' }: { urls: (string | undefined)[]; size: number | string; radius?: number; shadow?: string }) {
  const cells = urls.length ? [0, 1, 2, 3].map((k) => urls[k % urls.length]) : [];
  return (
    <div style={{ width: size, height: size, borderRadius: radius, overflow: 'hidden', backgroundColor: 'var(--bg-card)', boxShadow: shadow, display: 'grid', gridTemplateColumns: '1fr 1fr', flex: 'none' }}>
      {cells.map((u, k) => (
        <div key={k} style={{ backgroundColor: 'var(--bg-card)', backgroundImage: u ? `url("${u}")` : undefined, backgroundSize: 'cover', backgroundPosition: 'center' }} />
      ))}
    </div>
  );
}

/** Section kicker on 音楽 (design-system §6.13: 0.82rem sans 600, muted). */
export function Kicker({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.8rem', ...style }}>{children}</div>;
}

/** The app's top toast (§6.6), with an optional serif action such as 元に戻す. */
export function MusicToast({ children, action, onAction, onDismiss, top = 'calc(1rem + env(safe-area-inset-top))' }: {
  children: ReactNode;
  action?: string;
  onAction?: () => void;
  onDismiss: () => void;
  top?: string;
}) {
  return (
    <div
      role="status"
      onClick={onDismiss}
      style={{ position: 'fixed', top, left: '50%', transform: 'translateX(-50%)', zIndex: 60, display: 'flex', alignItems: 'center', gap: '1.1rem', backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-light)', borderRadius: '14px', boxShadow: '0 6px 30px rgba(0,0,0,0.12)', padding: '0.7rem 1.1rem', fontSize: '0.85rem', whiteSpace: 'nowrap', color: 'var(--text-main)', cursor: 'pointer', maxWidth: 'calc(100vw - 2rem)' }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{children}</span>
      {action && (
        <button onClick={(e) => { e.stopPropagation(); onAction?.(); }} className="serif" style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-main)', padding: 0 }}>
          {action}
        </button>
      )}
    </div>
  );
}

/** A toast that hides itself after ~5s. */
export function useToast<T>() {
  const [toast, setToast] = useState<T | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const show = (t: T) => {
    if (timer.current) clearTimeout(timer.current);
    setToast(t);
    timer.current = window.setTimeout(() => setToast(null), 5000);
  };
  const hide = () => { if (timer.current) clearTimeout(timer.current); setToast(null); };
  return { toast, show, hide };
}

/** The list-name hero input (§6.4): no box, a hairline that darkens on focus. */
export function NameField({ value, onChange, onSubmit, suggestions = [] }: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  suggestions?: string[];
}) {
  const [focused, setFocused] = useState(false);
  return (
    <div>
      <input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(); }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder="リストの名前"
        maxLength={PLAYLIST_NAME_MAX}
        enterKeyHint="done"
        className="serif"
        style={{ width: '100%', border: 'none', outline: 'none', background: 'transparent', borderBottom: `1px solid ${focused ? 'var(--text-muted)' : 'var(--border-light)'}`, padding: '0.35rem 0.1rem 0.45rem', fontSize: '1.35rem', color: 'var(--text-main)', borderRadius: 0, transition: 'border-color 0.4s cubic-bezier(0.4, 0, 0.2, 1)' }}
      />
      {suggestions.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem 1.1rem', marginTop: '0.8rem' }}>
          {suggestions.map((s) => (
            <button key={s} onClick={() => onChange(s)} className="serif" style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontSize: '0.92rem', color: 'var(--text-muted)' }}>{s}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Bottom-sheet chrome (§6.2): backdrop + sheet, the caller supplies the contents. */
export const sheetBackdrop: CSSProperties = { position: 'fixed', inset: 0, backgroundColor: 'rgba(45,45,45,0.35)', zIndex: 40 };
export const sheetPanel: CSSProperties = { position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 50, backgroundColor: 'var(--bg-color)', borderRadius: '28px 28px 0 0', padding: '1.5rem 1.5rem calc(2.2rem + env(safe-area-inset-bottom))', boxShadow: '0 -10px 40px rgba(0,0,0,0.15)', maxWidth: '600px', margin: '0 auto' };
export const sheetSpring = { type: 'spring' as const, stiffness: 400, damping: 40 };
export function Grabber() {
  return <div style={{ width: '36px', height: '4px', borderRadius: '2px', backgroundColor: 'var(--border-light)', margin: '0 auto 1.2rem' }} />;
}

export const fmtDuration = (ms: number | null | undefined) => {
  const v = Math.max(0, Math.round((ms ?? 0) / 1000));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
};

/** The lifted white play circle (Home's podcast row, a list's 再生): a filled
 *  triangle on --bg-pure with the thumb shadow (design-system §2). */
export function PlayCircle({ size = 44, onClick, label }: { size?: number; onClick?: () => void; label: string }) {
  const style: CSSProperties = { width: size, height: size, borderRadius: '50%', backgroundColor: 'var(--bg-pure)', boxShadow: '0 2px 8px rgba(0,0,0,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', border: 'none', padding: 0, cursor: 'pointer' };
  const icon = <Play size={Math.round(size * 0.38)} strokeWidth={0} fill="var(--text-main)" style={{ marginLeft: Math.round(size / 18) }} aria-hidden />;
  return onClick
    ? <button onClick={(e) => { e.stopPropagation(); onClick(); }} aria-label={label} style={style}>{icon}</button>
    : <span aria-hidden style={style}>{icon}</span>;
}
