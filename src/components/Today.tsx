import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { BookOpen, ChevronRight, Headphones, Layers, Music, Newspaper } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { PageHeading } from './PageHeading';
import { TutorHomeCard } from './tutor/TutorHomeCard';
import { AdaptiveLabel, useAdaptiveText } from './AdaptiveLabel';
import { CardBody, CornerText } from './ArchiveList';
import { PartCount } from './Library';
import { useAppStore } from '../services/store';
import { buildDeck } from '../services/dueDeck';
import { buildKanjiDeck, useKanjiStore } from '../services/kanjiStore';
import { useGrammarStore } from '../services/grammarStore';
import { fetchWorkResumeArticle, fetchWorks } from '../services/api';
import type { LongFormWork, NewsArticle } from '../services/api';
import { fetchEpisodes } from '../services/podcasts';
import type { PodcastEpisode } from '../services/podcasts';
import { supabase } from '../services/supabase';
import { readListCache } from '../services/listCache';
import { fetchSongs } from '../services/songs';
import type { Song } from '../services/songs';
import { ALL_LIST_ID, lastPlayedListId, loadPlaylists, markListPlayed, usePlaylists } from '../services/playlists';
import { Collage, PlayCircle, coverOf, useCoverMap } from './MusicParts';

const DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true';

// Home (docs/mockups/home-today.html, home-music-polish.html): the tab the app
// opens on. What's waiting today, each block a shortcut into another tab rather
// than a copy of it: cards due, the work in progress, a new podcast, the list you
// last played, two news picks. Blocks with nothing to show are left out, so a quiet day is a short
// page. No stats or streaks — those stay in 進捗. The only settings mark in
// the app's tab pages sits on this heading.

/** The work the reader last opened, so 続きを読む picks the one they're in. */
export const LAST_WORK_KEY = 'yugen-last-work';
/** Works opened on this phone, so a new ハルカ long read stops being 新着 once opened. */
export const OPENED_WORKS_KEY = 'yugen-opened-works';
const NEW_WORK_DAYS = 7;

export function markWorkOpened(id: string) {
  try {
    const seen: string[] = JSON.parse(localStorage.getItem(OPENED_WORKS_KEY) ?? '[]');
    if (!seen.includes(id)) localStorage.setItem(OPENED_WORKS_KEY, JSON.stringify([id, ...seen].slice(0, 50)));
  } catch { /* storage blocked */ }
}

async function resolveUserId(): Promise<string | null> {
  if (DEV_MODE) return 'dev-user';
  const { data: { session } } = await supabase.auth.getSession();
  return session?.user?.id ?? null;
}

/** A long read ハルカ wrote that hasn't been opened yet (for a week), else the
 *  active, openable work with a reading position: the last opened, else the newest. */
function pickContinueWork(works: LongFormWork[]): { work: LongFormWork; fresh: boolean } | null {
  let lastId: string | null = null;
  let opened: string[] = [];
  try {
    lastId = localStorage.getItem(LAST_WORK_KEY);
    opened = JSON.parse(localStorage.getItem(OPENED_WORKS_KEY) ?? '[]');
  } catch { /* storage blocked */ }
  const fresh = works.find((w) => w.sourceType === 'haruka' && w.status === 'active' && w.partReady
    && !w.readingPosition && w.id !== lastId && !opened.includes(w.id)
    && Date.now() - Date.parse(w.createdAt) < NEW_WORK_DAYS * 86400_000);
  if (fresh) return { work: fresh, fresh: true };
  const inProgress = works.filter((w) => w.status === 'active' && w.partReady && (w.readingPosition?.percent ?? 0) > 0);
  const work = inProgress.find((w) => w.id === lastId) ?? inProgress[0] ?? null;
  return work ? { work, fresh: false } : null;
}

/** A ready podcast not yet listened to. */
const pickEpisode = (eps: PodcastEpisode[]) => eps.find((e) => e.status === 'ready' && !e.listened_at) ?? null;

