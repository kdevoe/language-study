import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, Plus } from 'lucide-react';
import {
  LongFormWork,
  NewsArticle,
  fetchProcessedArticleById,
  fetchWorks,
  importErrorMessage,
  importFromUrl,
  importPastedText,
  workPartArticleId,
} from '../services/api';
import { supabase } from '../services/supabase';

const DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true';

// Input guards — mirrored server-side in process-article (the server is
// authoritative; these just keep the CTA honest before the round-trip).
const IMPORT_MIN_CHARS = 300;
const IMPORT_MAX_CHARS = 40_000;
const IMPORT_SOFT_WARN_CHARS = 20_000;
// Mirrors the server's PART_TARGET_CHARS for the live part estimate.
const PART_TARGET_CHARS = 10_000;
const estimateParts = (chars: number) => Math.max(1, Math.ceil(chars / PART_TARGET_CHARS));

interface Props {
  /** Open a ready work in the Reader. The article is the processed part content;
   *  resumeBlockIndex pre-scrolls to the saved reading position (design §5). */
  onOpenWork: (work: LongFormWork, article: NewsArticle, resumeBlockIndex?: number) => void;
}

async function resolveUserId(): Promise<string | null> {
  if (DEV_MODE) return 'dev-user';
  const { data: { session } } = await supabase.auth.getSession();
  return session?.user?.id ?? null;
}

/** Quiet relative date for the card sub-line. */
function relativeDate(iso: string): string {
  const then = new Date(iso);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(then)) / 86_400_000);
  if (days <= 0) return '今日';
  if (days === 1) return '昨日';
  if (days < 7) return `${days}日前`;
  if (days < 30) return '先週';
  return then.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' });
}

type Filter = 'all' | 'import' | 'magazine';

