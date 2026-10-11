import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check } from 'lucide-react';
import { useScrollLock } from '../hooks/useScrollLock';
import {
  fetchWorkParts,
  isPartInProgressError,
  requestWorkPart,
  type WorkPartSummary,
  type WorkReadingPosition,
} from '../services/api';
import { useAppStore } from '../services/store';

// 目次: a long-form work's parts (mockup docs/mockups/longform-section-nav.html,
// design-system.md §6.11). Opened from the Reader's 第N部 indicator.
// Parts generate in order — each needs the previous part's continuity — so
// only the first part that doesn't exist yet can be started (準備する); the
// ones after it are faded and inert. The しおり is the furthest point read.

const EASE = '0.4s cubic-bezier(0.4, 0, 0.2, 1)';

type RowState = 'ready' | 'pending' | 'failed' | 'startable' | 'locked';

interface Props {
  open: boolean;
  onClose: () => void;
  userId: string | null;
  workId: string;
  workTitle: string;
  partIndex: number;
  partCount: number;
  bookmark: WorkReadingPosition | null;
  /** The Reader owns preparing the part right after the open one (its section
   *  break shows the same state), so the sheet hands that one back. */
  nextPartState: 'idle' | 'preparing' | 'ready' | 'failed';
  onPrepareNext: () => void;
  /** Open a ready part; `resume` = pick up at the しおり block. */
  onOpenPart: (index: number, resume: boolean) => void;
}

