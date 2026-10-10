import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { SliderToggle } from './SliderToggle';
import { useScrollLock } from '../hooks/useScrollLock';
import {
  PodcastEpisode,
  EpisodeSource,
  createEpisode,
  episodeErrorMessage,
} from '../services/podcasts';

// Create-episode bottom sheet (docs/design-system.md §6.2–6.4, mockup
// docs/mockups/podcast-create.html), shared by the LISTEN tab's + button and
// the Reader's headphone icon. Three groups, spaced rather than boxed:
//   what     — source slider + hero input (or the fixed article's title)
//   optional — "＋ リクエスト", swapped for its field in the same slot
//   go       — compact length slider + 作る on one row
// The source pane has one fixed height so switching source never moves the
// sheet or the rows below it.

const TEXT_MIN_CHARS = 200;
const TEXT_MAX_CHARS = 20_000;
const REQUEST_MAX_CHARS = 300;
const TOPIC_SUGGESTIONS = ['宇宙', 'AI', '料理', '旅行'];
const PANE_HEIGHT = '92px';
const EASE = '0.4s cubic-bezier(0.4, 0, 0.2, 1)';

type SourceTab = 'topic' | 'text' | 'url';

const SOURCE_OPTIONS = [
  { value: 'topic', label: 'トピック' },
  { value: 'text', label: 'テキスト' },
  { value: 'url', label: 'URL' },
] as const;

const LENGTH_OPTIONS = [5, 10, 15].map((m) => ({ value: m, label: `${m}分` }));

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (episode: PodcastEpisode) => void;
  /** Fixed source: make the episode from this article / long-form part. */
  article?: { id: string; title: string };
}

