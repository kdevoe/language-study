import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useScrollLock } from '../hooks/useScrollLock';
import { ArchiveList, ProgressRing } from './ArchiveList';
import type { ArchiveCard } from './ArchiveList';
import type { TitleSwitch } from './PageHeading';
import {
  LongFormWork,
  NewsArticle,
  deleteWorks,
  fetchWorkResumeArticle,
  fetchWorkSearchText,
  fetchWorks,
  importErrorMessage,
  importFromUrl,
  importPastedText,
  retryWorkPartInBackground,
} from '../services/api';
import { supabase } from '../services/supabase';
import { readListCache, writeListCache } from '../services/listCache';

const DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true';

// Input guards — mirrored server-side in process-article (the server is
// authoritative; these just keep the CTA honest before the round-trip).
const IMPORT_MIN_CHARS = 300;
const IMPORT_MAX_CHARS = 40_000;
const IMPORT_SOFT_WARN_CHARS = 20_000;
// Mirrors the server's PART_TARGET_CHARS for the live part estimate.
const PART_TARGET_CHARS = 10_000;
const estimateParts = (chars: number) => Math.max(1, Math.ceil(chars / PART_TARGET_CHARS));
// Part 1 is prepared in the background after an import; the list polls while
// one is on the way. A part 1 still missing or pending this long after the
// import (or retry) was handed off is treated as failed: a generation takes
// under a minute or two, and the server frees a stuck claim after 5 minutes.
const POLL_MS = 5000;
const PART_ONE_STALE_MS = 6 * 60_000;

type PartOneState = 'ready' | 'preparing' | 'failed';
function partOneState(work: LongFormWork, startedAt: number): PartOneState {
  if (work.partReady) return 'ready';
  const first = work.parts?.find((p) => p.index === 1);
  if (first?.status === 'failed') return 'failed';
  return Date.now() - startedAt > PART_ONE_STALE_MS ? 'failed' : 'preparing';
}

interface Props {
  /** Open a ready work in the Reader. The article is the processed part content;
   *  resumeBlockIndex pre-scrolls to the saved reading position (design §5). */
  onOpenWork: (work: LongFormWork, article: NewsArticle, resumeBlockIndex?: number) => void;
  /** 読む's ニュース | 本棚 title switch. */
  titleSwitch?: TitleSwitch;
}

async function resolveUserId(): Promise<string | null> {
  if (DEV_MODE) return 'dev-user';
  const { data: { session } } = await supabase.auth.getSession();
  return session?.user?.id ?? null;
}

/** Top-right of a work's card: the number of parts inside a ring that fills as the
 *  whole work is read (docs/mockups/progress-ring.html), closed once it's finished. */
export function PartCount({ work }: { work: LongFormWork }) {
  // Only a finished work closes the ring.
  const progress = work.status === 'finished' ? 1 : Math.min(0.97, work.readingPosition?.percent ?? 0);
  const part = work.status === 'finished'
    ? work.partCount
    : Math.min(work.readingPosition?.partIndex ?? 1, work.partCount);
  return <ProgressRing total={work.partCount} progress={progress} label={`${part} / ${work.partCount}部`} />;
}

// LIBRARY tab: works in ArchiveList — grouped by month, searchable, swipe to
// delete, long-press to select (mockup docs/mockups/archive-organize.html) —
// plus the import sheet behind +.

