import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, Plus, RotateCw } from 'lucide-react';
import {
  PodcastEpisode,
  EpisodeSource,
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
// flat card list under filter pills — the Library's card language — plus a +
// sheet that makes an episode from a topic, pasted text or a URL. Today's daily
// digest is requested automatically the first time the tab opens each day.

const POLL_MS = 5000;
const TEXT_MIN_CHARS = 200;
const TEXT_MAX_CHARS = 20_000;
const TOPIC_SUGGESTIONS = ['宇宙', 'AI', '料理', '旅行', 'スポーツ', '日本の電車'];
const LENGTHS = [5, 10, 15];
// Remembers the day an automatic digest was last requested, so a feed with no
// stories (or a failure) doesn't re-request on every visit.
const DIGEST_ATTEMPT_KEY = 'yugen-digest-attempt';

type Filter = 'all' | 'new' | 'partial' | 'done';

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
  const [sourceTab, setSourceTab] = useState<'topic' | 'text' | 'url'>('topic');
  const [topic, setTopic] = useState('');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [minutes, setMinutes] = useState(5);
  const [isCreating, setIsCreating] = useState(false);
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

  const trimmedTopic = topic.trim();
  const textChars = text.trim().length;
  const trimmedUrl = url.trim();
  const creatable = !isCreating && (
    sourceTab === 'topic' ? trimmedTopic.length >= 2 && trimmedTopic.length <= 80
      : sourceTab === 'text' ? textChars >= TEXT_MIN_CHARS && textChars <= TEXT_MAX_CHARS
        : /^https?:\/\/\S+$/i.test(trimmedUrl)
  );

  const handleCreate = async () => {
    if (!creatable) return;
    const source: EpisodeSource = sourceTab === 'topic'
      ? { kind: 'topic', topic: trimmedTopic }
      : sourceTab === 'text'
        ? { kind: 'text', text: text.trim() }
        : { kind: 'url', url: trimmedUrl };
    setIsCreating(true);
    try {
      const ep = await createEpisode(source, minutes);
      if (!mountedRef.current) return;
      setEpisodes((prev) => [ep, ...prev]);
      setSheetOpen(false);
      setTopic('');
      setText('');
      setUrl('');
    } catch (e) {
      console.error('[listen] create failed:', e);
      if (mountedRef.current) setError(await episodeErrorMessage(e));
    } finally {
      if (mountedRef.current) setIsCreating(false);
    }
  };

  const handleRetry = async (ep: PodcastEpisode) => {
    try {
      const updated = await retryEpisode(ep.id);
      if (mountedRef.current) setEpisodes((prev) => prev.map((p) => (p.id === ep.id ? { ...p, ...updated } : p)));
    } catch (e) {
      if (mountedRef.current) setError(await episodeErrorMessage(e));
    }
  };

  const visible = episodes.filter((e) => filter === 'all' || stateOf(e) === filter);

  const pill = (active: boolean, label: string, onClick: () => void, key?: string) => (
    <button
      key={key ?? label}
      onClick={onClick}
      style={{
        fontSize: '0.66rem',
        fontWeight: 800,
        letterSpacing: '0.08em',
        cursor: 'pointer',
        padding: '0.42rem 1rem',
        borderRadius: '100px',
        border: active ? '1px solid var(--text-main)' : '1px solid var(--border-light)',
        backgroundColor: active ? 'var(--text-main)' : 'transparent',
        color: active ? 'var(--bg-pure)' : 'var(--text-muted)',
        fontFamily: 'var(--font-sans)',
        transition: 'all 0.2s',
      }}
    >
      {label}
    </button>
  );

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

      <div style={{ display: 'flex', gap: '0.45rem', marginBottom: '1.4rem', flexWrap: 'wrap' }}>
        {pill(filter === 'all', 'すべて', () => setFilter('all'))}
        {pill(filter === 'new', '未再生', () => setFilter('new'))}
        {pill(filter === 'partial', '途中', () => setFilter('partial'))}
        {pill(filter === 'done', '完了', () => setFilter('done'))}
      </div>

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
          <p style={{ fontSize: '0.9rem', lineHeight: 1.7, maxWidth: '300px', margin: '0 auto' }}>
            毎朝、ニュースから「今日のダイジェスト」が届きます。+ ボタンで好きなトピックやテキストからも作れます。
          </p>
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

      {/* ── Create sheet ── */}
      <AnimatePresence>
        {sheetOpen && (
          <>
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSheetOpen(false)}
              style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(45,45,45,0.35)', zIndex: 40 }}
            />
            <motion.div
              key="sheet"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', stiffness: 400, damping: 40 }}
              style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 50, backgroundColor: 'var(--bg-color)', borderRadius: '28px 28px 0 0', padding: '1.5rem 1.5rem calc(2.2rem + env(safe-area-inset-bottom))', boxShadow: '0 -10px 40px rgba(0,0,0,0.15)', maxWidth: '600px', margin: '0 auto' }}
            >
              <div style={{ width: '36px', height: '4px', borderRadius: '2px', backgroundColor: 'var(--border-light)', margin: '0 auto 1.2rem' }} />
              <h2 className="serif" style={{ fontSize: '1.3rem', fontWeight: 600, marginBottom: '0.9rem', color: 'var(--text-main)' }}>
                エピソードを作る
              </h2>

              <div style={{ display: 'flex', gap: '0.45rem', marginBottom: '0.9rem' }}>
                {pill(sourceTab === 'topic', 'トピック', () => setSourceTab('topic'))}
                {pill(sourceTab === 'text', 'テキスト', () => setSourceTab('text'))}
                {pill(sourceTab === 'url', 'URL', () => setSourceTab('url'))}
              </div>

              {sourceTab === 'topic' && (
                <>
                  <input
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    placeholder="例：日本の電車、AIと仕事、秋の料理…"
                    maxLength={80}
                    style={fieldStyle}
                  />
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.7rem' }}>
                    {TOPIC_SUGGESTIONS.map((t) => (
                      <button
                        key={t}
                        onClick={() => setTopic(t)}
                        className="serif"
                        style={{ fontSize: '0.85rem', padding: '0.35rem 0.85rem', borderRadius: '100px', border: '1px solid var(--border-light)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {sourceTab === 'text' && (
                <>
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="英語のテキストを貼り付けてください。会話形式のポッドキャストに書き直します。"
                    style={{ ...fieldStyle, height: '120px', resize: 'none' }}
                  />
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: '0.6rem 0.2rem 0' }}>
                    {textChars === 0
                      ? `${TEXT_MIN_CHARS}〜${TEXT_MAX_CHARS.toLocaleString()}字`
                      : textChars < TEXT_MIN_CHARS
                        ? `${textChars}字 — 短すぎます（${TEXT_MIN_CHARS}字以上）。`
                        : textChars > TEXT_MAX_CHARS
                          ? `約${textChars.toLocaleString()}字 — ${TEXT_MAX_CHARS.toLocaleString()}字までです。`
                          : `約${textChars.toLocaleString()}字`}
                  </div>
                </>
              )}
              {sourceTab === 'url' && (
                <input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/article"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  style={fieldStyle}
                />
              )}

              <div style={{ fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.16em', color: 'var(--text-muted)', margin: '1.1rem 0 0.5rem' }}>長さ</div>
              <div style={{ display: 'flex', gap: '0.45rem' }}>
                {LENGTHS.map((m) => pill(minutes === m, `約${m}分`, () => setMinutes(m), `len-${m}`))}
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: '0.9rem 0.2rem 0', lineHeight: 1.6 }}>
                出演者はおまかせ — 毎回ちがう組み合わせでお届けします。作成には1〜2分かかります。
              </div>

              <button
                onClick={handleCreate}
                disabled={!creatable}
                style={{ width: '100%', marginTop: '1rem', border: 'none', cursor: creatable ? 'pointer' : 'default', backgroundColor: creatable ? 'var(--text-main)' : 'var(--border-light)', color: creatable ? 'var(--bg-pure)' : 'var(--text-muted)', fontFamily: 'var(--font-sans)', fontSize: '0.72rem', fontWeight: 800, letterSpacing: '0.12em', padding: '1rem', borderRadius: '100px', transition: 'all 0.2s' }}
              >
                {isCreating ? '送信中…' : 'エピソードを作る'}
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

const fieldStyle: React.CSSProperties = {
  width: '100%',
  fontFamily: 'var(--font-sans)',
  fontSize: '0.85rem',
  backgroundColor: 'var(--bg-pure)',
  border: '1px solid var(--border-light)',
  borderRadius: '16px',
  padding: '0.9rem 1rem',
  color: 'var(--text-main)',
  outline: 'none',
  lineHeight: 1.6,
};
