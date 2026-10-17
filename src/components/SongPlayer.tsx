import { useCallback, useEffect, useRef, useState } from 'react';
import { ListCheck, ListPlus, Pause, Play } from 'lucide-react';
import { FuriganaText, HitWeight } from './FuriganaText';
import { WordModal, WordDetails } from './WordModal';
import { SkipIcon } from './PodcastPlayer';
import type { ArticleBlock } from '../services/api';
import { enrichArticle } from '../services/enrich';
import { useWordLookup } from '../hooks/useWordLookup';
import { useAppStore, type MasteryLevel } from '../services/store';
import { canonicalWordKey } from '../services/wordKey';
import { Song, SongFull, coverUrls, fetchSong, recordPlay, songFileUrl } from '../services/songs';
import { styleLabel } from '../data/songStyles';
import { isUnlockClip, sharedAudio } from '../services/sharedAudio';
import { cachedAudioUrl, saveAudio } from '../services/audioCache';
import { AddToListSheet } from './AddToListSheet';
import { coverOf, useCoverMap } from './MusicParts';
import { usePlaylists } from '../services/playlists';
import { useTutorScreen } from './tutor/TutorProvider';

// Song player (mockup docs/mockups/lyrics.html, phone B 霧): the whole player
// sits on soft blue (body.song-mode). Cover, title and style open big; as the
// page scrolls they shrink into the back row and pin there. Lyrics are bold
// serif in two colours: everything sung so far in charcoal, what's still to
// come in pale ink (.song-line.sung); ♪ marks the gap between sections. The page
// scrolls itself to keep the sung line ~40% down until the listener scrolls
// away (↓ 再生位置へ re-syncs). Tapping a word pauses and opens its card. Line
// times come from ElevenLabs' phrase timestamps (songs.timing); a line with no
// match stays with the line before it. Plays on the app's shared audio element,
// which the opening tap unlocked, and keeps a copy on the device (audioCache).
// The transport is the podcast player's; リピート cycles off → 1曲 → 全部.
//
// Queue (mockups docs/mockups/music-playlists.html, music-lists.html): the song
// was started from the grid or a list, and when it ends the next one follows
// after a short handoff (its cover, a 3s ring, 止める to stay). The lyrics end
// with 次の曲 (the next song, the one after fainter; tap to jump). The back row
// carries the position (3 / 8) and the リストに追加 icon, which darkens once the
// song is in a list. Playing from a list, its name replaces the style label.

const SPEEDS = [0.75, 0.9, 1];
const HANDOFF_S = 3;
type Repeat = 'off' | 'one' | 'all';
const REPEAT_LABEL: Record<Repeat, string> = { off: 'リピート', one: '1曲', all: '全部' };
const NEXT_REPEAT: Record<Repeat, Repeat> = { off: 'one', one: 'all', all: 'off' };
// The queue's リピート outlives each song's player (each song remounts it).
let sessionRepeat: Repeat = 'off';

// The next song in the queue, loaded ahead while this one plays.
interface Prepared { songId: string; full: SongFull; url: string; blob: boolean }
// A song the outgoing player already started on the shared element. Locked
// or in the background, iOS suspends the page as soon as audio stops, so the
// usual hand-off (unmount, fetch the next song, sign its URL, then play) never
// finished and the queue stopped after one song. Instead the outgoing player
// swaps the prepared source in and plays it inside the 'ended' event, and the
// next player adopts the element as it is (no reset, no reload).
let carried: Prepared | null = null;
const SKIP_S = 10;
const SCROLL_ANCHOR = 0.4;
const MIST = '#d4e0e8'; // --accent-primary, for the browser chrome (theme-color)
// Header morph: open (big cover, title under it) → pinned (thumb + title in the back row).
const THUMB = 40;
const ROW_ACTIONS_W = 104; // the back row's right end: リストに追加 + position
const smooth = (k: number) => { const x = Math.min(1, Math.max(0, k)); return x * x * (3 - 2 * x); };
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

interface Token {
  text: string;
  furigana?: string;
  isInteractive?: boolean;
  lemma?: string;
  details?: WordDetails;
  jmdict_entry_id?: string;
}

function hitWeightFor(text: string, furigana?: string, mastery?: MasteryLevel): HitWeight {
  const hasKanji = !!furigana && furigana.trim() !== '';
  if (hasKanji) return mastery === 'easy' ? 'mid' : 'hi';
  return [...text].length <= 2 ? 'lo' : 'mid';
}