interface RecentList { id: string; name: string; songs: Song[] }
/** The list last played here (すべての曲 included), else the last one added to; only lists with a ready song. */
function pickRecentList(lists: { id: string; name: string; song_ids: string[] }[], songs: Song[]): RecentList | null {
  const ready = new Map(songs.filter((s) => s.status === 'ready').map((s) => [s.id, s]));
  const withSongs = (l: { id: string; name: string; song_ids: string[] }): RecentList | null => {
    const queue = l.song_ids.map((id) => ready.get(id)).filter((s): s is Song => !!s);
    return queue.length ? { id: l.id, name: l.name, songs: queue } : null;
  };
  const lastId = lastPlayedListId();
  if (lastId === ALL_LIST_ID) return withSongs({ id: ALL_LIST_ID, name: 'すべての曲', song_ids: [...ready.keys()] });
  const last = lists.find((l) => l.id === lastId);
  return (last && withSongs(last)) ?? lists.map(withSongs).find((l) => l) ?? null;
}

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
  /** 聞く's 音楽 page (the 音楽 block's icon). */
  onShowMusic: () => void;
  /** Open a list's page on 音楽. */
  onOpenList: (listId: string) => void;
  /** Play `queue` from its first song, in the song player; `context` is the list's name. */
  onPlayList: (queue: Song[], context: string) => void;
  /** The top of the news feed (undismissed); 今日 shows the first two. */
  news: NewsArticle[];
}

