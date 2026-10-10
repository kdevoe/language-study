import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, RotateCw } from 'lucide-react';
import { PodcastSheet } from './PodcastSheet';
import { AddButton, ArchiveList } from './ArchiveList';
import type { ArchiveCard } from './ArchiveList';
import {
  PodcastEpisode,
  createEpisode,
  deleteEpisodes,
  episodeErrorMessage,
  fetchEpisodeSearchText,
  fetchEpisodes,
  isInFlight,
  localDateKey,
  retryEpisode,
} from '../services/podcasts';
import { castMember } from '../data/podcastCast';

const DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true';

// LISTEN tab (docs/podcast-design.md §6.1): episodes in ArchiveList — grouped
// by month, searchable, swipe to delete, long-press to select (mockup
// docs/mockups/archive-organize.html) — plus a + button opening PodcastSheet.
// Today's daily digest is requested automatically on the first visit each day.

const POLL_MS = 5000;
// Remembers the day an automatic digest was last requested, so a feed with no
// stories (or a failure) doesn't re-request on every visit.
const DIGEST_ATTEMPT_KEY = 'yugen-digest-attempt';

type ListenState = 'new' | 'partial' | 'done';

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

function stateOf(ep: PodcastEpisode): ListenState {
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

  const handleRetry = useCallback(async (ep: PodcastEpisode) => {
    try {
      const updated = await retryEpisode(ep.id);
      if (mountedRef.current) setEpisodes((prev) => prev.map((p) => (p.id === ep.id ? { ...p, ...updated } : p)));
    } catch (e) {
      if (mountedRef.current) setError(await episodeErrorMessage(e));
    }
  }, []);

  const handleDelete = useCallback(async (ids: string[]) => {
    await deleteEpisodes(ids);
    if (mountedRef.current) setEpisodes((prev) => prev.filter((p) => !ids.includes(p.id)));
  }, []);

  const card = useCallback((ep: PodcastEpisode): ArchiveCard => {
    const host = castMember(ep.cast_ids?.host);
    const guest = castMember(ep.cast_ids?.guest);
    const dialect = host.dialect ?? guest.dialect;
    const isDigest = ep.source_kind === 'digest';
    const dot = <span style={{ margin: '0 0.35rem', opacity: 0.5 }}>·</span>;
    return {
      tag: sourceTag(ep),
      status: statusCorner(ep, handleRetry),
      title: ep.title || (isDigest ? '今日のニュースから' : 'エピソードを準備中'),
      titleMuted: !ep.title,
      meta: (
        <>
          <span style={{ color: 'var(--text-main)' }}>{host.name} × {guest.name}</span>
          {dialect && <>{dot}{dialect}</>}
          {dot}{durationLabel(ep)}
          {dot}{relativeDate(ep.created_at)}
        </>
      ),
      progress: progressOf(ep),
      featured: isDigest,
      openable: ep.status === 'ready',
    };
  }, [handleRetry]);

  return (
    <>
      {error && (
        <div
          role="alert"
          onClick={() => setError(null)}
          style={{ marginBottom: '1rem', padding: '0.75rem 1.1rem', borderRadius: '14px', backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-light)', color: 'var(--text-main)', fontSize: '0.85rem', lineHeight: 1.4, cursor: 'pointer', textAlign: 'center' }}
        >
          {error}
        </div>
      )}

      <ArchiveList
        kicker="LISTEN"
        title="聴く"
        headerAction={<AddButton onClick={() => setSheetOpen(true)} label="エピソードを作る" />}
        items={episodes}
        isLoading={isLoading}
        createdAt={createdAtOf}
        card={card}
        loadSearchText={fetchEpisodeSearchText}
        isUnfinished={isUnplayed}
        unfinishedLabel="未再生"
        unit="本"
        onOpen={onOpenEpisode}
        onDelete={handleDelete}
        memoryKey="listen"
        empty={
          <div style={{ textAlign: 'center', padding: '4rem 1rem', color: 'var(--text-muted)' }}>
            <h2 className="serif" style={{ fontSize: '1.4rem', marginBottom: '0.8rem', color: 'var(--text-main)' }}>まだエピソードがありません</h2>
            <p style={{ fontSize: '0.85rem', lineHeight: 1.7 }}>毎朝ダイジェストが届きます</p>
          </div>
        }
      />

      <PodcastSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onCreated={(ep) => setEpisodes((prev) => [ep, ...prev])}
      />
    </>
  );
}

const createdAtOf = (ep: PodcastEpisode) => ep.created_at;
const isUnplayed = (ep: PodcastEpisode) => ep.status === 'ready' && stateOf(ep) === 'new';

const spinner = (size = 12) => (
  <div
    className="lucide-spin"
    style={{ width: size, height: size, border: '1.5px solid rgba(74, 93, 35, 0.2)', borderTopColor: '#4a5d23', borderRadius: '50%' }}
  />
);

function statusCorner(ep: PodcastEpisode, onRetry: (ep: PodcastEpisode) => void) {
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
        onClick={(e) => { e.stopPropagation(); onRetry(ep); }}
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
}
