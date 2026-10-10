import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, Plus, RotateCw } from 'lucide-react';
import { SliderToggle } from './SliderToggle';
import { PodcastSheet } from './PodcastSheet';
import {
  PodcastEpisode,
  createEpisode,
  episodeErrorMessage,
  fetchEpisodes,
  isInFlight,
  localDateKey,
  retryEpisode,
} from '../services/podcasts';
import { castMember } from '../data/podcastCast';

const DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true';

// LISTEN tab (docs/podcast-design.md §6.1, mockup docs/mockups/listen.html): one
// flat card list under the filter slider — the Library's card language — plus
// a + button opening PodcastSheet (topic, pasted text or a URL). Today's daily
// digest is requested automatically the first time the tab opens each day.

const POLL_MS = 5000;
// Remembers the day an automatic digest was last requested, so a feed with no
// stories (or a failure) doesn't re-request on every visit.
const DIGEST_ATTEMPT_KEY = 'yugen-digest-attempt';

type Filter = 'all' | 'new' | 'partial' | 'done';

const FILTER_OPTIONS = [
  { value: 'all', label: 'すべて' },
  { value: 'new', label: '未再生' },
  { value: 'partial', label: '途中' },
  { value: 'done', label: '完了' },
] as const;

interface Props {
  onOpenEpisode: (episode: PodcastEpisode) => void;
}

/** Quiet relative date for the card sub-line (same wording as the Library). */
function relativeDate(iso: string): string {
  const then = new Date(iso);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(then)) / 86_400_000);
  if (days <= 0) return '今日';
  if (days === 1) return '昨日';
  if (days < 7) return `${days}日前`;
  return then.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' });
}

const durationLabel = (ep: PodcastEpisode) => {
  if (!ep.duration_ms) return `約${ep.minutes}分`;
  const s = Math.round(ep.duration_ms / 1000);
  return `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒`;
};

const progressOf = (ep: PodcastEpisode) =>
  ep.listened_at ? 1 : ep.duration_ms ? Math.min(1, ep.listen_position_ms / ep.duration_ms) : 0;

function stateOf(ep: PodcastEpisode): Exclude<Filter, 'all'> {
  if (ep.listened_at) return 'done';
  if (ep.status === 'ready' && ep.listen_position_ms > 0) return 'partial';
  return 'new';
}

function sourceTag(ep: PodcastEpisode): string {
  switch (ep.source_kind) {
    case 'digest': {
      const m = ep.source_ref?.match(/^\d{4}-(\d{2})-(\d{2})$/);
      return m ? `DAILY DIGEST · ${Number(m[1])}月${Number(m[2])}日` : 'DAILY DIGEST';
    }
    case 'article': return '記事から';
    case 'topic': return `トピック · ${ep.source_ref ?? ''}`;
    case 'text': return 'テキスト';
    case 'url': return 'URL';
  }
}

