import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { BookOpen, ChevronRight, Headphones, Layers, Newspaper, Play } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { PageHeading } from './PageHeading';
import { AdaptiveLabel, useAdaptiveText } from './AdaptiveLabel';
import { CardBody, CornerText } from './ArchiveList';
import { PartCount } from './Library';
import { useAppStore } from '../services/store';
import { buildDeck } from '../services/dueDeck';
import { fetchWorkResumeArticle, fetchWorks } from '../services/api';
import type { LongFormWork, NewsArticle } from '../services/api';
import { fetchEpisodes } from '../services/podcasts';
import type { PodcastEpisode } from '../services/podcasts';
import { supabase } from '../services/supabase';
import { readListCache } from '../services/listCache';

const DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true';

// 今日 (docs/mockups/home-today.html): the tab the app opens on. What's waiting
// today, each block a shortcut into another tab rather than a copy of it:
// cards due, the work in progress, a new podcast, two news picks. Blocks with nothing to show are left out, so a quiet day is a short
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

/** A ready podcast not yet listened to. */
const pickEpisode = (eps: PodcastEpisode[]) => eps.find((e) => e.status === 'ready' && !e.listened_at) ?? null;

interface Props {
  onStartReview: () => void;
  onOpenWork: (work: LongFormWork, article: NewsArticle, resumeBlockIndex?: number) => void;
  onOpenArticle: (article: NewsArticle) => void;
  onShowNews: () => void;
  /** 読む's 本棚 page (the 本棚 block's icon). */
  onShowLibrary: () => void;
  /** 聞く's 番組 page (the 聞く block's icon). */
  onShowShows: () => void;
  onOpenEpisode: (episode: PodcastEpisode) => void;
  /** The top of the news feed (undismissed); 今日 shows the first two. */
  news: NewsArticle[];
}

