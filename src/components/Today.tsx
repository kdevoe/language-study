import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { ChevronRight, Play } from 'lucide-react';
import { PageHeading } from './PageHeading';
import { CardBody } from './ArchiveList';
import { WordModal } from './WordModal';
import { useWordLookup } from '../hooks/useWordLookup';
import { useAppStore } from '../services/store';
import { buildDeck } from '../services/dueDeck';
import { rtkKanjiList, rtkKanjiMap } from '../data/rtkKanji';
import { fetchWorkResumeArticle, fetchWorks } from '../services/api';
import type { LongFormWork, NewsArticle } from '../services/api';
import { fetchEpisodes } from '../services/podcasts';
import type { PodcastEpisode } from '../services/podcasts';
import { supabase } from '../services/supabase';

const DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true';

// 今日 (docs/mockups/home-today.html): the tab the app opens on. What's waiting
// today, each block a shortcut into another tab rather than a copy of it:
// cards due, the work in progress, today's kanji, a new podcast, two news
// picks. Blocks with nothing to show are left out, so a quiet day is a short
// page. No stats or streaks — those stay in 進捗. The only settings mark in
// the app's tab pages sits on this heading.

/** The work the reader last opened, so 続きを読む picks the one they're in. */
export const LAST_WORK_KEY = 'yugen-last-work';

async function resolveUserId(): Promise<string | null> {
  if (DEV_MODE) return 'dev-user';
  const { data: { session } } = await supabase.auth.getSession();
  return session?.user?.id ?? null;
}

/** The active, openable work with a reading position: the last opened, else the newest. */
function pickContinueWork(works: LongFormWork[]): LongFormWork | null {
  const inProgress = works.filter((w) => w.status === 'active' && w.partReady && (w.readingPosition?.percent ?? 0) > 0);
  let lastId: string | null = null;
  try { lastId = localStorage.getItem(LAST_WORK_KEY); } catch { /* storage blocked */ }
  return inProgress.find((w) => w.id === lastId) ?? inProgress[0] ?? null;
}

interface Props {
  onStartReview: () => void;
  onOpenWork: (work: LongFormWork, article: NewsArticle, resumeBlockIndex?: number) => void;
  onOpenArticle: (article: NewsArticle) => void;
  onShowNews: () => void;
  onOpenEpisode: (episode: PodcastEpisode) => void;
  /** The top of the news feed (undismissed); 今日 shows the first two. */
  news: NewsArticle[];
}