export function Library({ onOpenWork }: Props) {
  const [works, setWorks] = useState<LongFormWork[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [importTab, setImportTab] = useState<'paste' | 'url'>('paste');
  const [pasteText, setPasteText] = useState('');
  const [urlText, setUrlText] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error]);

  const loadWorks = useCallback(async () => {
    const userId = await resolveUserId();
    if (!userId) { setIsLoading(false); return; }
    const list = await fetchWorks(userId);
    if (!mountedRef.current) return;
    setWorks(list);
    setIsLoading(false);
  }, []);

  useEffect(() => { loadWorks(); }, [loadWorks]);

  const chars = pasteText.trim().length;
  const trimmedUrl = urlText.trim();
  const urlValid = /^https?:\/\/\S+$/i.test(trimmedUrl);
  const importable = !isImporting && (importTab === 'paste'
    ? chars >= IMPORT_MIN_CHARS && chars <= IMPORT_MAX_CHARS
    : urlValid);

  const handleImport = async () => {
    if (!importable) return;
    const userId = await resolveUserId();
    if (!userId) { setError('サインインが必要です。'); return; }
    setIsImporting(true);
    setSheetOpen(false); // the placeholder card below shows progress
    try {
      const { work, article } = importTab === 'paste'
        ? await importPastedText(userId, pasteText.trim())
        : await importFromUrl(userId, trimmedUrl);
      if (!mountedRef.current) return; // finished server-side; next visit shows it READY
      setPasteText('');
      setUrlText('');
      setWorks(prev => [{ ...work, partArticleId: article.id, partReady: true }, ...prev]);
      // The CTA is インポートして読む — the user has been watching this prepare,
      // so take them straight into the Reader.
      onOpenWork(work, article);
    } catch (e) {
      console.error('[library] import failed:', e);
      if (!mountedRef.current) return;
      setError(importErrorMessage(e));
      setSheetOpen(true); // the input is preserved — let them retry
    } finally {
      if (mountedRef.current) setIsImporting(false);
    }
  };

  const handleOpen = async (work: LongFormWork) => {
    if (!work.partReady || !work.partArticleId || openingId) return;
    const userId = await resolveUserId();
    if (!userId) { setError('サインインが必要です。'); return; }
    setOpeningId(work.id);
    try {
      // Resume at the saved position's part when that part is processed
      // (design §5: tapping a card resumes where the reader left off).
      const pos = work.readingPosition;
      const resumable = !!pos
        && pos.partIndex > 1
        && pos.partIndex <= work.partCount
        && (work.parts ?? []).some(p => p.index === pos.partIndex && p.status !== 'failed' && p.status !== 'pending');
      const targetIndex = resumable ? pos!.partIndex : 1;
      const targetId = targetIndex === 1 ? work.partArticleId : workPartArticleId(work.id, targetIndex);
      let article = await fetchProcessedArticleById(targetId, userId);
      if (!article && targetIndex !== 1) {
        article = await fetchProcessedArticleById(work.partArticleId, userId);
      }
      if (!article) { setError('この作品を読み込めませんでした。'); return; }
      const resumeBlock = pos && article.partIndex === pos.partIndex ? (pos.blockIndex ?? 0) : 0;
      onOpenWork(work, article, resumeBlock);
    } finally {
      if (mountedRef.current) setOpeningId(null);
    }
  };

  // Library order: works you can pick up (active) first, finished after;
  // newest first within each group. No swipe-to-dismiss — it's a collection.
  const visible = works
    .filter(w => filter === 'all' || w.sourceType === filter)
    .sort((a, b) => {
      if ((a.status === 'finished') !== (b.status === 'finished')) return a.status === 'finished' ? 1 : -1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

  const filterPill = (f: Filter, label: string) => (
    <button
      key={f}
      onClick={() => setFilter(f)}
      style={{
        fontSize: '0.66rem',
        fontWeight: 800,
        letterSpacing: '0.08em',
        cursor: 'pointer',
        padding: '0.42rem 1rem',
        borderRadius: '100px',
        border: filter === f ? '1px solid var(--text-main)' : '1px solid var(--border-light)',
        backgroundColor: filter === f ? 'var(--text-main)' : 'transparent',
        color: filter === f ? 'var(--bg-pure)' : 'var(--text-muted)',
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
      style={{
        width: size,
        height: size,
        border: '1.5px solid rgba(74, 93, 35, 0.2)',
        borderTopColor: '#4a5d23',
        borderRadius: '50%',
      }}
    />
  );

  return (
    <div style={{ paddingBottom: '6rem' }}>
      {error && (
        <div
          role="alert"
          onClick={() => setError(null)}
          style={{
            marginBottom: '1rem',
            padding: '0.75rem 1.1rem',
            borderRadius: '14px',
            backgroundColor: 'var(--bg-card)',
            border: '1px solid var(--border-light)',
            color: 'var(--text-main)',
            fontSize: '0.85rem',
            lineHeight: 1.4,
            cursor: 'pointer',
            textAlign: 'center',
          }}
        >
          {error}
        </div>
      )}

      {/* Header: kicker + 書庫 + the import entry point (the whole BYOC UI). */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: '1.2rem' }}>
        <div>
          <div style={{ fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.2em', color: 'var(--text-muted)' }}>LIBRARY</div>
          <h1 className="serif" translate="no" style={{ fontSize: '2rem', fontWeight: 500, lineHeight: 1.2, color: 'var(--text-main)' }}>書庫</h1>
        </div>
        <button
          onClick={() => setSheetOpen(true)}
          aria-label="コンテンツを追加"
          style={{
            width: '48px',
            height: '48px',
            borderRadius: '50%',
            border: 'none',
            cursor: 'pointer',
            backgroundColor: 'var(--text-main)',
            color: 'var(--bg-pure)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 6px 18px rgba(0,0,0,0.15)',
          }}
        >
          <Plus size={22} strokeWidth={1.5} />
        </button>
      </div>

      {/* Filter pills — one flat list below, no shelves. */}
      <div style={{ display: 'flex', gap: '0.45rem', marginBottom: '1.4rem' }}>
        {filterPill('all', 'すべて')}
        {filterPill('import', 'インポート')}
        {filterPill('magazine', '雑誌')}
      </div>

      {isLoading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {[1, 2].map(i => (
            <div key={i} className="skeleton-shimmer" style={{ width: '100%', height: '140px', borderRadius: '24px' }} />
          ))}
        </div>
      ) : visible.length === 0 && !isImporting ? (
        <div style={{ textAlign: 'center', padding: '4rem 1rem', color: 'var(--text-muted)' }}>
          <h2 className="serif" style={{ fontSize: '1.4rem', marginBottom: '0.8rem', color: 'var(--text-main)' }}>
            {filter === 'magazine' ? '雑誌はまだありません' : 'まだ何もありません'}
          </h2>
          <p style={{ fontSize: '0.9rem', lineHeight: 1.7, maxWidth: '300px', margin: '0 auto' }}>
            {filter === 'magazine'
              ? '雑誌の特集は今後追加される予定です。'
              : 'ブログ記事、メール、本の一節… 読みたい英語のテキストを + ボタンから追加すると、あなたのレベルに合わせた日本語で読めます。'}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <AnimatePresence mode="popLayout">
            {/* In-flight import: a placeholder card while part 1 prepares. */}
            {isImporting && (filter === 'all' || filter === 'import') && (
              <motion.div
                key="importing-placeholder"
                layout="position"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
                style={{
                  backgroundColor: 'var(--bg-card)',
                  borderRadius: '24px',
                  padding: '1.5rem',
                  border: '1px solid var(--border-light)',
                  position: 'relative',
                  overflow: 'hidden',
                }}
              >
                <motion.div
                  initial={{ x: '-100%' }}
                  animate={{ x: '0%' }}
                  transition={{ duration: 20, ease: 'linear' }}
                  style={{ position: 'absolute', bottom: 0, left: 0, height: '3px', width: '100%', backgroundColor: '#4a5d23', opacity: 0.4 }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.1rem' }}>
                  <span style={{ fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.15em', backgroundColor: 'var(--bg-pure)', color: 'var(--text-muted)', padding: '0.3rem 0.7rem', borderRadius: '8px' }}>
                    IMPORT
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.7rem', fontWeight: 800, color: 'var(--text-muted)' }}>
                    {spinner()} 準備中
                  </span>
                </div>
                <h3 className="serif" style={{ fontSize: '1.35rem', lineHeight: 1.45, color: 'var(--text-muted)', marginBottom: '1rem', maxWidth: '92%' }}>
                  {importTab === 'url'
                    ? (trimmedUrl.replace(/^https?:\/\//i, '').split('/')[0] || 'インポート')
                    : (pasteText.trim().split('\n').find(l => l.trim())?.slice(0, 60) || 'インポート')}
                </h3>
                <div style={{ fontSize: '0.75rem', color: '#4a5d23', fontWeight: 600 }}>
                  あなたのレベルに合わせて書き直しています…
                </div>
              </motion.div>
            )}

            {visible.map(work => {
              const finished = work.status === 'finished';
              const isOpening = openingId === work.id;
              return (
                <motion.div
                  key={work.id}
                  layout="position"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
                  onClick={() => handleOpen(work)}
                  whileTap={{ scale: 0.98 }}
                  style={{
                    backgroundColor: 'var(--bg-card)',
                    borderRadius: '24px',
                    padding: '1.5rem',
                    border: work.partReady && !finished ? '1px solid rgba(74, 93, 35, 0.15)' : '1px solid var(--border-light)',
                    boxShadow: '0 4px 25px rgba(0,0,0,0.03)',
                    cursor: work.partReady ? 'pointer' : 'default',
                    position: 'relative',
                    overflow: 'hidden',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.1rem', gap: '0.6rem' }}>
                    <span style={{
                      fontSize: '0.65rem',
                      fontWeight: 800,
                      letterSpacing: '0.15em',
                      backgroundColor: work.sourceType === 'magazine' ? 'rgba(74, 93, 35, 0.08)' : 'var(--bg-pure)',
                      color: work.sourceType === 'magazine' ? '#4a5d23' : 'var(--text-muted)',
                      padding: '0.3rem 0.7rem',
                      borderRadius: '8px',
                    }}>
                      {work.sourceType === 'magazine' ? 'MAGAZINE' : work.originUrl ? 'IMPORT · URL' : 'IMPORT'}
                    </span>
                    {isOpening ? (
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.7rem', fontWeight: 800, color: 'var(--text-muted)' }}>
                        {spinner()} 読み込み中
                      </span>
                    ) : finished ? (
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.7rem', fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
                        <CheckCircle2 size={16} strokeWidth={2.5} />
                        <span className="serif" style={{ fontSize: '0.8rem' }}>完了</span>
                      </span>
                    ) : work.partReady && work.partCount > 1 && work.readingPosition ? (
                      <span className="serif" style={{ fontSize: '0.8rem', fontWeight: 600, color: '#4a5d23', letterSpacing: '0.05em' }}>
                        第{Math.min(work.readingPosition.partIndex, work.partCount)}部・全{work.partCount}部
                      </span>
                    ) : work.partReady ? (
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.7rem', fontWeight: 800, color: '#4a5d23', letterSpacing: '0.05em' }}>
                        <CheckCircle2 size={16} strokeWidth={2.5} />
                        READY
                      </span>
                    ) : (
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.7rem', fontWeight: 800, color: 'var(--text-muted)' }}>
                        {spinner()} 準備中
                      </span>
                    )}
                  </div>

                  <h3 className="serif" style={{ fontSize: '1.35rem', lineHeight: 1.45, color: 'var(--text-main)', marginBottom: '1rem', maxWidth: '92%' }}>
                    {work.title}
                  </h3>

                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 500 }}>
                    約{work.charCount.toLocaleString()}字
                    <span style={{ margin: '0 0.35rem', opacity: 0.5 }}>·</span>
                    全{work.partCount}部
                    <span style={{ margin: '0 0.35rem', opacity: 0.5 }}>·</span>
                    {relativeDate(work.createdAt)}
                  </div>

                  {/* In-progress works carry a thin progress line along the
                      card's bottom edge (design §6). */}
                  {!finished && (work.readingPosition?.percent ?? 0) > 0 && (
                    <div style={{
                      position: 'absolute',
                      bottom: 0,
                      left: 0,
                      height: '3px',
                      width: `${Math.min(100, Math.round((work.readingPosition!.percent ?? 0) * 100))}%`,
                      backgroundColor: '#4a5d23',
                      opacity: 0.45,
                    }} />
                  )}
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}

      {/* ── Import sheet (the whole BYOC UI: paste → estimate → import) ── */}
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
              style={{
                position: 'fixed',
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 50,
                backgroundColor: 'var(--bg-color)',
                borderRadius: '28px 28px 0 0',
                padding: '1.5rem 1.5rem calc(2.2rem + env(safe-area-inset-bottom))',
                boxShadow: '0 -10px 40px rgba(0,0,0,0.15)',
                maxWidth: '600px',
                margin: '0 auto',
              }}
            >
              <div style={{ width: '36px', height: '4px', borderRadius: '2px', backgroundColor: 'var(--border-light)', margin: '0 auto 1.2rem' }} />
              <h2 className="serif" style={{ fontSize: '1.3rem', fontWeight: 600, marginBottom: '0.9rem', color: 'var(--text-main)' }}>
                コンテンツを追加
              </h2>

              {/* Paste / URL tabs (design §6: the import sheet's two paths). */}
              <div style={{ display: 'flex', gap: '0.45rem', marginBottom: '0.9rem' }}>
                {([['paste', '貼り付け'], ['url', 'URL']] as const).map(([tab, label]) => (
                  <button
                    key={tab}
                    onClick={() => setImportTab(tab)}
                    style={{
                      fontSize: '0.66rem',
                      fontWeight: 800,
                      letterSpacing: '0.08em',
                      cursor: 'pointer',
                      padding: '0.42rem 1rem',
                      borderRadius: '100px',
                      border: importTab === tab ? '1px solid var(--text-main)' : '1px solid var(--border-light)',
                      backgroundColor: importTab === tab ? 'var(--text-main)' : 'transparent',
                      color: importTab === tab ? 'var(--bg-pure)' : 'var(--text-muted)',
                      fontFamily: 'var(--font-sans)',
                      transition: 'all 0.2s',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {importTab === 'paste' ? (
                <>
                  <textarea
                    value={pasteText}
                    onChange={e => setPasteText(e.target.value)}
                    placeholder="ブログ記事、メール、歌詞、本の一節… 英語のテキストを貼り付けてください。"
                    style={{
                      width: '100%',
                      height: '130px',
                      resize: 'none',
                      fontFamily: 'var(--font-sans)',
                      fontSize: '0.85rem',
                      backgroundColor: 'var(--bg-pure)',
                      border: '1px solid var(--border-light)',
                      borderRadius: '16px',
                      padding: '0.9rem 1rem',
                      color: 'var(--text-main)',
                      outline: 'none',
                      lineHeight: 1.6,
                    }}
                  />
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: '0.8rem 0.2rem 0.2rem', lineHeight: 1.6 }}>
                    {chars === 0 ? (
                      <>最大{IMPORT_MAX_CHARS.toLocaleString()}字までインポートできます。長いテキストは約{PART_TARGET_CHARS.toLocaleString()}字ごとの部に分かれます。</>
                    ) : chars < IMPORT_MIN_CHARS ? (
                      <>{chars}字 — 短すぎます（{IMPORT_MIN_CHARS}字以上）。</>
                    ) : chars > IMPORT_MAX_CHARS ? (
                      <>約{chars.toLocaleString()}字 — {IMPORT_MAX_CHARS.toLocaleString()}字までです。</>
                    ) : (
                      <>
                        約{chars.toLocaleString()}字 → <b style={{ color: '#4a5d23' }}>全{estimateParts(chars)}部</b>。
                        {estimateParts(chars) > 1
                          ? '第1部はすぐに準備され、続きは読みながら準備されます。'
                          : 'あなたのレベルに合わせた日本語で、すぐに準備されます。'}
                        {chars >= IMPORT_SOFT_WARN_CHARS && <>{' '}長めのテキストです — 数日に分けて読むのがおすすめです。</>}
                      </>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <input
                    type="url"
                    value={urlText}
                    onChange={e => setUrlText(e.target.value)}
                    placeholder="https://example.com/article"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    style={{
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
                    }}
                  />
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: '0.8rem 0.2rem 0.2rem', lineHeight: 1.6 }}>
                    {trimmedUrl.length > 0 && !urlValid
                      ? <>URLの形式が正しくありません（https://…）。</>
                      : <>記事やブログのURLから本文を取り込みます。取り込めないページもあります — その場合は本文を貼り付けてください。</>}
                  </div>
                </>
              )}
              <button
                onClick={handleImport}
                disabled={!importable}
                style={{
                  width: '100%',
                  marginTop: '1rem',
                  border: 'none',
                  cursor: importable ? 'pointer' : 'default',
                  backgroundColor: importable ? 'var(--text-main)' : 'var(--border-light)',
                  color: importable ? 'var(--bg-pure)' : 'var(--text-muted)',
                  fontFamily: 'var(--font-sans)',
                  fontSize: '0.72rem',
                  fontWeight: 800,
                  letterSpacing: '0.12em',
                  padding: '1rem',
                  borderRadius: '100px',
                  transition: 'all 0.2s',
                }}
              >
                {isImporting ? '準備中…' : 'インポートして読む'}
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