export function Today({ onStartReview, onOpenWork, onOpenArticle, onShowNews, onShowLibrary, onShowShows, onOpenEpisode, news }: Props) {
  // Cards due, recounted whenever the word database changes (a sync landing).
  const wordDatabase = useAppStore((s) => s.wordDatabase);
  const libraryLabel = useAdaptiveText('library');
  const deck = useMemo(() => buildDeck(), [wordDatabase]); // eslint-disable-line react-hooks/exhaustive-deps


  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Both blocks start from the lists 本棚 and 番組 last loaded, then refresh.
  const [work, setWork] = useState<LongFormWork | null>(() => pickContinueWork(readListCache<LongFormWork>('works') ?? []));
  const [openingWork, setOpeningWork] = useState(false);
  useEffect(() => {
    resolveUserId()
      .then(async (userId) => {
        if (!userId) return;
        const works = await fetchWorks(userId);
        if (mountedRef.current) setWork(pickContinueWork(works));
      })
      .catch((e) => console.warn('[today] works failed:', e));
  }, []);

  const [episode, setEpisode] = useState<PodcastEpisode | null>(() => pickEpisode(readListCache<PodcastEpisode>('episodes') ?? []));
  useEffect(() => {
    fetchEpisodes()
      .then((eps) => { if (mountedRef.current) setEpisode(pickEpisode(eps)); })
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

  return (
    <div style={{ paddingBottom: '6rem' }}>
      <PageHeading id="today" />
      <div style={{ height: '0.6rem' }} />

      {/* Blocks space 2rem apart; whichever shows first sits flush under the heading (index.css). */}
      <div className="today-blocks">
      {/* 復習 leads: the one time-sensitive thing, so it's the featured white card;
          with nothing due it's left out like any other empty block. */}
      {deck.length > 0 && (
        <Section title="復習" icon={Layers} onOpen={onStartReview}>
          <button onClick={onStartReview} style={{ ...cardStyle, backgroundColor: 'var(--bg-pure)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', padding: '1.1rem 1.4rem' }}>
            <span className="serif" style={{ fontSize: '1.8rem', fontWeight: 500, lineHeight: 1.15 }}>
              {deck.length}<span style={{ fontSize: '1rem', marginLeft: '0.15rem' }}>枚</span>
            </span>
            <span className="serif" style={{ fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
              始める<ChevronRight size={18} strokeWidth={1.5} />
            </span>
          </button>
        </Section>
      )}

      {work && (
        <Section title={libraryLabel} icon={BookOpen} onOpen={onShowLibrary}>
          <button onClick={openWork} style={{ display: 'block', width: '100%', padding: 0, border: 'none', background: 'none', textAlign: 'left', font: 'inherit', color: 'inherit', cursor: 'pointer' }}>
            <CardBody
              compact
              selecting={false}
              selected={false}
              query=""
              card={{
                status: openingWork
                  ? <CornerText compact>読み込み中</CornerText>
                  : <PartCount work={work} compact />,
                title: work.title,
                openable: true,
              }}
            />
          </button>
        </Section>
      )}

      {episode && (
        <Section title="聞く" icon={Headphones} onOpen={onShowShows}>
          <button onClick={() => onOpenEpisode(episode)} style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: '0.9rem', padding: '1rem 1.2rem' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="serif" style={{ ...titleStyle, ...twoLines }}>{episode.title}</div>
              <div style={labelStyle}><AdaptiveLabel id="shows" /></div>
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
          icon={Newspaper}
          onOpen={onShowNews}
          aside={<button onClick={onShowNews} className="serif" style={{ ...linkStyle, display: 'flex', alignItems: 'center', gap: '0.15rem', marginRight: NEWS_INSET }}>すべて<ChevronRight size={15} strokeWidth={1.5} /></button>}
        >
          {/* Typography only — the full cards live in 読む. A kicker line over a
              two-line headline, with air between picks, so they don't run
              together into a block of text. Inset to the cards' text edge. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.4rem', padding: `0.2rem ${NEWS_INSET} 0` }}>
            {picks.map((a) => (
              <button
                key={a.id}
                onClick={() => onOpenArticle(a)}
                style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-main)' }}
              >
                <span style={{ ...labelStyle, display: 'block', marginBottom: '0.35rem' }}>
                  {a.category?.toUpperCase()}
                </span>
                <span className="serif" style={{ ...titleStyle, ...twoLines }}>
                  {a.title}
                </span>
              </button>
            ))}
          </div>
        </Section>
      )}

      </div>

    </div>
  );
}

/** A block's label: just the tab's icon, which opens that block's page; the
 *  title is its accessible name. */
function Section({ title, icon: Icon, onOpen, aside, children }: { title: string; icon: LucideIcon; onOpen: () => void; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="today-section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <span role="heading" aria-level={2} style={{ display: 'flex' }}>
          {/* Padded to a ~40px tap target; the negative margin keeps the icon where it was. */}
          <button onClick={onOpen} aria-label={title} style={{ display: 'flex', padding: '10px', margin: '-10px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
            <Icon size={19} strokeWidth={1.8} aria-hidden />
          </button>
        </span>
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
const metaStyle: CSSProperties = { fontSize: '0.74rem', color: 'var(--text-muted)', fontWeight: 500 };
const linkStyle: CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.95rem', color: 'var(--text-muted)', padding: 0 };
// One type system on this page (docs/mockups/today-type.html, phone 2): every
// item title one serif size at two lines max, one small sans label style, and
// 0.95rem for actions (始める, すべて). Matches CardBody/CornerText `compact`.
const titleStyle: CSSProperties = { fontSize: '1.05rem', lineHeight: 1.5 };
const labelStyle: CSSProperties = { fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.06em', color: 'var(--text-muted)' };
const twoLines: CSSProperties = { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' };
/** The news list's inset: the cards' text edge (their 1.5rem padding). */
const NEWS_INSET = '1.5rem';
