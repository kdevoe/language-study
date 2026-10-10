import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { FuriganaText, HitWeight } from './FuriganaText';
import { WordModal, WordDetails } from './WordModal';
import type { ArticleBlock } from '../services/api';
import { enrichArticle } from '../services/enrich';
import { useWordLookup } from '../hooks/useWordLookup';
import { useAppStore, type MasteryLevel } from '../services/store';
import { canonicalWordKey } from '../services/wordKey';
import {
  PodcastEpisode,
  PodcastEpisodeFull,
  episodeAudioUrl,
  fetchEpisode,
  saveListenPosition,
} from '../services/podcasts';
import { castMember } from '../data/podcastCast';

// Podcast player (docs/podcast-design.md §6.2, mockup docs/mockups/listen.html):
// the transcript IS the interface. The playing sentence gets a soft tint, the
// current word turns olive, and auto-scroll keeps the active line ~40% down the
// screen until the listener scrolls away (then ↓ 再生位置へ re-syncs). Tapping a
// word pauses and opens WordModal (resuming on close); double-tapping a
// sentence seeks there; tapping 。 translates. Highlighting runs off the
// per-character alignment stored with the episode, mapped onto the client
// tokenizer's tokens — no React re-render per frame (DOM classes only).

const SPEEDS = [0.75, 0.9, 1, 1.15];
const SAVE_EVERY_MS = 5000;
const RESUME_REWIND_S = 2;
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