export function Today({ onStartReview, onOpenWork, onOpenArticle, onShowNews, onShowLibrary, onShowShows, onOpenEpisode, onShowMusic, onOpenList, onPlayList, news }: Props) {
  // Cards due, recounted whenever the word database changes (a sync landing).
  const wordDatabase = useAppStore((s) => s.wordDatabase);
  const libraryLabel = useAdaptiveText('library');
  const grammarCards = useGrammarStore((s) => s.cards);
  const deck = useMemo(() => buildDeck(), [wordDatabase, grammarCards]); // eslint-disable-line react-hooks/exhaustive-deps
  // With an RTK kanji deck the card shows both counts (12 単語 · 3 漢字).
  const kanjiProgress = useKanjiStore((s) => s.progress);
  const hasKanji = Object.keys(kanjiProgress).length > 0;
  const kanjiDue = useMemo(() => buildKanjiDeck().length, [kanjiProgress]); // eslint-disable-line react-hooks/exhaustive-deps


  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Both blocks start from the lists 本棚 and 番組 last loaded, then refresh.
  const [picked, setPicked] = useState(() => pickContinueWork(readListCache<LongFormWork>('works') ?? []));
  const work = picked?.work ?? null;
  const [openingWork, setOpeningWork] = useState(false);
  useEffect(() => {
    resolveUserId()
      .then(async (userId) => {
        if (!userId) return;
        const works = await fetchWorks(userId);
        if (mountedRef.current) setPicked(pickContinueWork(works));
      })
      .catch((e) => console.warn('[today] works failed:', e));
  }, []);

  const [episode, setEpisode] = useState<PodcastEpisode | null>(() => pickEpisode(readListCache<PodcastEpisode>('episodes') ?? []));
  useEffect(() => {
    fetchEpisodes()
      .then((eps) => { if (mountedRef.current) setEpisode(pickEpisode(eps)); })
      .catch((e) => console.warn('[today] episodes failed:', e));
  }, []);

  // 音楽: the songs and lists 音楽 last loaded, then refreshed.
  const [songs, setSongs] = useState<Song[]>(() => readListCache<Song>('songs') ?? []);
  const { lists } = usePlaylists();
  useEffect(() => {
    fetchSongs()
      .then((list) => { if (mountedRef.current) setSongs(list); })
      .catch((e) => console.warn('[today] songs failed:', e));
    loadPlaylists();
  }, []);
  const recentList = pickRecentList(lists, songs);
  const listCovers = useCoverMap(recentList?.songs.slice(0, 4) ?? []);
  const listMinutes = recentList
    ? Math.max(1, Math.round(recentList.songs.reduce((n, s) => n + (s.duration_ms ?? s.minutes * 60_000), 0) / 60_000))
    : 0;
  const playList = () => {
    if (!recentList) return;
    markListPlayed(recentList.id);
    onPlayList(recentList.songs, recentList.name);
  };

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
      {/* ハルカ, pinned above the day's blocks: her line from last night's brief. */}
      <TutorHomeCard />

      {/* Blocks space 2rem apart; whichever shows first sits flush under the heading (index.css). */}
      <div className="today-blocks">
      {/* 復習 leads: the one time-sensitive thing, so it's the featured white card;
          with nothing due it's left out like any other empty block. */}
      {deck.length + kanjiDue > 0 && (
        <Section title="復習" icon={Layers} onOpen={onStartReview}>
          <button onClick={onStartReview} style={{ ...cardStyle, backgroundColor: 'var(--bg-pure)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', padding: '1.1rem 1.4rem' }}>
            {hasKanji ? (
              <span className="serif" style={{ display: 'flex', alignItems: 'baseline', gap: '1.1rem', fontSize: '1.8rem', fontWeight: 500, lineHeight: 1.15 }}>
                <span>{deck.length}<span style={{ fontSize: '0.85rem', marginLeft: '0.25rem', color: 'var(--text-muted)' }}>単語</span></span>
                <span>{kanjiDue}<span style={{ fontSize: '0.85rem', marginLeft: '0.25rem', color: 'var(--text-muted)' }}>漢字</span></span>
              </span>
            ) : (
              <span className="serif" style={{ fontSize: '1.8rem', fontWeight: 500, lineHeight: 1.15 }}>
                {deck.length}<span style={{ fontSize: '1rem', marginLeft: '0.15rem' }}>枚</span>
              </span>
            )}
            <span className="serif" style={{ fontSize: ACTION_SIZE, display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
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
                  : picked?.fresh ? <CornerText compact>新着</CornerText> : <PartCount work={work} />,
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
            <PlayCircle label="再生" />
          </button>
        </Section>
      )}

      {recentList && (
        <Section title="音楽" icon={Music} onOpen={onShowMusic}>
          {/* The row opens the list; the circle plays it from the top. */}
          <div
            role="button"
            tabIndex={0}
            onClick={() => onOpenList(recentList.id)}
            onKeyDown={(e) => { if (e.key === 'Enter') onOpenList(recentList.id); }}
            style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: '0.9rem', padding: '0.9rem 1.2rem 0.9rem 0.9rem' }}
          >
            <Collage urls={recentList.songs.slice(0, 4).map((s) => coverOf(s, listCovers))} size={58} radius={12} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="serif" style={{ ...titleStyle, ...twoLines }}>{recentList.name}</div>
              <div style={labelStyle}>{recentList.songs.length}曲 · 約{listMinutes}分</div>
            </div>
            <PlayCircle onClick={playList} label={`${recentList.name}を再生`} />
          </div>
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
// One type system on this page (docs/mockups/today-type.html, phone 2; sizes
// raised in home-music-polish.html): every item title one serif size at two
// lines max, one small sans label style, and one size for actions (始める,
// すべて). Matches CardBody/CornerText `compact`.
const ACTION_SIZE = '1.02rem';
const linkStyle: CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', fontSize: ACTION_SIZE, color: 'var(--text-muted)', padding: 0 };
const titleStyle: CSSProperties = { fontSize: '1.2rem', lineHeight: 1.5 };
const labelStyle: CSSProperties = { fontSize: '0.74rem', fontWeight: 700, letterSpacing: '0.06em', color: 'var(--text-muted)' };
const twoLines: CSSProperties = { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' };
/** The news list's inset: the cards' text edge (their 1.5rem padding). */
const NEWS_INSET = '1.5rem';
