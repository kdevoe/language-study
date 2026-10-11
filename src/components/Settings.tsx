import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useAppStore, type SongFrequency } from '../services/store';
import { rtkKanjiList } from '../data/rtkKanji';
import { FEED_TOPICS, DEFAULT_FEED_TOPICS } from '../data/feedTopics';
import { COVER_STYLE_MAX_CHARS, DEFAULT_COVER_STYLE, SONG_STYLES } from '../data/songStyles';
import { PODCAST_CAST } from '../data/podcastCast';
import { SliderToggle } from './SliderToggle';
import { PageHeading } from './PageHeading';

// Settings (mockup docs/mockups/settings.html; design-system §6.12): four plain
// sections — 学習, 読む, 聞く, 表示 — grouped by serif titles and space, no
// boxes. Each setting gets one short hint at most. 聞く holds the auto-song
// frequency and two pick lists (song styles, podcast hosts): a white row is in
// the rotation, a faded one is left out. The one-off maintenance tools sit
// behind 詳細 at the bottom.

const LENGTH_ROWS = [
  { kind: 'full', label: 'Full text' },
  { kind: 'partial', label: 'Partial' },
  { kind: 'snippet', label: 'Snippet' },
] as const;

const UI_LANGUAGE_OPTIONS = [
  { value: 'english', label: 'English' },
  { value: 'adaptive', label: 'Adaptive' },
  { value: 'japanese', label: <span lang="ja" translate="no">日本語</span> },
] as const;

const INTENSITY_OPTIONS = [
  { value: 'leisure', label: 'Leisure' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'intensive', label: 'Intensive' },
] as const;

const INTENSITY_HINT = {
  leisure: 'About 98% known words; few lookups.',
  balanced: 'About 95% known words, a few review and new.',
  intensive: 'About 90% known words; more review and new.',
} as const;

const MODE_OPTIONS = [
  { value: 'natural', label: 'Natural' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'study', label: 'Study' },
] as const;

const SONG_FREQUENCY_OPTIONS: readonly { value: SongFrequency; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'every_other_day', label: 'Every other day' },
  { value: 'daily', label: 'Daily' },
];

const ALL_STYLE_IDS = SONG_STYLES.map((s) => s.id);
const ALL_HOST_IDS = Object.keys(PODCAST_CAST);
// Hosts the reader can switch off, as long as two stay on and one speaks 標準語
// (the server falls back to the full cast otherwise; this keeps the UI honest).
const validCast = (ids: string[]) => ids.length >= 2 && ids.some((id) => PODCAST_CAST[id]?.dialect === null);

const sectionTitle: React.CSSProperties = { fontFamily: 'var(--font-serif)', fontSize: '1.3rem', fontWeight: 600, color: 'var(--text-main)', marginBottom: '1.2rem' };
const labelStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-main)', marginBottom: '0.6rem' };
const smallStyle: React.CSSProperties = { fontSize: '0.75rem', fontWeight: 500, color: 'var(--text-muted)' };
const hintStyle: React.CSSProperties = { fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.45rem', lineHeight: 1.5 };
const settingStyle: React.CSSProperties = { marginBottom: '1.6rem' };
const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' };

const stepperBtnStyle = (disabled: boolean): React.CSSProperties => ({
  width: '34px',
  height: '34px',
  borderRadius: '100px',
  border: 'none',
  backgroundColor: 'var(--border-light)',
  color: disabled ? 'var(--text-muted)' : 'var(--text-main)',
  fontSize: '1.2rem',
  fontWeight: 700,
  lineHeight: 1,
  cursor: disabled ? 'default' : 'pointer',
  opacity: disabled ? 0.4 : 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
});

function Stepper({ value, min, max, onChange, label, editable }: { value: number; min: number; max: number; onChange: (v: number) => void; label: string; editable?: boolean }) {
  const numStyle: React.CSSProperties = { minWidth: '1.5rem', textAlign: 'center', fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-main)', fontVariantNumeric: 'tabular-nums' };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexShrink: 0 }}>
      <button onClick={() => onChange(value - 1)} disabled={value <= min} aria-label={`Decrease ${label}`} style={stepperBtnStyle(value <= min)}>−</button>
      {editable ? (
        // A long range (RTK, 1–2,200) also takes a typed number.
        <input
          type="number"
          inputMode="numeric"
          value={value}
          min={min}
          max={max}
          aria-label={label}
          onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v)) onChange(Math.min(Math.max(min, v), max)); }}
          style={{ ...numStyle, width: '3.4rem', border: 'none', outline: 'none', background: 'transparent', fontFamily: 'var(--font-sans)', padding: 0, MozAppearance: 'textfield' }}
        />
      ) : (
        <span style={numStyle}>{value}</span>
      )}
      <button onClick={() => onChange(value + 1)} disabled={value >= max} aria-label={`Increase ${label}`} style={stepperBtnStyle(value >= max)}>+</button>
    </div>
  );
}