export function Listen({ onOpenEpisode }: Props) {
  const [episodes, setEpisodes] = useState<PodcastEpisode[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const digestRequestedRef = useRef(false);
  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error]);

  const load = useCallback(async () => {
    try {
      const list = await fetchEpisodes();
      if (mountedRef.current) setEpisodes(list);
    } catch (e) {
      console.error('[listen] fetchEpisodes failed:', e);
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Poll while anything is being made; the edge function advances the rows.
  const anyInFlight = episodes.some(isInFlight);
  useEffect(() => {
    if (!anyInFlight) return;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [anyInFlight, load]);

  // Morning radio: request today's digest once per day on first visit.
  useEffect(() => {
    if (DEV_MODE || isLoading || digestRequestedRef.current) return;
    digestRequestedRef.current = true;
    const today = localDateKey();
    if (episodes.some((e) => e.source_kind === 'digest' && e.source_ref === today)) return;
    let attempted: string | null = null;
    try { attempted = localStorage.getItem(DIGEST_ATTEMPT_KEY); } catch { /* storage unavailable */ }
    if (attempted === today) return;
    try { localStorage.setItem(DIGEST_ATTEMPT_KEY, today); } catch { /* storage unavailable */ }
    createEpisode({ kind: 'digest', date: today })
      .then((ep) => { if (mountedRef.current) setEpisodes((prev) => [ep, ...prev.filter((p) => p.id !== ep.id)]); })
      .catch((e) => console.info('[listen] daily digest not created:', e?.message ?? e));
  }, [isLoading, episodes]);

  const handleRetry = async (ep: PodcastEpisode) => {
    try {
      const updated = await retryEpisode(ep.id);
      if (mountedRef.current) setEpisodes((prev) => prev.map((p) => (p.id === ep.id ? { ...p, ...updated } : p)));
    } catch (e) {
      if (mountedRef.current) setError(await episodeErrorMessage(e));
    }
  };

  const visible = episodes.filter((e) => filter === 'all' || stateOf(e) === filter);

  const spinner = (size = 12) => (
    <div
      className="lucide-spin"
      style={{ width: size, height: size, border: '1.5px solid rgba(74, 93, 35, 0.2)', borderTopColor: '#4a5d23', borderRadius: '50%' }}
    />
  );

  const statusCorner = (ep: PodcastEpisode) => {
    if (isInFlight(ep)) {
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.7rem', fontWeight: 800, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          {spinner()} {ep.status === 'scripting' ? '台本を作成中…' : '音声を収録中…'}
        </span>
      );
    }
    if (ep.status === 'failed') {
      return (
        <button
          onClick={(e) => { e.stopPropagation(); handleRetry(ep); }}
          style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.7rem', fontWeight: 800, color: '#a8553f', background: 'none', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}
        >
          <RotateCw size={14} strokeWidth={2.5} /> 再試行
        </button>
      );
    }
    const state = stateOf(ep);
    if (state === 'done') {
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.7rem', fontWeight: 800, color: 'var(--text-muted)' }}>
          <CheckCircle2 size={16} strokeWidth={2.5} />
          <span className="serif" style={{ fontSize: '0.8rem' }}>完了</span>
        </span>
      );
    }
    if (state === 'partial') {
      return <span style={{ fontSize: '0.7rem', fontWeight: 800, color: 'var(--text-muted)' }}>途中 · {Math.round(progressOf(ep) * 100)}%</span>;
    }
    return (
      <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.7rem', fontWeight: 800, color: '#4a5d23', letterSpacing: '0.05em' }}>
        <CheckCircle2 size={16} strokeWidth={2.5} /> READY
      </span>
    );
  };

  return (
    <div style={{ paddingBottom: '6rem' }}>
      {error && (
        <div
          role="alert"
          onClick={() => setError(null)}
          style={{ marginBottom: '1rem', padding: '0.75rem 1.1rem', borderRadius: '14px', backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-light)', color: 'var(--text-main)', fontSize: '0.85rem', lineHeight: 1.4, cursor: 'pointer', textAlign: 'center' }}
        >
          {error}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: '1.2rem' }}>
        <div>
          <div style={{ fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.2em', color: 'var(--text-muted)' }}>LISTEN</div>
          <h1 className="serif" translate="no" style={{ fontSize: '2rem', fontWeight: 500, lineHeight: 1.2, color: 'var(--text-main)' }}>聴く</h1>
        </div>
        <button
          onClick={() => setSheetOpen(true)}
          aria-label="エピソードを作る"
          style={{ width: '48px', height: '48px', borderRadius: '50%', border: 'none', cursor: 'pointer', backgroundColor: 'var(--text-main)', color: 'var(--bg-pure)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 6px 18px rgba(0,0,0,0.15)' }}
        >
          <Plus size={22} strokeWidth={1.5} />
        </button>
      </div>

      <SliderToggle options={FILTER_OPTIONS} value={filter} onChange={setFilter} ariaLabel="絞り込み" style={{ marginBottom: '1.4rem' }} />

      {isLoading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {[1, 2].map((i) => (
            <div key={i} className="skeleton-shimmer" style={{ width: '100%', height: '140px', borderRadius: '24px' }} />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '4rem 1rem', color: 'var(--text-muted)' }}>
          <h2 className="serif" style={{ fontSize: '1.4rem', marginBottom: '0.8rem', color: 'var(--text-main)' }}>
            {filter === 'all' ? 'まだエピソードがありません' : 'ここにはまだありません'}
          </h2>
          {filter === 'all' && (
            <p style={{ fontSize: '0.85rem', lineHeight: 1.7 }}>毎朝ダイジェストが届きます</p>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <AnimatePresence mode="popLayout">
            {visible.map((ep) => {
              const host = castMember(ep.cast_ids?.host);
              const guest = castMember(ep.cast_ids?.guest);
              const dialect = host.dialect ?? guest.dialect;
              const playable = ep.status === 'ready';
              const progress = progressOf(ep);
              const isDigest = ep.source_kind === 'digest';
              return (
                <motion.div
                  key={ep.id}
                  layout="position"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
                  onClick={() => playable && onOpenEpisode(ep)}
                  whileTap={playable ? { scale: 0.98 } : undefined}
                  style={{
                    backgroundColor: isDigest ? 'var(--bg-pure)' : 'var(--bg-card)',
                    borderRadius: '24px',
                    padding: '1.4rem 1.5rem',
                    border: playable && stateOf(ep) !== 'done' ? '1px solid rgba(74, 93, 35, 0.15)' : '1px solid var(--border-light)',
                    boxShadow: '0 4px 25px rgba(0,0,0,0.03)',
                    cursor: playable ? 'pointer' : 'default',
                    position: 'relative',
                    overflow: 'hidden',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.9rem', gap: '0.6rem' }}>
                    <span style={{
                      fontSize: '0.62rem',
                      fontWeight: 800,
                      letterSpacing: '0.15em',
                      backgroundColor: isDigest ? 'rgba(74, 93, 35, 0.08)' : 'var(--bg-pure)',
                      color: isDigest ? '#4a5d23' : 'var(--text-muted)',
                      padding: '0.3rem 0.7rem',
                      borderRadius: '8px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      maxWidth: '60%',
                    }}>
                      {sourceTag(ep)}
                    </span>
                    {statusCorner(ep)}
                  </div>

                  <h3 className="serif" style={{ fontSize: '1.25rem', lineHeight: 1.5, color: ep.title ? 'var(--text-main)' : 'var(--text-muted)', marginBottom: '0.8rem', maxWidth: '95%' }}>
                    {ep.title || (isDigest ? '今日のニュースから' : 'エピソードを準備中')}
                  </h3>

                  <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', fontWeight: 500 }}>
                    <span style={{ color: 'var(--text-main)' }}>{host.name} × {guest.name}</span>
                    {dialect && <><span style={{ margin: '0 0.35rem', opacity: 0.5 }}>·</span>{dialect}</>}
                    <span style={{ margin: '0 0.35rem', opacity: 0.5 }}>·</span>
                    {durationLabel(ep)}
                    <span style={{ margin: '0 0.35rem', opacity: 0.5 }}>·</span>
                    {relativeDate(ep.created_at)}
                  </div>

                  {progress > 0 && (
                    <div style={{ position: 'absolute', bottom: 0, left: 0, height: '3px', width: `${Math.round(progress * 100)}%`, backgroundColor: '#4a5d23', opacity: 0.4 }} />
                  )}
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}

      <PodcastSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onCreated={(ep) => setEpisodes((prev) => [ep, ...prev])}
      />
    </div>
  );
}