export function Library({ onOpenWork, titleSwitch }: Props) {
  // Last-loaded works show at once; the fetch below refreshes them.
  const [works, setWorks] = useState<LongFormWork[]>(() => readListCache<LongFormWork>('works') ?? []);
  const [isLoading, setIsLoading] = useState(() => readListCache('works') === null);
  const [sheetOpen, setSheetOpen] = useState(false);
  useScrollLock(sheetOpen);
  const [importTab, setImportTab] = useState<'paste' | 'url'>('paste');
  const [pasteText, setPasteText] = useState('');
  const [urlText, setUrlText] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  // Retries started this session: work id → when, so a retried work counts as
  // preparing again instead of stale by its original import time.
  const [retriedAt, setRetriedAt] = useState<Record<string, number>>({});
  const stateOf = useCallback(
    (w: LongFormWork) => partOneState(w, Math.max(new Date(w.createdAt).getTime(), retriedAt[w.id] ?? 0)),
    [retriedAt],
  );
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error]);

  const loadWorks = useCallback(async () => {
    try {
      const userId = await resolveUserId();
      if (!userId) return;
      const list = await fetchWorks(userId);
      if (mountedRef.current) setWorks(list);
    } catch (e) {
      console.error('[library] fetchWorks failed; keeping the cached list:', e);
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => { loadWorks(); }, [loadWorks]);
  // Poll while any work's part 1 is on the way, so it turns ready (or failed) on its own.
  const anyPreparing = works.some((w) => stateOf(w) === 'preparing');
  useEffect(() => {
    if (!anyPreparing) return;
    const t = setInterval(loadWorks, POLL_MS);
    return () => clearInterval(t);
  }, [anyPreparing, loadWorks]);
  // Imports and deletes change the list locally; keep the cache in step.
  useEffect(() => { if (!isLoading) writeListCache('works', works); }, [works, isLoading]);

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
      if (!mountedRef.current) return; // saved server-side; next visit shows it
      setPasteText('');
      setUrlText('');
      if (article) {
        // A server that still prepares part 1 inline: open it straight away.
        setWorks(prev => [{ ...work, partArticleId: article.id, partReady: true }, ...prev]);
        onOpenWork(work, article);
      } else {
        // Part 1 is being prepared in the background; its card polls to ready.
        setWorks(prev => [work, ...prev]);
      }
    } catch (e) {
      console.error('[library] import failed:', e);
      if (!mountedRef.current) return;
      setError(importErrorMessage(e));
      setSheetOpen(true); // the input is preserved — let them retry
    } finally {
      if (mountedRef.current) setIsImporting(false);
    }
  };

  const retryPartOne = async (work: LongFormWork) => {
    const userId = await resolveUserId();
    if (!userId) { setError('サインインが必要です。'); return; }
    setRetriedAt(prev => ({ ...prev, [work.id]: Date.now() }));
    // Drop the failed part from the local copy so the card reads 準備中 until the next poll.
    setWorks(prev => prev.map(w => (w.id === work.id ? { ...w, parts: (w.parts ?? []).filter(p => p.index !== 1) } : w)));
    try {
      await retryWorkPartInBackground(userId, work.id, 1);
    } catch (e) {
      console.error('[library] retry failed:', e);
      if (!mountedRef.current) return;
      setRetriedAt(prev => ({ ...prev, [work.id]: 0 }));
      setError(importErrorMessage(e));
    }
  };

  const handleOpen = async (work: LongFormWork) => {
    if (stateOf(work) === 'failed') { retryPartOne(work); return; }
    if (!work.partReady || !work.partArticleId || openingId) return;
    const userId = await resolveUserId();
    if (!userId) { setError('サインインが必要です。'); return; }
    setOpeningId(work.id);
    try {
      const opened = await fetchWorkResumeArticle(work, userId);
      if (!opened) { setError('この作品を読み込めませんでした。'); return; }
      onOpenWork(work, opened.article, opened.resumeBlock);
    } finally {
      if (mountedRef.current) setOpeningId(null);
    }
  };

  const handleDelete = useCallback(async (ids: string[]) => {
    await deleteWorks(ids);
    if (mountedRef.current) setWorks(prev => prev.filter(w => !ids.includes(w.id)));
  }, []);

  const loadSearchText = useCallback(async () => {
    const userId = await resolveUserId();
    if (!userId) return new Map();
    return fetchWorkSearchText(userId);
  }, []);

  const card = useCallback((work: LongFormWork): ArchiveCard => {
    const state = stateOf(work);
    return {
      status: openingId === work.id
        ? <span style={statusStyle}>{spinner()} 読み込み中</span>
        : state === 'ready'
          ? <PartCount work={work} />
          : state === 'failed'
            ? <span style={statusStyle}>失敗 · タップで再試行</span>
            : <span style={statusStyle}>{spinner()} 準備中</span>,
      title: work.title,
      // A failed card is tappable: the tap retries part 1.
      openable: state !== 'preparing',
    };
  }, [openingId, stateOf]);

  return (
    <>
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

      <ArchiveList
        titleId="library"
        titleSwitch={titleSwitch}
        onAdd={() => setSheetOpen(true)}
        addLabel="コンテンツを追加"
        items={works}
        isLoading={isLoading}
        createdAt={createdAtOf}
        card={card}
        loadSearchText={loadSearchText}
        isUnfinished={isUnread}
        unfinishedLabel="未読"
        unit="作品"
        onOpen={handleOpen}
        onDelete={handleDelete}
        memoryKey="library"
        leading={isImporting && (
          // In-flight import: a placeholder card while part 1 prepares.
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            style={{
              backgroundColor: 'var(--bg-card)',
              borderRadius: '24px',
              padding: '1.4rem 1.5rem',
              border: '1px solid var(--border-light)',
              position: 'relative',
              overflow: 'hidden',
              marginBottom: '2rem',
            }}
          >
            <motion.div
              initial={{ x: '-100%' }}
              animate={{ x: '0%' }}
              transition={{ duration: 20, ease: 'linear' }}
              style={{ position: 'absolute', bottom: 0, left: 0, height: '3px', width: '100%', backgroundColor: 'var(--accent-primary)' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.9rem' }}>
              <span style={{ fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.15em', backgroundColor: 'var(--bg-pure)', color: 'var(--text-muted)', padding: '0.3rem 0.7rem', borderRadius: '8px' }}>
                IMPORT
              </span>
              <span style={statusStyle}>{spinner()} 準備中</span>
            </div>
            <h3 className="serif" style={{ fontSize: '1.25rem', lineHeight: 1.5, color: 'var(--text-muted)', marginBottom: '0.8rem', maxWidth: '95%' }}>
              {importTab === 'url'
                ? (trimmedUrl.replace(/^https?:\/\//i, '').split('/')[0] || 'インポート')
                : (pasteText.trim().split('\n').find(l => l.trim())?.slice(0, 60) || 'インポート')}
            </h3>
            <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', fontWeight: 500 }}>
              あなたのレベルに合わせて書き直しています…
            </div>
          </motion.div>
        )}
        empty={
          <div style={{ textAlign: 'center', padding: '4rem 1rem', color: 'var(--text-muted)' }}>
            <h2 className="serif" style={{ fontSize: '1.4rem', marginBottom: '0.8rem', color: 'var(--text-main)' }}>まだ何もありません</h2>
            <p style={{ fontSize: '0.85rem', lineHeight: 1.7 }}>+ から英語のテキストを追加</p>
          </div>
        }
      />

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
    </>
  );
}

const createdAtOf = (w: LongFormWork) => w.createdAt;
const isUnread = (w: LongFormWork) => !!w.partReady && w.status !== 'finished' && !(w.readingPosition?.percent);

const statusStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.7rem', fontWeight: 800, color: 'var(--text-muted)', whiteSpace: 'nowrap',
};

const spinner = (size = 12) => (
  <div
    className="lucide-spin"
    style={{ width: size, height: size, border: '1.5px solid rgba(74, 93, 35, 0.2)', borderTopColor: '#4a5d23', borderRadius: '50%' }}
  />
);