function SubHeading({ children, count }: { children: React.ReactNode; count: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-main)', margin: '1.4rem 0 0.6rem' }}>
      {children}
      <span style={{ fontSize: '0.72rem', fontWeight: 500, color: 'var(--text-muted)' }}>{count}</span>
    </div>
  );
}

// One row of a pick list: white = on, faded = off. Tapping the row toggles it.
function PickRow({ on, name, tag, desc, onToggle, onEdit, children }: {
  on: boolean; name: string; tag?: string | null; desc?: string; onToggle: () => void; onEdit?: () => void; children?: React.ReactNode;
}) {
  return (
    <div
      role="checkbox"
      aria-checked={on}
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); onToggle(); } }}
      style={{
        borderRadius: '16px', padding: '0.75rem 1rem', cursor: 'pointer',
        backgroundColor: on ? 'var(--bg-pure)' : 'transparent',
        boxShadow: on ? '0 2px 8px rgba(0,0,0,0.08)' : 'none',
        opacity: on || children ? 1 : 0.5,
        transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
        <span lang="ja" className="serif" style={{ fontSize: '1.02rem', fontWeight: 600, color: 'var(--text-main)' }}>{name}</span>
        {tag && <span lang="ja" style={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.06em', color: 'var(--text-muted)' }}>{tag}</span>}
        {onEdit && !children && (
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            className="serif"
            style={{ marginLeft: 'auto', border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontSize: '0.78rem', color: 'var(--text-muted)' }}
          >
            編集
          </button>
        )}
      </div>
      {children ?? (desc && <div lang={onEdit ? 'ja' : undefined} style={{ fontSize: '0.76rem', color: 'var(--text-muted)', lineHeight: 1.5, marginTop: '0.15rem' }}>{desc}</div>)}
    </div>
  );
}

// 編集 on a host or the cover art: the text opens in place as a serif underline
// field. 保存 keeps the rewrite; 元に戻す restores the original (saves null).
function TextEditor({ original, current, onSave, onClose, maxLength = 200, lang = 'ja' }: {
  original: string; current: string; onSave: (text: string | null) => void; onClose: () => void; maxLength?: number; lang?: string;
}) {
  const [text, setText] = useState(current);
  const actStyle: React.CSSProperties = { border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontFamily: 'var(--font-serif)', fontSize: '0.8rem', color: 'var(--text-muted)' };
  return (
    <div onClick={(e) => e.stopPropagation()}>
      <textarea
        autoFocus
        lang={lang}
        rows={lang === 'ja' ? 3 : 5}
        value={text}
        maxLength={maxLength}
        onChange={(e) => setText(e.target.value)}
        style={{ width: '100%', marginTop: '0.4rem', border: 'none', borderBottom: '1px solid var(--text-muted)', background: 'transparent', fontFamily: 'var(--font-serif)', fontSize: '0.85rem', lineHeight: 1.6, color: 'var(--text-main)', resize: 'none', outline: 'none' }}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1.1rem', marginTop: '0.35rem' }}>
        <button style={actStyle} onClick={() => { onSave(null); onClose(); }}>元に戻す</button>
        <button
          style={{ ...actStyle, color: 'var(--text-main)', fontWeight: 700 }}
          onClick={() => { const t = text.trim(); onSave(t && t !== original ? t : null); onClose(); }}
        >
          保存
        </button>
      </div>
    </div>
  );
}

export function Settings() {
  const {
    jlptLevel, setJlptLevel,
    rtkLevel, setRtkLevel,
    studyMode, setStudyMode,
    vocabMode, setVocabMode,
    readingIntensity, setReadingIntensity,
    targetParagraphs, setTargetParagraphs,
    feedTopics, setFeedTopics,
    newWordsPerDay, setNewWordsPerDay,
    readerFontSize, setReaderFontSize,
    readerFontWeight, setReaderFontWeight,
    sandboxMode, setSandboxMode,
    uiLanguage, setUiLanguage,
    songFrequency, setSongFrequency,
    songStyles, setSongStyles,
    songCoverStyle, setSongCoverStyle,
    podcastCast, setPodcastCast,
    podcastPersonas, setPodcastPersona,
    lastStudyPacingResetTs,
    lastFuriganaRealignTs
  } = useAppStore();
  const [editingHost, setEditingHost] = useState<string | null>(null);
  const [editingCover, setEditingCover] = useState(false);

  // null = never chosen → the server-default lineup is what's effectively active.
  const selectedTopics = feedTopics ?? DEFAULT_FEED_TOPICS;
  const toggleTopic = (id: string) => {
    const next = selectedTopics.includes(id)
      ? selectedTopics.filter(t => t !== id)
      : [...selectedTopics, id];
    if (next.length === 0) return; // keep at least one topic on
    setFeedTopics(next);
  };

  // null = all styles / all hosts.
  const onStyles = songStyles?.length ? songStyles.filter((id) => ALL_STYLE_IDS.includes(id)) : ALL_STYLE_IDS;
  const toggleStyle = (id: string) => {
    const next = onStyles.includes(id) ? onStyles.filter((s) => s !== id) : [...onStyles, id];
    if (next.length) setSongStyles(next);
  };
  const onHosts = podcastCast?.length ? podcastCast.filter((id) => ALL_HOST_IDS.includes(id)) : ALL_HOST_IDS;
  const toggleHost = (id: string) => {
    const next = onHosts.includes(id) ? onHosts.filter((h) => h !== id) : [...onHosts, id];
    if (validCast(next)) setPodcastCast(next);
  };

  return (
    <div className="fade-in" style={{ paddingBottom: '6rem' }}>
      <div style={{ marginBottom: '1.6rem' }}>
        <PageHeading id="settings" settingsMark={false} />
      </div>

      {/* ── 学習 ── */}
      <section style={{ marginBottom: '3rem' }}>
        <h3 lang="ja" style={sectionTitle}>学習</h3>
        <div style={settingStyle}>
          <div style={labelStyle}>JLPT</div>
          <SliderToggle
            options={[5, 4, 3, 2, 1].map((n) => ({ value: n, label: `N${n}` }))}
            value={jlptLevel || 4}
            onChange={setJlptLevel}
            fontSize="0.9rem"
            ariaLabel="JLPT level"
          />
        </div>
        <div style={settingStyle}>
          <div style={rowStyle}>
            <div style={{ ...labelStyle, margin: 0 }}>New words / day</div>
            <Stepper value={newWordsPerDay} min={0} max={50} onChange={setNewWordsPerDay} label="new words per day" />
          </div>
          <div style={hintStyle}>Easiest first. 0 pauses new words.</div>
        </div>
        <div style={settingStyle}>
          <div style={rowStyle}>
            <div style={{ ...labelStyle, margin: 0 }}>RTK kanji <small style={smallStyle}>&nbsp;of {rtkKanjiList.length.toLocaleString()}</small></div>
            <Stepper value={rtkLevel || 1} min={1} max={rtkKanjiList.length} onChange={setRtkLevel} label="RTK kanji" editable />
          </div>
          <div style={hintStyle}>Goes up 3 a day.</div>
        </div>
      </section>

      {/* ── 読む ── */}
      <section style={{ marginBottom: '3rem' }}>
        <h3 lang="ja" style={sectionTitle}>読む</h3>
        <div style={settingStyle}>
          <div style={labelStyle}>Topics</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
            {FEED_TOPICS.map(topic => {
              const isOn = selectedTopics.includes(topic.id);
              return (
                <button
                  key={topic.id}
                  onClick={() => toggleTopic(topic.id)}
                  title={topic.hint}
                  aria-pressed={isOn}
                  style={{
                    padding: '0.4rem 0.9rem',
                    borderRadius: '100px',
                    border: 'none',
                    outline: 'none',
                    cursor: 'pointer',
                    backgroundColor: isOn ? 'var(--bg-pure)' : 'var(--border-light)',
                    color: isOn ? 'var(--text-main)' : 'var(--text-muted)',
                    fontWeight: isOn ? 700 : 600,
                    fontSize: '0.82rem',
                    boxShadow: isOn ? '0 2px 8px rgba(0,0,0,0.1)' : 'none',
                    transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                  }}
                >
                  {topic.label}
                </button>
              );
            })}
          </div>
        </div>
        <div style={settingStyle}>
          <div style={labelStyle}>Intensity</div>
          <SliderToggle options={INTENSITY_OPTIONS} value={readingIntensity} onChange={setReadingIntensity} ariaLabel="Reading intensity" />
          <div style={hintStyle}>{INTENSITY_HINT[readingIntensity]}</div>
        </div>
        <div style={settingStyle}>
          <div style={labelStyle}>Length <small style={smallStyle}>paragraphs</small></div>
          {LENGTH_ROWS.map(({ kind, label }) => (
            <div key={kind} style={{ ...rowStyle, marginBottom: '0.6rem' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-main)' }}>{label}</span>
              <Stepper value={targetParagraphs[kind]} min={1} max={10} onChange={(v) => setTargetParagraphs(kind, v)} label={`${label} length`} />
            </div>
          ))}
          <div style={hintStyle}>By how much source text an article had.</div>
        </div>
        <div style={settingStyle}>
          <div style={labelStyle}>Vocabulary</div>
          <SliderToggle options={MODE_OPTIONS} value={vocabMode} onChange={setVocabMode} ariaLabel="Vocabulary use" />
        </div>
        <div style={settingStyle}>
          <div style={labelStyle}>Kanji</div>
          <SliderToggle options={MODE_OPTIONS} value={studyMode} onChange={setStudyMode} ariaLabel="Kanji use" />
        </div>
      </section>

      {/* ── 聞く ── */}
      <section style={{ marginBottom: '3rem' }}>
        <h3 lang="ja" style={sectionTitle}>聞く</h3>
        <div style={settingStyle}>
          <div style={labelStyle}>Songs</div>
          <SliderToggle options={SONG_FREQUENCY_OPTIONS} value={songFrequency} onChange={setSongFrequency} fontSize="0.8rem" ariaLabel="Automatic songs" />
          <div style={hintStyle}>{songFrequency === 'off' ? 'No automatic songs; make your own in 音楽.' : "Made from what you've been studying."}</div>
        </div>

        <SubHeading count={`${onStyles.length} of ${ALL_STYLE_IDS.length}`}>Song styles</SubHeading>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
          {SONG_STYLES.map((s) => (
            <PickRow key={s.id} on={onStyles.includes(s.id)} name={s.label} desc={s.blurb} onToggle={() => toggleStyle(s.id)} />
          ))}
        </div>

        {/* The look of every song cover; the songwriter only describes the scene. */}
        <SubHeading count={songCoverStyle ? 'Your own' : 'Default'}>Cover art</SubHeading>
        <div style={{ borderRadius: '16px', padding: '0.75rem 1rem', backgroundColor: 'var(--bg-pure)', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' }}>
          {editingCover ? (
            <TextEditor
              lang="en"
              maxLength={COVER_STYLE_MAX_CHARS}
              original={DEFAULT_COVER_STYLE}
              current={songCoverStyle || DEFAULT_COVER_STYLE}
              onSave={setSongCoverStyle}
              onClose={() => setEditingCover(false)}
            />
          ) : (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem' }}>
              <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>{songCoverStyle || DEFAULT_COVER_STYLE}</div>
              <button
                onClick={() => setEditingCover(true)}
                className="serif"
                style={{ marginLeft: 'auto', flexShrink: 0, border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontSize: '0.78rem', color: 'var(--text-muted)' }}
              >
                編集
              </button>
            </div>
          )}
        </div>
        <div style={hintStyle}>How every cover looks. Each song picks its own scene.</div>

        <SubHeading count={`${onHosts.length} of ${ALL_HOST_IDS.length}`}>Podcast hosts</SubHeading>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
          {ALL_HOST_IDS.map((id) => {
            const m = PODCAST_CAST[id];
            const custom = podcastPersonas[id];
            return (
              <PickRow
                key={id}
                on={onHosts.includes(id)}
                name={m.name}
                tag={m.dialect}
                desc={custom || m.persona}
                onToggle={() => { if (editingHost !== id) toggleHost(id); }}
                onEdit={() => setEditingHost(id)}
              >
                {editingHost === id ? (
                  <TextEditor
                    original={m.persona}
                    current={custom || m.persona}
                    onSave={(t) => setPodcastPersona(id, t)}
                    onClose={() => setEditingHost(null)}
                  />
                ) : undefined}
              </PickRow>
            );
          })}
        </div>
        <div style={hintStyle}>Two hosts stay on, one of them speaking standard Japanese.</div>
      </section>

      {/* ── 表示 ── */}
      <section style={{ marginBottom: '2.5rem' }}>
        <h3 lang="ja" style={sectionTitle}>表示</h3>
        <div style={settingStyle}>
          <div style={labelStyle}>Interface</div>
          <SliderToggle options={UI_LANGUAGE_OPTIONS} value={uiLanguage} onChange={setUiLanguage} ariaLabel="Interface language" />
          <div style={hintStyle}>
            {uiLanguage === 'english' && 'Titles and tabs stay in English.'}
            {uiLanguage === 'adaptive' && 'Titles and tabs turn Japanese as you learn their words.'}
            {uiLanguage === 'japanese' && 'Titles and tabs are always Japanese.'}
          </div>
        </div>
        <div style={settingStyle}>
          <div style={labelStyle}>Text size <small style={smallStyle}>{readerFontSize}px</small></div>
          <input type="range" min={14} max={32} value={readerFontSize} onChange={(e) => setReaderFontSize(parseInt(e.target.value, 10))} aria-label="Text size" style={{ width: '100%', accentColor: 'var(--text-main)' }} />
        </div>
        <div style={settingStyle}>
          <div style={labelStyle}>Weight <small style={smallStyle}>{readerFontWeight}</small></div>
          <input type="range" min={300} max={700} step={100} value={readerFontWeight} onChange={(e) => setReaderFontWeight(parseInt(e.target.value, 10))} aria-label="Font weight" style={{ width: '100%', accentColor: 'var(--text-main)' }} />
        </div>
      </section>

      <style>{`
        details[open] .advanced-chevron { transform: rotate(-180deg); }
        details summary::-webkit-details-marker { display: none; }
        input[type=number]::-webkit-inner-spin-button, input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
      `}</style>

      {/* ── 詳細: one-off maintenance tools ── */}
      <details style={{ marginBottom: '3rem' }}>
        <summary lang="ja" className="serif" style={{ listStyle: 'none', outline: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem', fontSize: '0.9rem', color: 'var(--text-muted)' }}>
          詳細
          <ChevronDown size={16} className="advanced-chevron" style={{ transition: 'transform 0.3s ease' }} />
        </summary>

        <div style={{ marginTop: '1rem' }}>
      {/* Rebalance Flashcard Deck — one-time study-pacing correction (the #67
          seed-on-sight flood). Self-hides once run: the queue + pre-due window keep
          the deck healthy afterward, so it's a one-shot, not a recurring knob. */}
      {lastStudyPacingResetTs == null && (
        <>
          <div style={{ width: '40px', height: '2px', backgroundColor: 'var(--border-light)', margin: '2rem 0' }} />
          <div style={{ marginBottom: '1.5rem' }}>
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-main)', marginBottom: '0.75rem' }}>
              Rebalance Flashcard Deck
            </label>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: '1.2rem' }}>
              A one-time cleanup so flashcards augment reading instead of flooding you. Words you already find easy stay scheduled but pushed far out (reading keeps them fresh); harder words move back into the queue to drip in a few per day. Nothing is deleted. You only need to run this once.
            </p>
            <button
              onClick={async () => {
                if (!window.confirm('Rebalance your flashcard deck? Easy words get pushed far out; harder words return to the daily queue. Nothing is deleted. This is a one-time cleanup.')) return;
                const { useAppStore } = await import('../services/store');
                const r = await useAppStore.getState().resetStudyPacing();
                window.alert(`Study pacing reset.\n\n${r.keptActive} easy words kept on a far-out schedule.\n${r.requeued} words moved back to the queue (a few graduate into flashcards each day).`);
              }}
              style={{
                width: '100%', padding: '0.9rem', borderRadius: '12px', backgroundColor: 'transparent',
                color: 'var(--text-main)', border: '2px solid var(--border-light)', fontWeight: 700,
                fontSize: '0.9rem', cursor: 'pointer', letterSpacing: '0.03em',
              }}
            >
              Rebalance Flashcard Deck
            </button>
          </div>
        </>
      )}

      {/* Re-align Furigana — one-time cleanup of the stored furiganaMap
          back-catalog: maps saved before the per-kanji reading tables were
          wired up (see main.tsx) carry one grouped reading per kanji run
          (意味 → いみ over the pair) instead of per-kanji splits (い/み).
          Local-only re-derive, nothing scheduled or deleted. Self-hides. */}
      {lastFuriganaRealignTs == null && (
        <>
          <div style={{ width: '40px', height: '2px', backgroundColor: 'var(--border-light)', margin: '2rem 0' }} />
          <div style={{ marginBottom: '1.5rem' }}>
            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-main)', marginBottom: '0.75rem' }}>
              Re-align Furigana
            </label>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: '1.2rem' }}>
              A one-time cleanup of saved furigana: readings now split per kanji (意味 → い・み), but words saved earlier still show one grouped reading. Recomputes them on this device — nothing else changes. You only need to run this once.
            </p>
            <button
              onClick={async () => {
                const { useAppStore } = await import('../services/store');
                const r = await useAppStore.getState().realignFurigana();
                window.alert(`Furigana re-aligned.\n\n${r.updated} of ${r.scanned} words updated.`);
              }}
              style={{
                width: '100%', padding: '0.9rem', borderRadius: '12px', backgroundColor: 'transparent',
                color: 'var(--text-main)', border: '2px solid var(--border-light)', fontWeight: 700,
                fontSize: '0.9rem', cursor: 'pointer', letterSpacing: '0.03em',
              }}
            >
              Re-align Furigana
            </button>
          </div>
        </>
      )}

      {/* Sandbox Study Mode — the minimal slice of #6, required before
          long-form Phase B testing (design §7): word-progress writes
          (reader grades, lookups, flashcard reviews, manual sets) are
          skipped local + server while it's on, so test reading never
          pollutes real SRS state. Deliberately loud when enabled. */}
      <div style={{ width: '40px', height: '2px', backgroundColor: 'var(--border-light)', margin: '2rem 0' }} />
      <div style={{
        marginBottom: '1.5rem',
        padding: sandboxMode ? '1.2rem' : 0,
        borderRadius: '12px',
        border: sandboxMode ? '1px solid #b8860b55' : 'none',
        backgroundColor: sandboxMode ? '#b8860b0d' : 'transparent',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
          <label style={{ fontSize: '0.85rem', fontWeight: 600, color: sandboxMode ? '#b8860b' : 'var(--text-main)' }}>
            Sandbox Study Mode {sandboxMode && '— ON'}
          </label>
          <button
            onClick={() => setSandboxMode(!sandboxMode)}
            aria-label="Toggle sandbox study mode"
            style={{
              width: '48px',
              height: '28px',
              borderRadius: '100px',
              border: 'none',
              cursor: 'pointer',
              backgroundColor: sandboxMode ? '#b8860b' : 'var(--border-light)',
              position: 'relative',
              transition: 'background-color 0.25s',
              flexShrink: 0,
            }}
          >
            <span style={{
              position: 'absolute',
              top: '3px',
              left: sandboxMode ? '23px' : '3px',
              width: '22px',
              height: '22px',
              borderRadius: '50%',
              backgroundColor: 'var(--bg-pure)',
              boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
              transition: 'left 0.25s',
            }} />
          </button>
        </div>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1.5, margin: 0 }}>
          {sandboxMode
            ? 'Nothing you read or grade is being recorded — word progress, lookups, and flashcard reviews are all skipped. Turn this off when you finish testing.'
            : 'For testing: read and grade without recording anything to your word progress or SRS schedule.'}
        </p>
      </div>

      {/* 5. Danger Zone */}
      <div style={{ padding: '1.5rem', borderRadius: '16px', border: '1px solid #ff444433', backgroundColor: '#ff444408', marginTop: '4rem', marginBottom: '1.5rem' }}>
        <h3 style={{ fontSize: '0.85rem', fontWeight: 900, color: '#ff4444', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '1rem' }}>Danger Zone</h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1.5rem', lineHeight: 1.5 }}>
          Wipes your entire study history, word mastery levels, and SRS data from both your phone and the server. This cannot be undone.
        </p>
        <button
          onClick={() => {
            if (window.confirm("Nuclear Reset: Are you absolutely sure? Your entire study history will be permanently deleted.")) {
              import('../services/store').then(m => m.useAppStore.getState().resetProgress());
            }
          }}
          style={{
            width: '100%',
            padding: '1rem',
            borderRadius: '12px',
            backgroundColor: 'transparent',
            color: '#ff4444',
            border: '2px solid #ff4444',
            fontWeight: 800,
            fontSize: '0.9rem',
            cursor: 'pointer',
            textTransform: 'uppercase',
            letterSpacing: '0.05em'
          }}
        >
          Reset All Progress
        </button>
      </div>

      {/* Acknowledgements — required attribution for the bundled dictionary. */}
      <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: 1.6, marginTop: '2rem', opacity: 0.7 }}>
        Japanese analysis by kuromoji.js (Apache-2.0). Dictionary data from
        mecab-ipadic, © Nara Institute of Science and Technology (NAIST). See
        THIRD_PARTY_LICENSES for full notices.
      </p>
        </div>
      </details>
    </div>
  );
}