export function Today({ onStartReview, onOpenWork, onOpenArticle, onShowNews, onOpenEpisode, news }: Props) {
  // Cards due, recounted whenever the word database changes (a sync landing).
  const wordDatabase = useAppStore((s) => s.wordDatabase);
  const deck = useMemo(() => buildDeck(), [wordDatabase]); // eslint-disable-line react-hooks/exhaustive-deps
  const newCount = deck.filter((c) => c.kind === 'new').length;

  const rtkLevel = useAppStore((s) => s.rtkLevel);
  const kanji = rtkLevel ? rtkKanjiList.slice(Math.max(0, rtkLevel - 3), rtkLevel) : [];
  const lookup = useWordLookup();

  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const [work, setWork] = useState<LongFormWork | null>(null);
  const [openingWork, setOpeningWork] = useState(false);
  useEffect(() => {
    resolveUserId().then(async (userId) => {
      if (!userId) return;
      const works = await fetchWorks(userId);
      if (mountedRef.current) setWork(pickContinueWork(works));
    });
  }, []);

  const [episode, setEpisode] = useState<PodcastEpisode | null>(null);
  useEffect(() => {
    fetchEpisodes()
      .then((eps) => { if (mountedRef.current) setEpisode(eps.find((e) => e.status === 'ready' && !e.listened_at) ?? null); })
      .catch((e) => console.warn('[today] episodes failed:', e));
  }, []);

  const openWork = async () => {
    if (!work || openingWork) return;
    const userId = await resolveUserId();
    if (!userId) return;
    setOpeningWork(true);
    try {
      const opened = await fetchWorkResumeArticle(work, userId);
      if (opened) onOpenWork(work, opened.article, opened.resumeBlock);
    } finally {
      if (mountedRef.current) setOpeningWork(false);
    }
  };

  const picks = news.slice(0, 2);
  const dot = <span style={{ margin: '0 0.35rem', opacity: 0.5 }}>·</span>;

  return (
    <div style={{ paddingBottom: '6rem' }}>
      <PageHeading id="today" />
      <div style={{ height: '0.6rem' }} />

      {/* 復習 leads: the one time-sensitive thing, so it's the featured white card. */}
      {deck.length > 0 ? (
        <button onClick={onStartReview} style={{ ...cardStyle, backgroundColor: 'var(--bg-pure)', padding: '1.5rem 1.5rem 1.4rem' }}>
          <div style={kickerStyle}>復習</div>
          <div className="serif" style={{ fontSize: '2.6rem', fontWeight: 500, lineHeight: 1.2, margin: '0.35rem 0 0.2rem' }}>
            {deck.length}<span style={{ fontSize: '1.1rem', marginLeft: '0.2rem' }}>枚</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.9rem' }}>
            <span style={metaStyle}>新 {newCount}{dot}復習 {deck.length - newCount}</span>
            <span className="serif" style={{ fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
              始める<ChevronRight size={18} strokeWidth={1.5} />
            </span>
          </div>
        </button>
      ) : (
        <div style={{ ...cardStyle, textAlign: 'center', padding: '1.8rem 1rem 1.6rem', cursor: 'default' }}>
          <div className="serif" style={{ fontSize: '1.35rem' }}>何もありません</div>
          <p style={{ ...metaStyle, fontSize: '0.8rem', marginTop: '0.2rem' }}>Nothing due today.</p>
          <button onClick={onStartReview} className="serif" style={{ ...linkStyle, marginTop: '0.8rem' }}>新しい言葉を探す</button>
        </div>
      )}

      {work && (
        <Section title="続きを読む">
          <button onClick={openWork} style={{ display: 'block', width: '100%', padding: 0, border: 'none', background: 'none', textAlign: 'left', font: 'inherit', color: 'inherit', cursor: 'pointer' }}>
            <CardBody
              selecting={false}
              selected={false}
              query=""
              card={{
                tag: work.sourceType === 'magazine' ? 'MAGAZINE' : work.originUrl ? 'IMPORT · URL' : 'IMPORT',
                status: (
                  <span className="serif" style={{ fontSize: '0.8rem', fontWeight: 600, color: openingWork ? 'var(--text-muted)' : '#4a5d23', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>
                    {openingWork ? '読み込み中' : `第${Math.min(work.readingPosition!.partIndex, work.partCount)}部・全${work.partCount}部`}
                  </span>
                ),
                title: work.title,
                meta: <>約{work.charCount.toLocaleString()}字{dot}全{work.partCount}部</>,
                progress: work.readingPosition?.percent ?? 0,
                openable: true,
              }}
            />
          </button>
        </Section>
      )}

      {kanji.length > 0 && (
        <Section title="今日の漢字" aside={`RTK ${rtkLevel! - kanji.length + 1}–${rtkLevel}`}>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${kanji.length}, 1fr)`, gap: '0.7rem' }}>
            {kanji.map((k) => (
              <button
                key={k}
                onClick={(e) => lookup.lookupWord(k, `${k} — one of today's new RTK kanji (${rtkKanjiMap[k] ?? ''})`, e, `today-kanji-${k}`)}
                style={{ ...cardStyle, borderRadius: '18px', padding: '0.9rem 0.4rem 0.7rem', textAlign: 'center' }}
              >
                <div className="serif" style={{ fontSize: '2rem', lineHeight: 1.2 }}>{k}</div>
                <div style={{ ...metaStyle, fontSize: '0.68rem' }}>{rtkKanjiMap[k] ?? ''}</div>
              </button>
            ))}
          </div>
        </Section>
      )}

      {episode && (
        <Section title="聞く">
          <button onClick={() => onOpenEpisode(episode)} style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: '0.9rem', padding: '1rem 1.2rem' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="serif" style={{ fontSize: '1rem', lineHeight: 1.45 }}>{episode.title}</div>
              <div style={metaStyle}>新しいポッドキャスト{dot}{Math.max(1, Math.round((episode.duration_ms ?? episode.minutes * 60_000) / 60_000))}分</div>
            </div>
            <span style={{ width: 40, height: 40, borderRadius: '50%', backgroundColor: 'var(--bg-pure)', boxShadow: '0 2px 8px rgba(0,0,0,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
              <Play size={16} strokeWidth={0} fill="var(--text-main)" style={{ marginLeft: 2 }} />
            </span>
          </button>
        </Section>
      )}

      {picks.length > 0 && (
        <Section
          title="ニュース"
          aside={<button onClick={onShowNews} className="serif" style={{ ...linkStyle, display: 'flex', alignItems: 'center', gap: '0.15rem' }}>すべて<ChevronRight size={15} strokeWidth={1.5} /></button>}
        >
          {/* Typography only: the full cards live in 読む. */}
          {picks.map((a, i) => (
            <button
              key={a.id}
              onClick={() => onOpenArticle(a)}
              style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', borderTop: i ? '1px solid var(--border-light)' : 'none', padding: i ? '0.85rem 0' : '0.2rem 0 0.85rem', cursor: 'pointer', color: 'var(--text-main)' }}
            >
              <div className="serif" style={{ fontSize: '1.05rem', lineHeight: 1.5, marginBottom: '0.2rem' }}>{a.title}</div>
              <div style={metaStyle}>{a.category?.toUpperCase()}{a.readTime && <>{dot}{a.readTime}</>}</div>
            </button>
          ))}
        </Section>
      )}

      <WordModal {...lookup.modalProps} />
    </div>
  );
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', margin: '2rem 0 0.75rem' }}>
        <span style={kickerStyle}>{title}</span>
        {typeof aside === 'string' ? <span style={metaStyle}>{aside}</span> : aside}
      </div>
      {children}
    </section>
  );
}

// Cards follow design-system §6.5.
const cardStyle: CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', font: 'inherit', color: 'var(--text-main)',
  backgroundColor: 'var(--bg-card)', borderRadius: '24px', border: '1px solid var(--border-light)',
  boxShadow: '0 4px 25px rgba(0,0,0,0.03)', cursor: 'pointer',
};
const kickerStyle: CSSProperties = { fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.08em', color: 'var(--text-muted)' };
const metaStyle: CSSProperties = { fontSize: '0.74rem', color: 'var(--text-muted)', fontWeight: 500 };
const linkStyle: CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.88rem', color: 'var(--text-muted)', padding: 0 };