export function PodcastPlayer({ episode: initial }: { episode: PodcastEpisode }) {
  const [ep, setEp] = useState<PodcastEpisodeFull | null>(null);
  const [blocks, setBlocks] = useState<ArticleBlock[] | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [now, setNow] = useState(0); // transport display only (~4 Hz)
  const [listenFirst, setListenFirst] = useState(false);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [autoScroll, setAutoScroll] = useState(true);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<{ t: number; el: HTMLElement; sent: HTMLElement }[]>([]);
  const sentencesRef = useRef<{ t: number; el: HTMLElement }[]>([]);
  const curWordRef = useRef<HTMLElement | null>(null);
  const curSentRef = useRef<HTMLElement | null>(null);
  const autoScrollRef = useRef(true);
  const programmaticScrollUntil = useRef(0);
  const resumeAfterModal = useRef(false);
  const lastSavedAt = useRef(0);

  const wordDatabase = useAppStore((s) => s.wordDatabase);
  const lookup = useWordLookup();

  autoScrollRef.current = autoScroll;

  // ── Load episode, audio URL and tokens ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const full = await fetchEpisode(initial.id);
        if (cancelled) return;
        setEp(full);
        const turns = full.script?.turns ?? [];
        const raw: ArticleBlock[] = turns.map((t) => ({ type: 'paragraph', text: t.text }));
        setBlocks(raw);
        enrichArticle(raw).then((enriched) => { if (!cancelled) setBlocks(enriched); });
        const url = await episodeAudioUrl(full);
        if (!cancelled) setAudioUrl(url);
      } catch (e) {
        console.error('[player] load failed:', e);
        if (!cancelled) setLoadError('エピソードを読み込めませんでした。');
      }
    })();
    return () => { cancelled = true; };
  }, [initial.id]);

  const host = castMember(ep?.cast_ids?.host);
  const guest = castMember(ep?.cast_ids?.guest);
  const duration = (ep?.duration_ms ?? initial.duration_ms ?? 0) / 1000;

  // ── Sync loop: binary-search the word timeline, toggle DOM classes ──
  const scrollToCurrent = useCallback(() => {
    const el = curSentRef.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY - window.innerHeight * SCROLL_ANCHOR;
    programmaticScrollUntil.current = Date.now() + 900;
    window.scrollTo({ top, behavior: 'smooth' });
  }, []);

  const tick = useCallback(() => {
    const audio = audioRef.current;
    const tl = timelineRef.current;
    if (!audio || tl.length === 0) return;
    const t = audio.currentTime;
    let lo = 0;
    let hi = tl.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (tl[m].t <= t) { idx = m; lo = m + 1; } else hi = m - 1;
    }
    const hit = tl[idx];
    if (hit && hit.el !== curWordRef.current) {
      curWordRef.current?.classList.remove('on');
      curWordRef.current = hit.el;
      hit.el.classList.add('on');
    }
    if (hit && hit.sent !== curSentRef.current) {
      curSentRef.current?.classList.remove('cur');
      curSentRef.current = hit.sent;
      hit.sent.classList.add('cur');
      if (autoScrollRef.current) scrollToCurrent();
    }
  }, [scrollToCurrent]);

  // Rebuild the timeline whenever the transcript DOM changes (enrichment swap).
  useEffect(() => {
    const root = transcriptRef.current;
    if (!root) return;
    const words = Array.from(root.querySelectorAll<HTMLElement>('[data-t]'));
    timelineRef.current = words
      .map((el) => ({ t: Number(el.dataset.t), el, sent: el.closest<HTMLElement>('.podcast-sentence')! }))
      .filter((w) => Number.isFinite(w.t) && w.sent)
      .sort((a, b) => a.t - b.t);
    sentencesRef.current = Array.from(root.querySelectorAll<HTMLElement>('.podcast-sentence'))
      .map((el) => ({ t: Number(el.dataset.start), el }))
      .filter((s) => Number.isFinite(s.t));
    curWordRef.current = null;
    curSentRef.current = null;
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

  // ── Listening position (debounced), resume, finish ──
  const persistPosition = useCallback((finished = false) => {
    const audio = audioRef.current;
    if (!audio || !ep) return;
    lastSavedAt.current = Date.now();
    saveListenPosition(ep.id, audio.currentTime * 1000, finished);
  }, [ep]);

  useEffect(() => () => { persistPosition(); }, [persistPosition]);

  const onLoadedMetadata = () => {
    const audio = audioRef.current;
    if (!audio || !ep) return;
    audio.playbackRate = rate;
    if (!ep.listened_at && ep.listen_position_ms > 0) {
      audio.currentTime = Math.max(0, ep.listen_position_ms / 1000 - RESUME_REWIND_S);
      setNow(audio.currentTime);
      tick();
    }
  };

  const onTimeUpdate = () => {
    if (Date.now() - lastSavedAt.current > SAVE_EVERY_MS) persistPosition();
  };

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
  const play = useCallback(() => { audioRef.current?.play().catch((e) => console.warn('[player] play blocked:', e)); }, []);
  const pause = useCallback(() => { audioRef.current?.pause(); }, []);
  const seek = useCallback((t: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(duration || audio.duration || 0, t));
    setNow(audio.currentTime);
    tick();
  }, [duration, tick]);

  const currentSentenceIndex = () => {
    const s = sentencesRef.current;
    const t = audioRef.current?.currentTime ?? 0;
    let idx = 0;
    for (let i = 0; i < s.length; i++) if (s[i].t <= t) idx = i;
    return idx;
  };
  const prevSentence = useCallback(() => {
    const s = sentencesRef.current;
    if (!s.length) return;
    const i = currentSentenceIndex();
    const t = audioRef.current?.currentTime ?? 0;
    // Within the first ~1.2s of a sentence, ⏮ goes to the previous one (like a track list).
    seek(s[t - s[i].t > 1.2 ? i : Math.max(0, i - 1)].t);
  }, [seek]);
  const nextSentence = useCallback(() => {
    const s = sentencesRef.current;
    if (!s.length) return;
    seek(s[Math.min(s.length - 1, currentSentenceIndex() + 1)].t);
  }, [seek]);

  const cycleSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(rate) + 1) % SPEEDS.length];
    setRate(next);
    if (audioRef.current) {
      audioRef.current.playbackRate = next;
      audioRef.current.preservesPitch = true;
    }
  };

  // Lock-screen / headset controls.
  useEffect(() => {
    if (!ep || !('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: ep.title,
      artist: `${host.name} × ${guest.name}`,
      album: '幽玄 · 聴く',
    });
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', play],
      ['pause', pause],
      ['previoustrack', prevSentence],
      ['nexttrack', nextSentence],
      ['seekbackward', () => seek((audioRef.current?.currentTime ?? 0) - 10)],
      ['seekforward', () => seek((audioRef.current?.currentTime ?? 0) + 10)],
    ];
    for (const [action, handler] of handlers) {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported action */ }
    }
    return () => {
      for (const [action] of handlers) {
        try { navigator.mediaSession.setActionHandler(action, null); } catch { /* unsupported action */ }
      }
    };
  }, [ep, host.name, guest.name, play, pause, prevSentence, nextSentence, seek]);

  // ── Word taps: pause, look up, resume when the modal closes ──
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

  const transcriptText = useMemo(() => (ep?.script?.turns ?? []).map((t) => t.text).join('\n'), [ep]);

  const toggleReveal = (id: string) => setRevealed((prev) => new Set(prev).add(id));

  // ── Render one turn: tokens → sentences, each token stamped with its start time ──
  const renderTurn = (turnIdx: number) => {
    const turn = ep!.script!.turns[turnIdx];
    const times = ep!.alignment?.[turnIdx]?.t ?? [];
    const block = blocks?.[turnIdx];
    const tokens: Token[] = (block?.content as Token[] | undefined) ?? [{ text: block?.text ?? turn.text }];
    const timeAt = (offset: number) => (times.length ? times[Math.min(offset, times.length - 1)] / 1000 : NaN);

    const sentences: { tokens: { tok: Token; offset: number }[] }[] = [];
    let cur: { tok: Token; offset: number }[] = [];
    let offset = 0;
    for (const tok of tokens) {
      cur.push({ tok, offset });
      offset += tok.text.length;
      if (/[。！？!?\n]/.test(tok.text)) { sentences.push({ tokens: cur }); cur = []; }
    }
    if (cur.length) sentences.push({ tokens: cur });

    return sentences.map((sent, sIdx) => {
      const sentenceId = `${turnIdx}-${sIdx}`;
      const sentText = sent.tokens.map((x) => x.tok.text).join('');
      const start = timeAt(sent.tokens[0]?.offset ?? 0);
      const isRevealed = revealed.has(sentenceId);
      return (
        <span
          key={sentenceId}
          className={`podcast-sentence${isRevealed ? ' revealed' : ''}${lookup.activeHighlightId === sentenceId ? ' sentence-highlight' : ''}`}
          data-start={start}
          onClickCapture={(e) => {
            if (listenFirst && !isRevealed) { e.stopPropagation(); toggleReveal(sentenceId); }
          }}
          onDoubleClick={() => { seek(start); play(); }}
        >
          {sent.tokens.map(({ tok, offset: off }, j) => {
            const tokenId = `${sentenceId}-${j}`;
            const t = timeAt(off);
            if (tok.furigana || tok.isInteractive) {
              const key = canonicalWordKey({ jmdictEntryId: tok.details?.jmdictEntryId || tok.jmdict_entry_id, lemma: tok.lemma, word: tok.details?.word, text: tok.text });
              return (
                <span key={tokenId} className="podcast-word" data-t={t}>
                  <FuriganaText
                    word={tok.text}
                    furigana={tok.furigana}
                    hitWeight={hitWeightFor(tok.text, tok.furigana, wordDatabase[key]?.mastery)}
                    isSelected={lookup.activeHighlightId === tokenId}
                    onClick={(e) => {
                      pauseForLookup();
                      if (tok.details) lookup.openWord(tok.details, sentText, e, tokenId);
                      else lookup.lookupWord(tok.lemma ?? tok.text, sentText, e, tokenId, tok.jmdict_entry_id);
                    }}
                  />
                </span>
              );
            }
            // Plain text: sentence-ending marks translate the sentence (as in the Reader).
            return (
              <span key={tokenId} className="podcast-word" data-t={t}>
                {tok.text.split(/([。！？])/).filter((p) => p !== '').map((part, k) =>
                  /[。！？]/.test(part) ? (
                    <span
                      key={k}
                      onClick={(e) => { pauseForLookup(); lookup.translateSentence(sentText, sentenceId, e, transcriptText); }}
                      style={{ cursor: 'pointer', padding: '0 0.25em', margin: '0 -0.1em' }}
                    >
                      {part}
                    </span>
                  ) : (
                    <span key={k}>{part}</span>
                  ),
                )}
              </span>
            );
          })}
        </span>
      );
    });
  };

  if (loadError) {
    return <div style={{ padding: '4rem 1rem', textAlign: 'center', color: 'var(--text-muted)' }}>{loadError}</div>;
  }
  if (!ep || !blocks) {
    return (
      <div style={{ paddingTop: '1rem' }}>
        <div className="skeleton-shimmer" style={{ height: '2.2rem', width: '80%', borderRadius: '8px', marginBottom: '1.5rem' }} />
        {[1, 2, 3, 4].map((i) => <div key={i} className="skeleton-shimmer" style={{ height: '4rem', borderRadius: '8px', marginBottom: '1rem' }} />)}
      </div>
    );
  }

  const dialectNote = (m: { dialect: string | null }) => (m.dialect ? `（${m.dialect}）` : '');
  const progress = duration ? Math.min(1, now / duration) : 0;

  return (
    <div className="fade-in" style={{ paddingBottom: '13rem' }}>
      <audio
        ref={audioRef}
        src={audioUrl ?? undefined}
        preload="auto"
        onLoadedMetadata={onLoadedMetadata}
        onPlay={() => setPlaying(true)}
        onPause={() => { setPlaying(false); persistPosition(); setNow(audioRef.current?.currentTime ?? 0); }}
        onTimeUpdate={onTimeUpdate}
        onEnded={() => { setPlaying(false); persistPosition(true); }}
        onSeeked={tick}
      />

      <div style={{ margin: '0.4rem 0 2rem' }}>
        <h1 className="serif" style={{ fontSize: '1.7rem', fontWeight: 500, lineHeight: 1.4, marginBottom: '0.7rem', color: 'var(--text-main)' }}>
          {ep.title}
        </h1>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          <b style={{ color: 'var(--text-main)', fontWeight: 600 }}>{host.name}</b>{dialectNote(host)} ×{' '}
          <b style={{ color: 'var(--text-main)', fontWeight: 600 }}>{guest.name}</b>{dialectNote(guest)}
          {duration > 0 && <> · {fmt(duration)}</>}
        </div>
        <div style={{ width: '40px', height: '1px', backgroundColor: 'var(--text-muted)', marginTop: '1.4rem' }} />
      </div>

      <div ref={transcriptRef} className={listenFirst ? 'podcast-transcript listen-first' : 'podcast-transcript'}>
        {ep.script?.turns.map((turn, i) => (
          <div key={i} style={{ marginBottom: '1.5rem' }}>
            <span style={{ display: 'block', fontSize: '0.58rem', fontWeight: 800, letterSpacing: '0.16em', color: turn.speaker === 'guest' ? '#4a5d23' : 'var(--text-muted)', opacity: turn.speaker === 'guest' ? 0.8 : 1, marginBottom: '0.15rem' }}>
              {turn.speaker === 'host' ? host.name : guest.name}
            </span>
            <div className="serif" style={{ fontSize: '1.1rem', lineHeight: 2.15, letterSpacing: '0.02em', color: 'var(--text-main)' }}>
              {renderTurn(i)}
            </div>
          </div>
        ))}
      </div>

      {(ep.script?.vocab?.length ?? 0) > 0 && (
        <div style={{ textAlign: 'center', margin: '3rem 0 1rem' }}>
          <div style={{ fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.18em', color: 'var(--text-muted)', marginBottom: '1rem' }}>この回の言葉</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', justifyContent: 'center' }}>
            {ep.script!.vocab.map((v) => (
              <span key={v.word} title={v.meaning} className="serif" style={{ fontSize: '0.95rem', fontWeight: 500, backgroundColor: 'var(--bg-card)', padding: '0.45rem 0.9rem', borderRadius: '100px' }}>
                {v.word}
                <span className="sans" style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginLeft: '0.4rem' }}>{v.meaning}</span>
              </span>
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

      {/* Transport — fixed, the bottom nav is hidden while the player is open. */}
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
            <button onClick={prevSentence} aria-label="前の文" style={iconBtn}><SkipBack size={20} strokeWidth={1.5} /></button>
            <button
              onClick={() => (playing ? pause() : play())}
              aria-label={playing ? '一時停止' : '再生'}
              disabled={!audioUrl}
              style={{ width: '60px', height: '60px', borderRadius: '50%', border: 'none', backgroundColor: 'var(--text-main)', color: 'var(--bg-pure)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: audioUrl ? 'pointer' : 'default', boxShadow: '0 6px 18px rgba(0,0,0,0.15)', opacity: audioUrl ? 1 : 0.5 }}
            >
              {playing ? <Pause size={22} fill="currentColor" strokeWidth={0} /> : <Play size={22} fill="currentColor" strokeWidth={0} style={{ marginLeft: '3px' }} />}
            </button>
            <button onClick={nextSentence} aria-label="次の文" style={iconBtn}><SkipForward size={20} strokeWidth={1.5} /></button>
            <button
              onClick={() => { setListenFirst((v) => !v); setRevealed(new Set()); }}
              aria-pressed={listenFirst}
              title="耳で聴く: 文をタップするまで字幕を隠します"
              style={{ ...pillStyle(listenFirst), fontFamily: 'var(--font-serif)', fontSize: '0.8rem', letterSpacing: 0 }}
            >
              耳で聴く
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