const fmt = (s: number) => {
  const v = Math.max(0, Math.floor(s));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
};

interface Props {
  song: Song;
  /** The songs being played through, in order (includes `song`). */
  queue?: Song[];
  /** Where the queue came from (a list's name), shown in place of the style. */
  context?: string | null;
  /** Move to another song in the queue; `byTap` when the reader chose it. */
  onPlaySong?: (song: Song, byTap: boolean) => void;
}

export function SongPlayer({ song: initial, queue = [initial], context = null, onPlaySong }: Props) {
  const [song, setSong] = useState<SongFull | null>(null);
  const [blocks, setBlocks] = useState<ArticleBlock[] | null>(null);
  const [cover, setCover] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [repeat, setRepeatState] = useState<Repeat>(sessionRepeat);
  const setRepeat = (r: Repeat) => { sessionRepeat = r; setRepeatState(r); };
  const [handoff, setHandoff] = useState<{ next: Song; left: number } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const { lists } = usePlaylists();
  const inList = lists.some((l) => l.song_ids.includes(initial.id));
  const index = Math.max(0, queue.findIndex((s) => s.id === initial.id));
  const upNext = [queue[index + 1], queue[index + 2]].filter((s): s is Song => !!s);
  const nextSong: Song | null = queue[index + 1] ?? (repeat === 'all' && queue.length > 1 ? queue[0] : null);
  const queueCovers = useCoverMap([initial, ...upNext, ...(nextSong ? [nextSong] : [])]);
  const [now, setNow] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);

  const audioRef = useRef<HTMLAudioElement | null>(sharedAudio());
  const autoplayed = useRef(false);
  const counted = useRef(false);
  const lyricsRef = useRef<HTMLDivElement | null>(null);
  // Every lyric row (lines and ♪ gaps) in page order; t is NaN for untimed rows.
  const linesRef = useRef<{ t: number; el: HTMLElement }[]>([]);
  const curLineRef = useRef<HTMLElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const coverRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLDivElement | null>(null);
  const [geo, setGeo] = useState<{ top: number; left: number; width: number; cover: number } | null>(null);
  const autoScrollRef = useRef(true);
  const programmaticScrollUntil = useRef(0);
  const resumeAfterModal = useRef(false);
  const prepared = useRef<Prepared | null>(null);

  // ハルカ sees the song and the line being sung.
  useTutorScreen(() => {
    const line = curLineRef.current?.textContent?.trim() ?? '';
    const title = initial.title || '曲';
    return {
      screen: 'song',
      chip: line ? `${title} · 「${line.length > 10 ? `${line.slice(0, 10)}…` : line}」` : title,
      detail: `They are listening to the song "${title}" (song id ${initial.id}).${line ? ` The line being sung: 「${line}」` : ''}`,
    };
  });

  const wordDatabase = useAppStore((s) => s.wordDatabase);
  const lookup = useWordLookup();
  autoScrollRef.current = autoScroll;

  // ── Load song, cover, audio and tokens ──
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    // Adopt a song the previous player already started (see `carried`).
    const carry = carried?.songId === initial.id ? carried : null;
    carried = null;
    (async () => {
      try {
        const full = carry?.full ?? await fetchSong(initial.id);
        if (cancelled) return;
        setSong(full);
        if (carry) {
          if (carry.blob) objectUrl = carry.url;
          autoplayed.current = true;
          counted.current = true;
          recordPlay(full);
          setPlaying(!audioRef.current!.paused);
        }
        // One block per lyric line, so each line's tokens stay together.
        const raw: ArticleBlock[] = (full.plan?.sections ?? []).flatMap((s) => s.lines.map((l) => ({ type: 'paragraph' as const, text: l })));
        setBlocks(raw);
        enrichArticle(raw).then((enriched) => { if (!cancelled) setBlocks(enriched); });
        if (full.cover_path) coverUrls([full.cover_path]).then((m) => { if (!cancelled) setCover(m[full.cover_path!] ?? null); });
        const path = full.audio_path;
        if (!path) throw new Error('song has no audio');
        if (carry) { setAudioUrl(carry.url); return; }
        const local = await cachedAudioUrl('music', path);
        if (local) objectUrl = local;
        const url = local ?? await songFileUrl(path);
        if (!local) saveAudio('music', path, url);
        if (!cancelled) setAudioUrl(url);
      } catch (e) {
        console.error('[song] load failed:', e);
        if (!cancelled) setLoadError('曲を読み込めませんでした。');
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) { const u = objectUrl; setTimeout(() => URL.revokeObjectURL(u), 0); }
    };
  }, [initial.id]);

  const duration = (song?.duration_ms ?? initial.duration_ms ?? 0) / 1000;

  // ── Sync: light the line being sung ──
  const scrollToCurrent = useCallback(() => {
    const el = curLineRef.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY - window.innerHeight * SCROLL_ANCHOR;
    // Near the start, stay fully open (big cover) rather than resting half-shrunk.
    const pinAt = Math.min(250, window.innerWidth * 0.7) * 0.8;
    programmaticScrollUntil.current = Date.now() + 900;
    window.scrollTo({ top: top < pinAt ? 0 : top, behavior: 'smooth' });
  }, []);

  const tick = useCallback(() => {
    const t = (audioRef.current?.currentTime ?? 0) * 1000;
    const lines = linesRef.current;
    // The current row is the last timed line already started; it and every row
    // before it count as sung.
    let cur = -1;
    lines.forEach((l, i) => { if (Number.isFinite(l.t) && l.t <= t) cur = i; });
    const hit = cur >= 0 ? lines[cur].el : null;
    if (hit !== curLineRef.current) {
      curLineRef.current = hit;
      lines.forEach((l, i) => l.el.classList.toggle('sung', i <= cur));
      if (hit && autoScrollRef.current) scrollToCurrent();
    }
  }, [scrollToCurrent]);

  useEffect(() => {
    const root = lyricsRef.current;
    if (!root) return;
    linesRef.current = Array.from(root.querySelectorAll<HTMLElement>('.song-line'))
      .map((el) => ({ t: el.dataset.start ? Number(el.dataset.start) : NaN, el }));
    curLineRef.current = null;
    linesRef.current.forEach((l) => l.el.classList.remove('sung'));
    tick();
  }, [blocks, tick]);

  // ── Soft-blue page while the player is open ──
  useEffect(() => {
    document.body.classList.add('song-mode');
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const was = meta?.content;
    if (meta) meta.content = MIST;
    return () => {
      document.body.classList.remove('song-mode');
      if (meta && was) meta.content = was;
    };
  }, []);

  // ── Header morph, driven by the page scroll ──
  // Measured once laid out (and on resize): where the player column starts.
  useEffect(() => {
    const measure = () => {
      const r = rootRef.current?.getBoundingClientRect();
      if (!r) return;
      setGeo({ top: r.top + window.scrollY, left: r.left, width: r.width, cover: Math.min(250, window.innerWidth * 0.7) });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [song, blocks]);

  useEffect(() => {
    if (!geo) return;
    // The app's back row: chevron centred at (y0 − 62px) — see App's header
    // padding — so the pinned thumb sits in that row, just right of the chevron.
    const rowMid = geo.top - 62;
    const range = geo.cover * 0.8;
    const layout = () => {
      const e = smooth(window.scrollY / range);
      const cover = coverRef.current, title = titleRef.current;
      if (!cover || !title) return;
      const size = lerp(geo.cover, THUMB, e);
      const left = lerp(geo.left + (geo.width - geo.cover) / 2, 58, e);
      const top = lerp(geo.top + 6, rowMid - THUMB / 2, e);
      Object.assign(cover.style, { width: `${size}px`, height: `${size}px`, left: `${left}px`, top: `${top}px`, borderRadius: `${lerp(20, 8, e)}px` });
      // The title rides under the cover, then moves beside it; it never overlaps.
      const below = e < 0.55;
      const fade = Math.abs(e - 0.55) < 0.08 ? Math.abs(e - 0.55) / 0.08 : 1;
      const tw = title.offsetWidth, th = title.offsetHeight;
      title.style.fontSize = `${lerp(1.5, 1, e)}rem`;
      Object.assign(title.style, {
        left: `${below ? left + (size - tw) / 2 : left + size + 12}px`,
        top: `${below ? top + size + 16 : top + (size - th) / 2}px`,
        textAlign: below ? 'center' : 'left',
        opacity: String(fade),
        maxWidth: below ? `${geo.width}px` : `${Math.max(120, window.innerWidth - (left + size + 12) - ROW_ACTIONS_W)}px`,
      });
    };
    layout();
    window.addEventListener('scroll', layout, { passive: true });
    return () => window.removeEventListener('scroll', layout);
  }, [geo]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const loop = () => { tick(); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    const display = setInterval(() => setNow(audioRef.current?.currentTime ?? 0), 250);
    return () => { cancelAnimationFrame(raf); clearInterval(display); };
  }, [playing, tick]);

  const play = useCallback(() => { audioRef.current?.play().catch((e) => console.warn('[song] play blocked:', e)); }, []);
  const pause = useCallback(() => { audioRef.current?.pause(); }, []);

  const onLoadedMetadata = () => {
    const audio = audioRef.current;
    // The opening tap's silent unlock clip can finish loading after this mounts;
    // only the real source counts (else it would use up the autoplay).
    if (isUnlockClip(audio)) return;
    if (!audio) return;
    audio.playbackRate = rate;
    if (!autoplayed.current) {
      autoplayed.current = true;
      play();
    }
  };
  const onPlay = () => {
    // The tap's silent unlock clip plays (and ends) before the real source arrives;
    // it isn't the song, so it neither counts as a play nor hands off below.
    if (isUnlockClip(audioRef.current)) return;
    setPlaying(true);
    if (!counted.current && song) { counted.current = true; recordPlay(song); }
  };

  // ── The shared element: listeners and source ──
  // The song ended (with 1曲 on it loops and never ends): hand off to the next.
  // Start `next` on the element right now, if it's prepared; the next player adopts it.
  const startPrepared = (next: Song) => {
    const p = prepared.current;
    const audio = audioRef.current;
    if (!p || p.songId !== next.id || !audio) return;
    carried = p;
    audio.loop = false;
    audio.src = p.url;
    audio.play().catch((e) => console.warn('[song] next song blocked:', e));
  };
  const onEnded = () => {
    if (isUnlockClip(audioRef.current) || !nextSong || !onPlaySong) return;
    // Screen locked or app in the background: no one sees the handoff, and the
    // page is about to be suspended, so start the next song before returning.
    if (document.hidden) { startPrepared(nextSong); onPlaySong(nextSong, false); return; }
    setHandoff({ next: nextSong, left: HANDOFF_S });
  };
  const handlers = useRef({ onLoadedMetadata, onPlay, tick, onEnded });
  handlers.current = { onLoadedMetadata, onPlay, tick, onEnded };
  useEffect(() => {
    const audio = audioRef.current!;
    const on: [string, () => void][] = [
      ['loadedmetadata', () => handlers.current.onLoadedMetadata()],
      ['play', () => handlers.current.onPlay()],
      ['pause', () => { setPlaying(false); setNow(audio.currentTime); }],
      ['ended', () => { setPlaying(false); handlers.current.onEnded(); }],
      ['seeked', () => handlers.current.tick()],
    ];
    on.forEach(([type, fn]) => audio.addEventListener(type, fn));
    return () => {
      on.forEach(([type, fn]) => audio.removeEventListener(type, fn));
      audio.loop = false;
      if (carried) return; // the element is already playing the next song
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    };
  }, []);

  useEffect(() => {
    const audio = audioRef.current!;
    // An adopted song is already playing from this URL; reassigning would restart it.
    if (audioUrl && audio.src !== new URL(audioUrl, location.href).href) audio.src = audioUrl;
  }, [audioUrl]);

  // Load the next song while this one plays, so the hand-off needs no network.
  const nextId = nextSong?.id ?? null;
  useEffect(() => {
    if (!nextId || nextId === initial.id) return;
    let cancelled = false;
    (async () => {
      try {
        const full = await fetchSong(nextId);
        const path = full.audio_path;
        if (!path || cancelled) return;
        // Save the whole file on the device first, so the next song starts from
        // memory instead of buffering over the network at the hand-off.
        let local = await cachedAudioUrl('music', path);
        let url = local;
        if (!local) {
          url = await songFileUrl(path);
          await saveAudio('music', path, url);
          if (!cancelled) local = await cachedAudioUrl('music', path);
          url = local ?? url;
        }
        if (cancelled) { if (local) URL.revokeObjectURL(local); return; }
        prepared.current = { songId: nextId, full, url: url!, blob: !!local };
      } catch (e) {
        console.warn('[song] could not prepare the next song:', e);
      }
    })();
    return () => {
      cancelled = true;
      const p = prepared.current;
      prepared.current = null;
      // Unless the next player adopted it, this player owns the saved copy's URL.
      if (p?.blob && carried?.url !== p.url) setTimeout(() => URL.revokeObjectURL(p.url), 0);
    };
  }, [nextId, initial.id]);

  useEffect(() => {
    // 全部 on a queue of one is the same as 1曲.
    if (audioRef.current) audioRef.current.loop = repeat === 'one' || (repeat === 'all' && queue.length <= 1);
  }, [repeat, queue.length]);

  // Handoff countdown: 3, 2, 1, then the next song.
  const startPreparedRef = useRef(startPrepared);
  startPreparedRef.current = startPrepared;
  useEffect(() => {
    if (!handoff) return;
    const go = () => { startPreparedRef.current(handoff.next); onPlaySong?.(handoff.next, false); };
    if (handoff.left <= 0) { go(); return; }
    const t = setTimeout(() => setHandoff((h) => (h ? { ...h, left: h.left - 1 } : h)), 1000);
    // Locked mid-countdown: the timer would be suspended with the page, so go now.
    const onHide = () => { if (document.hidden) go(); };
    document.addEventListener('visibilitychange', onHide);
    return () => { clearTimeout(t); document.removeEventListener('visibilitychange', onHide); };
  }, [handoff, onPlaySong]);

  // ── Manual scroll pauses auto-scroll ──
  useEffect(() => {
    const onUserScroll = () => {
      if (!playing || Date.now() < programmaticScrollUntil.current) return;
      setAutoScroll(false);
    };
    window.addEventListener('wheel', onUserScroll, { passive: true });
    window.addEventListener('touchmove', onUserScroll, { passive: true });
    return () => {
      window.removeEventListener('wheel', onUserScroll);
      window.removeEventListener('touchmove', onUserScroll);
    };
  }, [playing]);

  // ── Transport ──
  const seek = useCallback((t: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(duration || audio.duration || 0, t));
    setNow(audio.currentTime);
    tick();
  }, [duration, tick]);
  const skip = useCallback((by: number) => seek((audioRef.current?.currentTime ?? 0) + by), [seek]);

  const cycleSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(rate) + 1) % SPEEDS.length];
    setRate(next);
    if (audioRef.current) {
      audioRef.current.playbackRate = next;
      audioRef.current.preservesPitch = true;
    }
  };

  // Lock-screen / headset controls, with the cover as artwork.
  useEffect(() => {
    if (!song || !('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title,
      artist: styleLabel(song.style_key),
      album: '幽玄 · 音楽',
      artwork: cover ? [{ src: cover, sizes: '512x512', type: 'image/jpeg' }] : [],
    });
    const actions: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', play],
      ['pause', pause],
      ['seekbackward', () => skip(-SKIP_S)],
      ['seekforward', () => skip(SKIP_S)],
      ...(queue[index + 1] && onPlaySong ? [['nexttrack', () => { startPrepared(queue[index + 1]); onPlaySong(queue[index + 1], false); }] as [MediaSessionAction, MediaSessionActionHandler]] : []),
      ...(queue[index - 1] && onPlaySong ? [['previoustrack', () => onPlaySong(queue[index - 1], false)] as [MediaSessionAction, MediaSessionActionHandler]] : []),
    ];
    for (const [action, handler] of actions) {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported action */ }
    }
    return () => {
      for (const [action] of actions) {
        try { navigator.mediaSession.setActionHandler(action, null); } catch { /* unsupported action */ }
      }
    };
  }, [song, cover, play, pause, skip, queue, index, onPlaySong]);

  // ── Word taps: pause, look up, resume when the card closes ──
  const pauseForLookup = () => {
    if (audioRef.current && !audioRef.current.paused) {
      resumeAfterModal.current = true;
      pause();
    }
  };
  useEffect(() => {
    if (!lookup.isOpen && resumeAfterModal.current) {
      resumeAfterModal.current = false;
      play();
    }
  }, [lookup.isOpen, play]);

  if (loadError) {
    return <div style={{ padding: '4rem 1rem', textAlign: 'center', color: 'var(--text-muted)' }}>{loadError}</div>;
  }
  if (!song || !blocks) {
    return (
      <div style={{ paddingTop: '1rem' }}>
        <div className="skeleton-shimmer" style={{ width: '250px', aspectRatio: '1', borderRadius: '20px', margin: '0 auto 1.5rem' }} />
        {[1, 2, 3].map((i) => <div key={i} className="skeleton-shimmer" style={{ height: '2.2rem', borderRadius: '8px', marginBottom: '0.8rem' }} />)}
      </div>
    );
  }

  const fullText = blocks.map((b) => b.text).join('\n');
  const progress = duration ? Math.min(1, now / duration) : 0;
  let blockIdx = 0;

  const renderLine = (lineIdx: number, timing: { start: number } | null) => {
    const block = blocks[lineIdx];
    const tokens: Token[] = (block?.content as Token[] | undefined) ?? [{ text: block?.text ?? '' }];
    const lineText = block?.text ?? '';
    return (
      <div
        key={lineIdx}
        className="song-line serif"
        data-start={timing ? timing.start : undefined}
        onDoubleClick={() => { if (timing) { seek(timing.start / 1000); play(); } }}
      >
        {tokens.map((tok, j) => {
          const tokenId = `${lineIdx}-${j}`;
          if (tok.furigana || tok.isInteractive) {
            const key = canonicalWordKey({ jmdictEntryId: tok.details?.jmdictEntryId || tok.jmdict_entry_id, lemma: tok.lemma, word: tok.details?.word, text: tok.text });
            return (
              <FuriganaText
                key={tokenId}
                word={tok.text}
                furigana={tok.furigana}
                hitWeight={hitWeightFor(tok.text, tok.furigana, wordDatabase[key]?.mastery)}
                isSelected={lookup.activeHighlightId === tokenId}
                onClick={(e) => {
                  pauseForLookup();
                  if (tok.details) lookup.openWord(tok.details, lineText, e, tokenId);
                  else lookup.lookupWord(tok.lemma ?? tok.text, lineText, e, tokenId, tok.jmdict_entry_id);
                }}
              />
            );
          }
          // A space between phrases sings as a breath: keep it as a wide gap.
          return <span key={tokenId}>{tok.text.replace(/ /g, '　')}</span>;
        })}
      </div>
    );
  };

  return (
    <div ref={rootRef} className="fade-in" style={{ paddingBottom: '13rem' }}>
      {/* Cover + title: fixed, positioned by the scroll (see the header morph);
          this spacer holds their open-state room in the page. */}
      <div aria-hidden style={{ height: 'calc(min(250px, 70vw) + 7.2rem)' }} />
      <div ref={coverRef} style={{ position: 'fixed', zIndex: 11, width: 'min(250px, 70vw)', aspectRatio: '1', borderRadius: '20px', backgroundColor: 'var(--bg-card)', boxShadow: '0 10px 30px rgba(0,0,0,0.12)', overflow: 'hidden', visibility: geo ? 'visible' : 'hidden' }}>
        {cover && <img src={cover} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
      </div>
      <div ref={titleRef} style={{ position: 'fixed', zIndex: 11, pointerEvents: 'none', visibility: geo ? 'visible' : 'hidden' }}>
        <h1 className="serif" style={{ fontSize: 'inherit', fontWeight: 600, lineHeight: 1.35, color: 'var(--text-main)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{song.title}</h1>
        <div style={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.06em', color: 'var(--text-muted)', marginTop: '0.15rem', whiteSpace: 'nowrap' }}>
          {context ?? styleLabel(song.style_key)}{duration > 0 && <> · {fmt(duration)}</>}
        </div>
      </div>

      {/* A soft edge under the back row, so lyrics fade as they scroll beneath it. */}
      {geo && <div aria-hidden style={{ position: 'fixed', left: 0, right: 0, top: `${geo.top - 21}px`, height: '28px', zIndex: 9, pointerEvents: 'none', background: 'linear-gradient(var(--accent-primary), rgba(212,224,232,0))' }} />}

      <div ref={lyricsRef}>
        {(song.plan?.sections ?? []).filter((s) => s.lines.length).map((section, n) => {
          const sIdx = song.plan!.sections.indexOf(section);
          return (
            <div key={sIdx}>
              {n > 0 && <div className="song-line song-gap serif" aria-hidden>♪</div>}
              {section.lines.map((_, lIdx) => renderLine(blockIdx++, song.timing?.[sIdx]?.[lIdx] ?? null))}
            </div>
          );
        })}
      </div>

      {(song.plan?.vocab?.length ?? 0) > 0 && (
        <div style={{ textAlign: 'center', margin: '3rem 0 1rem' }}>
          <div style={{ fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.18em', color: 'var(--text-muted)', marginBottom: '1rem' }}>この曲の言葉</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', justifyContent: 'center' }}>
            {song.plan!.vocab.map((v) => (
              <button
                key={v.word}
                onClick={(e) => { pauseForLookup(); lookup.lookupWord(v.word, fullText, e, `vocab-${v.word}`); }}
                className="serif"
                style={{ fontSize: '0.95rem', fontWeight: 500, backgroundColor: 'var(--bg-pure)', padding: '0.45rem 0.9rem', borderRadius: '100px', border: 'none', color: 'var(--text-main)', cursor: 'pointer' }}
              >
                {v.word}
                <span className="sans" style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginLeft: '0.4rem' }}>{v.meaning}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {!autoScroll && playing && (
        <button
          onClick={() => { setAutoScroll(true); scrollToCurrent(); }}
          style={{ position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: 'calc(9.5rem + env(safe-area-inset-bottom))', zIndex: 21, backgroundColor: 'var(--bg-pure)', color: 'var(--text-main)', border: '1px solid var(--border-light)', borderRadius: '100px', padding: '0.45rem 1rem', fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer', boxShadow: '0 6px 18px rgba(0,0,0,0.10)' }}
        >
          ↓ 再生位置へ
        </button>
      )}

      {/* Transport — fixed; the bottom nav is hidden while the player is open. */}
      <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 20, background: 'linear-gradient(to bottom, rgba(212,224,232,0), var(--accent-primary) 22%)', padding: '2rem 1.4rem calc(1.4rem + env(safe-area-inset-bottom))' }}>
        <div style={{ maxWidth: '600px', margin: '0 auto' }}>
          <div
            role="slider"
            aria-label="再生位置"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(now)}
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * duration); }}
            style={{ position: 'relative', height: '18px', cursor: 'pointer' }}
          >
            <div style={{ position: 'absolute', left: 0, right: 0, top: '8px', height: '2px', backgroundColor: 'var(--border-light)', borderRadius: '2px' }} />
            <div style={{ position: 'absolute', left: 0, top: '8px', height: '2px', width: `${progress * 100}%`, backgroundColor: 'var(--text-main)', borderRadius: '2px' }} />
            <div style={{ position: 'absolute', top: '4px', left: `${progress * 100}%`, width: '10px', height: '10px', borderRadius: '50%', backgroundColor: 'var(--text-main)', transform: 'translateX(-5px)' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.62rem', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
            <span>{fmt(now)}</span>
            <span>-{fmt(duration - now)}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.6rem' }}>
            <button onClick={cycleSpeed} aria-label="再生速度" style={pillStyle(rate !== 1)}>
              {rate === 1 ? '1.0' : rate}×
            </button>
            <button onClick={() => skip(-SKIP_S)} aria-label={`${SKIP_S}秒戻る`} style={iconBtn}><SkipIcon dir="back" seconds={SKIP_S} /></button>
            <button
              onClick={() => (playing ? pause() : play())}
              aria-label={playing ? '一時停止' : '再生'}
              disabled={!audioUrl}
              style={{ width: '60px', height: '60px', borderRadius: '50%', border: 'none', backgroundColor: 'var(--text-main)', color: 'var(--bg-pure)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: audioUrl ? 'pointer' : 'default', boxShadow: '0 6px 18px rgba(0,0,0,0.15)', opacity: audioUrl ? 1 : 0.5 }}
            >
              {playing ? <Pause size={22} fill="currentColor" strokeWidth={0} /> : <Play size={22} fill="currentColor" strokeWidth={0} style={{ marginLeft: '3px' }} />}
            </button>
            <button onClick={() => skip(SKIP_S)} aria-label={`${SKIP_S}秒進む`} style={iconBtn}><SkipIcon dir="forward" seconds={SKIP_S} /></button>
            <button
              onClick={() => setRepeat(NEXT_REPEAT[repeat])}
              aria-label={`リピート: ${REPEAT_LABEL[repeat]}`}
              style={{ ...pillStyle(repeat !== 'off'), fontFamily: 'var(--font-serif)', fontSize: '0.8rem', letterSpacing: 0 }}
            >
              {REPEAT_LABEL[repeat]}
            </button>
          </div>
        </div>
      </div>

      {upNext.length > 0 && (
        <div style={{ marginTop: '2.6rem' }}>
          <div style={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '0.6rem' }}>次の曲</div>
          {upNext.map((s, k) => {
            const c = coverOf(s, queueCovers);
            return (
              <button
                key={s.id}
                onClick={() => onPlaySong?.(s, true)}
                style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', padding: '0.5rem 0', width: '100%', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left', opacity: k ? 0.55 : 1 }}
              >
                <span style={{ width: k ? 40 : 52, height: k ? 40 : 52, borderRadius: 10, flex: 'none', backgroundColor: 'var(--bg-card)', backgroundImage: c ? `url("${c}")` : undefined, backgroundSize: 'cover' }} />
                <span style={{ minWidth: 0 }}>
                  <span className="serif" style={{ display: 'block', fontSize: k ? '0.95rem' : '1.05rem', fontWeight: k ? 500 : 600, color: 'var(--text-main)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.title}</span>
                  <span style={{ display: 'block', fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.06em', color: 'var(--text-muted)' }}>{styleLabel(s.style_key)}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* The back row's right end: リストに追加, then the position in the queue. */}
      {geo && (
        <div style={{ position: 'fixed', zIndex: 11, top: `${geo.top - 62 - 22}px`, right: `max(1.25rem, calc((100vw - 600px) / 2 + 1.25rem))`, height: 44, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <button
            onClick={() => setAddOpen(true)}
            aria-label={inList ? 'リストに追加済み' : 'リストに追加'}
            style={{ width: 40, height: 40, border: 'none', background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: inList ? 'var(--text-main)' : 'var(--text-muted)', transition: 'color 0.4s cubic-bezier(0.4, 0, 0.2, 1)' }}
          >
            {inList ? <ListCheck size={21} strokeWidth={1.5} /> : <ListPlus size={21} strokeWidth={1.5} />}
          </button>
          {queue.length > 1 && (
            <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', minWidth: '2.6rem', textAlign: 'right' }}>{index + 1} / {queue.length}</span>
          )}
        </div>
      )}

      {handoff && (
        <div className="fade-in" style={{ position: 'fixed', inset: 0, zIndex: 30, backgroundColor: 'var(--accent-primary)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '2rem' }}>
          <div style={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
            次の曲{context ? ` · ${context}` : ''}
          </div>
          {(() => { const c = coverOf(handoff.next, queueCovers); return (
            <div style={{ width: 'min(210px, 56vw)', aspectRatio: '1', borderRadius: 20, margin: '1rem 0 1.2rem', backgroundColor: 'var(--bg-card)', backgroundImage: c ? `url("${c}")` : undefined, backgroundSize: 'cover', boxShadow: '0 10px 30px rgba(0,0,0,0.12)' }} />
          ); })()}
          <div className="serif" style={{ fontSize: '1.5rem', fontWeight: 600, color: 'var(--text-main)' }}>{handoff.next.title}</div>
          <div style={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.06em', color: 'var(--text-muted)' }}>{styleLabel(handoff.next.style_key)}</div>
          <button onClick={() => onPlaySong?.(handoff.next, true)} aria-label="今すぐ再生" style={{ position: 'relative', width: 46, height: 46, marginTop: '1.6rem', border: 'none', background: 'none', cursor: 'pointer', padding: 0 }}>
            <svg width="46" height="46" style={{ transform: 'rotate(-90deg)' }}>
              <circle cx="23" cy="23" r="20" fill="none" stroke="rgba(45,45,45,0.12)" strokeWidth="2.5" />
              <circle cx="23" cy="23" r="20" fill="none" stroke="var(--text-main)" strokeWidth="2.5" strokeDasharray={125.66} strokeDashoffset={125.66 * (handoff.left / HANDOFF_S)} style={{ transition: 'stroke-dashoffset 1s linear' }} />
            </svg>
            <span className="serif" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1rem', color: 'var(--text-main)' }}>{Math.max(1, handoff.left)}</span>
          </button>
          <button onClick={() => setHandoff(null)} className="serif" style={{ marginTop: '1rem', border: 'none', background: 'none', cursor: 'pointer', fontSize: '0.9rem', color: 'var(--text-muted)' }}>止める</button>
        </div>
      )}

      <AddToListSheet song={addOpen ? initial : null} cover={cover ?? undefined} onClose={() => setAddOpen(false)} toastTop="calc(5.6rem + max(1.5rem, env(safe-area-inset-top)))" />
      <WordModal {...lookup.modalProps} />
    </div>
  );
}

const iconBtn: React.CSSProperties = { width: '44px', height: '44px', border: 'none', background: 'none', color: 'var(--text-main)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' };

const pillStyle = (on: boolean): React.CSSProperties => ({
  fontSize: '0.66rem',
  fontWeight: 800,
  letterSpacing: '0.05em',
  color: on ? 'var(--text-main)' : 'var(--text-muted)',
  border: `1px solid ${on ? 'var(--text-main)' : 'var(--border-light)'}`,
  borderRadius: '100px',
  padding: '0.35rem 0.7rem',
  minWidth: '64px',
  background: 'none',
  cursor: 'pointer',
});