export function PartsSheet({
  open, onClose, userId, workId, workTitle, partIndex, partCount, bookmark,
  nextPartState, onPrepareNext, onOpenPart,
}: Props) {
  useScrollLock(open);
  const [parts, setParts] = useState<WorkPartSummary[] | null>(null);
  // Parts this sheet started (beyond the Reader's next part), until they land.
  const [preparing, setPreparing] = useState<Record<number, 'pending' | 'failed'>>({});
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const load = useCallback(async () => {
    if (!userId) return;
    try {
      const rows = await fetchWorkParts(workId, userId);
      if (mountedRef.current) setParts(rows);
    } catch (e) {
      console.warn('[PartsSheet] part list failed:', e);
    }
  }, [userId, workId]);

  // Refresh on every open: parts change while reading (JIT, other devices).
  useEffect(() => { if (open) load(); }, [open, load]);
  // The Reader's next part landing changes that row; pick it up.
  useEffect(() => { if (open && nextPartState === 'ready') load(); }, [open, nextPartState, load]);

  const prepare = async (index: number) => {
    if (index === partIndex + 1) { onPrepareNext(); return; }
    if (!userId) return;
    setPreparing((p) => ({ ...p, [index]: 'pending' }));
    const attempt = async (triesLeft: number): Promise<void> => {
      try {
        const article = await requestWorkPart(userId, workId, index);
        useAppStore.getState().saveProcessedArticle(article.id, article);
        if (!mountedRef.current) return;
        setPreparing((p) => { const n = { ...p }; delete n[index]; return n; });
        load();
      } catch (e) {
        if (isPartInProgressError(e) && triesLeft > 0) {
          setTimeout(() => attempt(triesLeft - 1), 6000);
          return;
        }
        console.warn('[PartsSheet] part preparation failed:', e);
        if (mountedRef.current) setPreparing((p) => ({ ...p, [index]: 'failed' }));
      }
    };
    attempt(20);
  };

  const byIndex = new Map((parts ?? []).map((p) => [p.index, p]));
  const stateOf = (i: number): RowState => {
    if (i === partIndex) return 'ready';
    if (i === partIndex + 1) {
      if (nextPartState === 'ready') return 'ready';
      if (nextPartState === 'preparing') return 'pending';
      if (nextPartState === 'failed') return 'failed';
    }
    const local = preparing[i];
    if (local) return local;
    const row = byIndex.get(i);
    if (row) return row.status === 'pending' ? 'pending' : row.status === 'failed' ? 'failed' : 'ready';
    // Missing: startable only right after an existing, ready part.
    const prev = byIndex.get(i - 1);
    const prevReady = i - 1 === partIndex || (!!prev && prev.status !== 'pending' && prev.status !== 'failed');
    return prevReady ? 'startable' : 'locked';
  };

  const furthest = bookmark?.partIndex ?? partIndex;
  const percent = Math.round(Math.min(1, bookmark?.percent ?? (partIndex - 1) / partCount) * 100);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="parts-sheet-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(45,45,45,0.35)', zIndex: 40 }}
          />
          <motion.div
            key="parts-sheet"
            role="dialog"
            aria-label="目次"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 400, damping: 40 }}
            style={{
              position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 50, backgroundColor: 'var(--bg-color)',
              borderRadius: '28px 28px 0 0', padding: '1.5rem 1.5rem calc(2.2rem + env(safe-area-inset-bottom))',
              boxShadow: '0 -10px 40px rgba(0,0,0,0.15)', maxWidth: '600px', margin: '0 auto',
              maxHeight: '82vh', display: 'flex', flexDirection: 'column',
            }}
          >
            <div style={{ width: '36px', height: '4px', borderRadius: '2px', backgroundColor: 'var(--border-light)', margin: '0 auto 1.2rem', flexShrink: 0 }} />

            <div style={{ marginBottom: '1.5rem', flexShrink: 0 }}>
              <h2 className="serif" style={{ fontSize: '1.3rem', fontWeight: 600, lineHeight: 1.45, color: 'var(--text-main)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {workTitle}
              </h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', marginTop: '0.8rem', fontSize: '0.72rem', fontWeight: 500, color: 'var(--text-muted)' }}>
                <span>全{partCount}部</span>
                <div style={{ flex: 1, height: '3px', borderRadius: '3px', backgroundColor: 'var(--border-light)', overflow: 'hidden' }}>
                  <div style={{ width: `${percent}%`, height: '100%', borderRadius: '3px', backgroundColor: 'var(--accent-progress)', transition: `width ${EASE}` }} />
                </div>
                <span>{percent}%</span>
              </div>
            </div>

            <ul style={{ listStyle: 'none', margin: '0 -0.6rem', padding: '0 0.6rem', overflowY: 'auto' }}>
              {Array.from({ length: partCount }, (_, k) => k + 1).map((i) => {
                const state = stateOf(i);
                const isCurrent = i === partIndex;
                const isMark = i === furthest;
                const isRead = i < furthest;
                const opening = byIndex.get(i)?.opening ?? '';
                const tappable = state === 'ready' || state === 'startable' || state === 'failed';
                const onTap = () => {
                  if (state === 'ready') { if (isCurrent) onClose(); else onOpenPart(i, isMark); }
                  else if (state === 'startable' || state === 'failed') prepare(i);
                };

                let right: React.ReactNode = null;
                if (state === 'pending') right = <><Spinner />準備中</>;
                else if (state === 'failed') right = <span style={{ backgroundColor: 'var(--accent-danger)', color: 'var(--text-main)', padding: '0.15rem 0.6rem', borderRadius: '100px' }}>もう一度</span>;
                else if (state === 'startable') right = '準備する';
                else if (isMark) right = <><Dot />{isCurrent ? '読書中' : 'しおり'}</>;
                else if (isCurrent) right = '読書中';
                else if (isRead) right = <Check size={15} strokeWidth={1.5} />;

                return (
                  <li key={i}>
                    <button
                      onClick={tappable ? onTap : undefined}
                      disabled={!tappable}
                      aria-current={isCurrent ? 'true' : undefined}
                      style={{
                        width: '100%', display: 'flex', alignItems: 'center', gap: '1rem', textAlign: 'left',
                        padding: '0.85rem 1rem', marginBottom: '0.25rem', border: 'none', borderRadius: '16px',
                        cursor: tappable ? 'pointer' : 'default', opacity: state === 'locked' ? 0.42 : 1,
                        backgroundColor: isCurrent ? 'var(--bg-pure)' : 'transparent',
                        boxShadow: isCurrent ? '0 2px 8px rgba(0,0,0,0.1)' : 'none',
                        color: 'var(--text-main)', transition: `background-color ${EASE}, box-shadow ${EASE}`,
                      }}
                    >
                      <span style={{ width: '2.6rem', flexShrink: 0, fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.06em', color: isCurrent ? 'var(--text-main)' : 'var(--text-muted)' }}>
                        第{i}部
                      </span>
                      <span className="serif" style={{ flex: 1, minWidth: 0, fontSize: '1.02rem', fontWeight: 500, lineHeight: 1.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: isRead && !isCurrent ? 'var(--text-muted)' : 'var(--text-main)' }}>
                        {state === 'ready' || state === 'pending' ? opening : ''}
                      </span>
                      <span style={{ flexShrink: 0, marginLeft: '0.4rem', display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.72rem', fontWeight: 500, color: isCurrent ? 'var(--text-main)' : 'var(--text-muted)' }}>
                        {right}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function Dot() {
  return <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: 'var(--accent-progress)', display: 'inline-block' }} />;
}

function Spinner() {
  return <span className="lucide-spin" style={{ width: '12px', height: '12px', border: '1.5px solid var(--border-light)', borderTopColor: 'var(--text-muted)', borderRadius: '50%', display: 'inline-block' }} />;
}
