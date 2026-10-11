import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
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

// Song player (mockup docs/mockups/music.html, phone 4): cover, title and style,
// then the lyrics. The line being sung is full strength and the rest faded; the
// page scrolls itself to keep it ~40% down until the listener scrolls away
// (↓ 再生位置へ re-syncs). Tapping a word pauses and opens its card. Line times
// come from ElevenLabs' phrase timestamps (songs.timing); a line with no match
// leaves the previous one lit. Plays on the app's shared audio element, which
// the opening tap unlocked, and keeps a copy on the device (audioCache).

const SPEEDS = [0.75, 0.9, 1];
const SKIP_S = 10;
const SCROLL_ANCHOR = 0.4;

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

export function SongPlayer({ song: initial }: { song: Song }) {
  const [song, setSong] = useState<SongFull | null>(null);
  const [blocks, setBlocks] = useState<ArticleBlock[] | null>(null);
  const [cover, setCover] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [repeat, setRepeat] = useState(false);
  const [now, setNow] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);

  const audioRef = useRef<HTMLAudioElement | null>(sharedAudio());
  const autoplayed = useRef(false);
  const counted = useRef(false);
  const lyricsRef = useRef<HTMLDivElement | null>(null);
  const linesRef = useRef<{ t: number; el: HTMLElement }[]>([]);
  const curLineRef = useRef<HTMLElement | null>(null);
  const autoScrollRef = useRef(true);
  const programmaticScrollUntil = useRef(0);
  const resumeAfterModal = useRef(false);

  const wordDatabase = useAppStore((s) => s.wordDatabase);
  const lookup = useWordLookup();
  autoScrollRef.current = autoScroll;

  // ── Load song, cover, audio and tokens ──
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      try {
        const full = await fetchSong(initial.id);
        if (cancelled) return;
        setSong(full);
        // One block per lyric line, so each line's tokens stay together.
        const raw: ArticleBlock[] = (full.plan?.sections ?? []).flatMap((s) => s.lines.map((l) => ({ type: 'paragraph' as const, text: l })));
        setBlocks(raw);
        enrichArticle(raw).then((enriched) => { if (!cancelled) setBlocks(enriched); });
        if (full.cover_path) coverUrls([full.cover_path]).then((m) => { if (!cancelled) setCover(m[full.cover_path!] ?? null); });
        const path = full.audio_path;
        if (!path) throw new Error('song has no audio');
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
    programmaticScrollUntil.current = Date.now() + 900;
    window.scrollTo({ top, behavior: 'smooth' });
  }, []);

  const tick = useCallback(() => {
    const t = (audioRef.current?.currentTime ?? 0) * 1000;
    const lines = linesRef.current;
    let hit: HTMLElement | null = null;
    for (const l of lines) { if (l.t <= t) hit = l.el; else break; }
    if (hit !== curLineRef.current) {
      curLineRef.current?.classList.remove('cur');
      curLineRef.current = hit;
      hit?.classList.add('cur');
      if (hit && autoScrollRef.current) scrollToCurrent();
    }
  }, [scrollToCurrent]);

  useEffect(() => {
    const root = lyricsRef.current;
    if (!root) return;
    linesRef.current = Array.from(root.querySelectorAll<HTMLElement>('.song-line'))
      .map((el) => ({ t: Number(el.dataset.start), el }))
      .filter((l) => Number.isFinite(l.t))
      .sort((a, b) => a.t - b.t);
    curLineRef.current = null;
    tick();
  }, [blocks, tick]);

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
    setPlaying(true);
    if (!counted.current && song) { counted.current = true; recordPlay(song); }
  };

  // ── The shared element: listeners and source ──
  const handlers = useRef({ onLoadedMetadata, onPlay, tick });
  handlers.current = { onLoadedMetadata, onPlay, tick };
  useEffect(() => {
    const audio = audioRef.current!;
    const on: [string, () => void][] = [
      ['loadedmetadata', () => handlers.current.onLoadedMetadata()],
      ['play', () => handlers.current.onPlay()],
      ['pause', () => { setPlaying(false); setNow(audio.currentTime); }],
      ['ended', () => setPlaying(false)],
      ['seeked', () => handlers.current.tick()],
    ];
    on.forEach(([type, fn]) => audio.addEventListener(type, fn));
    return () => {
      on.forEach(([type, fn]) => audio.removeEventListener(type, fn));
      audio.loop = false;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    };
  }, []);

  useEffect(() => {
    if (audioUrl) audioRef.current!.src = audioUrl;
  }, [audioUrl]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.loop = repeat;
  }, [repeat]);

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
    ];
    for (const [action, handler] of actions) {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported action */ }
    }
    return () => {
      for (const [action] of actions) {
        try { navigator.mediaSession.setActionHandler(action, null); } catch { /* unsupported action */ }
      }
    };
  }, [song, cover, play, pause, skip]);

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
        style={{ fontSize: '1.15rem', lineHeight: 2.05, letterSpacing: '0.02em', color: 'var(--text-main)' }}
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
    <div className="fade-in" style={{ paddingBottom: '13rem' }}>
      <div style={{ width: 'min(250px, 70vw)', aspectRatio: '1', borderRadius: '20px', margin: '0.4rem auto 0', backgroundColor: 'var(--bg-card)', boxShadow: '0 10px 30px rgba(0,0,0,0.12)', overflow: 'hidden' }}>
        {cover && <img src={cover} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
      </div>
      <h1 className="serif" style={{ fontSize: '1.5rem', fontWeight: 500, lineHeight: 1.4, textAlign: 'center', marginTop: '1.2rem', color: 'var(--text-main)' }}>{song.title}</h1>
      <div style={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.06em', color: 'var(--text-muted)', textAlign: 'center', marginTop: '0.25rem' }}>
        {styleLabel(song.style_key)}{duration > 0 && <> · {fmt(duration)}</>}
      </div>

      <div ref={lyricsRef} style={{ marginTop: '2rem' }}>
        {(song.plan?.sections ?? []).map((section, sIdx) => {
          if (!section.lines.length) return null;
          return (
            <div key={sIdx}>
              <div style={{ fontSize: '0.58rem', fontWeight: 800, letterSpacing: '0.16em', color: 'var(--text-muted)', margin: '1.4rem 0 0.3rem', textTransform: 'uppercase' }}>
                {section.name}
              </div>
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
                style={{ fontSize: '0.95rem', fontWeight: 500, backgroundColor: 'var(--bg-card)', padding: '0.45rem 0.9rem', borderRadius: '100px', border: 'none', color: 'var(--text-main)', cursor: 'pointer' }}
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
      <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 20, background: 'linear-gradient(to bottom, rgba(245,245,240,0), var(--bg-color) 22%)', padding: '2rem 1.4rem calc(1.4rem + env(safe-area-inset-bottom))' }}>
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
              onClick={() => setRepeat((v) => !v)}
              aria-pressed={repeat}
              style={{ ...pillStyle(repeat), fontFamily: 'var(--font-serif)', fontSize: '0.8rem', letterSpacing: 0 }}
            >
              リピート
            </button>
          </div>
        </div>
      </div>

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