export function PodcastSheet({ open, onClose, onCreated, article }: Props) {
  const [sourceTab, setSourceTab] = useState<SourceTab>('topic');
  const [topic, setTopic] = useState('');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [minutes, setMinutes] = useState(5);
  const [request, setRequest] = useState('');
  const [requestOpen, setRequestOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  useScrollLock(open);

  useEffect(() => {
    if (requestOpen) requestRef.current?.focus();
  }, [requestOpen]);

  useEffect(() => { if (open) setError(null); }, [open]);

  const trimmedTopic = topic.trim();
  const textChars = text.trim().length;
  const trimmedUrl = url.trim();
  const hasSource = article
    ? true
    : sourceTab === 'topic' ? trimmedTopic.length >= 2 && trimmedTopic.length <= 80
      : sourceTab === 'text' ? textChars >= TEXT_MIN_CHARS && textChars <= TEXT_MAX_CHARS
        : /^https?:\/\/\S+\.\S+/i.test(trimmedUrl);
  const ready = hasSource && !isCreating;

  // Validation copy only when the paste is out of range (design-system §6.2).
  const textHint = sourceTab === 'text' && textChars > 0
    ? textChars < TEXT_MIN_CHARS ? `${textChars} / ${TEXT_MIN_CHARS}字`
      : textChars > TEXT_MAX_CHARS ? `${textChars.toLocaleString()} / ${TEXT_MAX_CHARS.toLocaleString()}字`
        : null
    : null;

  const handleCreate = async () => {
    if (!ready) return;
    const source: EpisodeSource = article
      ? { kind: 'article', articleId: article.id }
      : sourceTab === 'topic' ? { kind: 'topic', topic: trimmedTopic }
        : sourceTab === 'text' ? { kind: 'text', text: text.trim() }
          : { kind: 'url', url: trimmedUrl };
    setIsCreating(true);
    setError(null);
    try {
      const ep = await createEpisode(source, minutes, request.trim() || undefined);
      if (!mountedRef.current) return;
      onCreated(ep);
      setTopic('');
      setText('');
      setUrl('');
      setRequest('');
      setRequestOpen(false);
      onClose();
    } catch (e) {
      console.error('[podcast-sheet] create failed:', e);
      if (mountedRef.current) setError(await episodeErrorMessage(e));
    } finally {
      if (mountedRef.current) setIsCreating(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="podcast-sheet-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(45,45,45,0.35)', zIndex: 40 }}
          />
          <motion.div
            key="podcast-sheet"
            role="dialog"
            aria-label={article ? 'この記事からエピソードを作る' : '新しいエピソード'}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 400, damping: 40 }}
            style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 50, backgroundColor: 'var(--bg-color)', borderRadius: '28px 28px 0 0', padding: '1.5rem 1.5rem calc(2.2rem + env(safe-area-inset-bottom))', boxShadow: '0 -10px 40px rgba(0,0,0,0.15)', maxWidth: '600px', margin: '0 auto' }}
          >
            <div style={{ width: '36px', height: '4px', borderRadius: '2px', backgroundColor: 'var(--border-light)', margin: '0 auto 1.2rem' }} />

            {/* ── what ── */}
            {article ? (
              <>
                <div style={{ fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.16em', color: 'var(--text-muted)', marginBottom: '0.3rem' }}>この記事から</div>
                <div className="serif" style={{ fontSize: '1.25rem', lineHeight: 1.5, color: 'var(--text-main)', marginBottom: '0.4rem', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {article.title}
                </div>
              </>
            ) : (
              <>
                <h2 className="serif" style={{ fontSize: '1.3rem', fontWeight: 600, marginBottom: '1rem', color: 'var(--text-main)' }}>新しいエピソード</h2>
                <SliderToggle options={SOURCE_OPTIONS} value={sourceTab} onChange={setSourceTab} ariaLabel="ソース" />
                <div style={{ marginTop: '1.5rem', height: PANE_HEIGHT, position: 'relative' }}>
                  {sourceTab === 'topic' && (
                    <>
                      <input
                        value={topic}
                        onChange={(e) => setTopic(e.target.value)}
                        placeholder="何について？"
                        maxLength={80}
                        className="hero-input"
                        style={heroInputStyle}
                      />
                      <div style={{ display: 'flex', gap: '1.1rem', marginTop: '0.75rem' }}>
                        {TOPIC_SUGGESTIONS.map((t) => (
                          <button
                            key={t}
                            onClick={() => setTopic(t)}
                            className="serif"
                            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: '0.9rem', color: topic === t ? 'var(--text-main)' : 'var(--text-muted)' }}
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
                        placeholder="テキストを貼り付け"
                        style={{ width: '100%', height: '100%', border: 'none', outline: 'none', resize: 'none', backgroundColor: 'var(--bg-card)', borderRadius: '16px', padding: '0.8rem 1rem', fontFamily: 'var(--font-sans)', fontSize: '0.85rem', lineHeight: 1.6, color: 'var(--text-main)' }}
                      />
                      {textHint && (
                        <span style={{ position: 'absolute', right: '0.9rem', bottom: '0.5rem', fontSize: '0.7rem', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{textHint}</span>
                      )}
                    </>
                  )}
                  {sourceTab === 'url' && (
                    <input
                      type="url"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder="https://"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      className="hero-input"
                      style={{ ...heroInputStyle, fontFamily: 'var(--font-sans)', fontSize: '1rem', paddingTop: '0.6rem' }}
                    />
                  )}
                </div>
              </>
            )}

            {/* ── optional request: link and field share one reserved slot ── */}
            <div style={{ height: '2.4rem', marginTop: '1rem', display: 'flex', alignItems: 'center' }}>
              {requestOpen ? (
                <input
                  ref={requestRef}
                  value={request}
                  onChange={(e) => setRequest(e.target.value)}
                  placeholder={article ? '例：この人物の話を中心に' : '例：ゆっくり、例を多めに'}
                  maxLength={REQUEST_MAX_CHARS}
                  className="hero-input"
                  style={{ width: '100%', border: 'none', outline: 'none', background: 'transparent', borderBottom: '1px solid var(--border-light)', padding: '0.4rem 0.1rem', fontFamily: 'var(--font-sans)', fontSize: '0.85rem', color: 'var(--text-main)' }}
                />
              ) : (
                <button
                  onClick={() => setRequestOpen(true)}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: '0.8rem', letterSpacing: '0.04em', color: 'var(--text-muted)' }}
                >
                  ＋ リクエスト
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

/** Primary action (design-system §6.3): flat on the track colour until it can
 *  be pressed, then it becomes the slider thumb and lifts. */
function CreateButton({ ready, busy, onClick }: { ready: boolean; busy: boolean; onClick: () => void }) {
  const [pressed, setPressed] = useState(false);
  return (
    <button
      onClick={onClick}
      disabled={!ready}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      className="serif"
      style={{
        height: '45px',
        padding: '0 2rem',
        border: 'none',
        borderRadius: '100px',
        cursor: ready ? 'pointer' : 'default',
        fontSize: '1.05rem',
        letterSpacing: '0.08em',
        fontWeight: ready ? 700 : 500,
        backgroundColor: ready ? 'var(--bg-pure)' : 'var(--border-light)',
        color: ready ? 'var(--text-main)' : 'var(--text-muted)',
        opacity: ready || busy ? 1 : 0.7,
        transform: ready ? (pressed ? 'translateY(0) scale(0.98)' : 'translateY(-1px)') : 'none',
        boxShadow: ready ? (pressed ? '0 2px 8px rgba(0,0,0,0.1)' : '0 4px 14px rgba(0,0,0,0.1)') : 'none',
        transition: pressed
          ? 'transform 0.1s, box-shadow 0.1s'
          : `background-color ${EASE}, color ${EASE}, opacity ${EASE}, transform ${EASE}, box-shadow ${EASE}`,
        flexShrink: 0,
      }}
    >
      {busy ? '…' : '作る'}
    </button>
  );
}

const heroInputStyle: React.CSSProperties = {
  width: '100%',
  border: 'none',
  outline: 'none',
  background: 'transparent',
  borderBottom: '1px solid var(--border-light)',
  fontFamily: 'var(--font-serif)',
  fontSize: '1.35rem',
  color: 'var(--text-main)',
  padding: '0.3rem 0.1rem 0.55rem',
};
