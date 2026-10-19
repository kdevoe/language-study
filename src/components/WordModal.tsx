import { motion, AnimatePresence } from 'framer-motion';
import { BookOpen, ChevronLeft, ChevronRight, Sparkles } from 'lucide-react';
import { useAppStore } from '../services/store';
import { GRAMMAR_POINTS } from '../services/grammar/catalogue';
import type { GrammarHit } from '../services/grammar/reader';
import { canonicalWordKey } from '../services/wordKey';
import { rtkKanjiMap } from '../data/rtkKanji';
import { useEffect, useRef } from 'react';
import { useScrollLock } from '../hooks/useScrollLock';
import { useTutorMaybe } from './tutor/TutorProvider';
import type { ScreenContext } from '../services/tutor';

export interface WordDetails {
  word: string;
  reading: string;
  meaning: string;
  grammarNote?: string;
  furiganaMap?: { kanji: string; kana: string }[];
  jmdictEntryId?: string;
  pos?: string[];
  jlptLevel?: number | null;
  /** True when jlptLevel was inferred (kanji/frequency) rather than an official tag. */
  jlptDerived?: boolean;
  /** JMDict freq_rank (1 = most common; null = rare/unranked). Feeds intake ordering (#68). */
  freqRank?: number | null;
}

/** An open grammar panel (#43): the point, and the sentence it was met in (absent
 *  when opened from a formal/casual partner link). */
export interface GrammarView {
  id: string;
  hit?: GrammarHit;
  /** AI insight about the point in this sentence. */
  insight?: string;
  /** The word under the tapped piece, for "As a word". */
  asWord?: string;
}

const OLIVE = '#4a5d23';
const MARK_BG = 'linear-gradient(transparent 60%, var(--accent-primary) 60%, var(--accent-primary) 94%, transparent 94%)';

/** Text with [start, end) marked, as in the catalogue examples (【】) and この文では. */
function Marked({ text, start, end }: { text: string; start: number; end: number }) {
  return (
    <>
      {text.slice(0, start)}
      <span style={{ background: MARK_BG }}>{text.slice(start, end)}</span>
      {text.slice(end)}
    </>
  );
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onDismissStart?: () => void; 
  mode: 'word' | 'sentence' | 'grammar';
  wordData: WordDetails | null;
  /** Word mode: the sentence the word was tapped in. */
  wordSentence?: string;
  sentenceText?: string;
  sentenceTranslation?: string;
  anchor: 'top' | 'bottom';
  onSetMastery?: (level: 'hard' | 'medium' | 'easy') => void;
  isLoading?: boolean;
  targetRect?: DOMRect | null;
  /** Grammar (#43). `grammar` is the open point (mode 'grammar'); `patterns` the
   *  word's points (PATTERNS rows); `sentencePoints` the 。 sentence's points. */
  grammar?: (GrammarView & { backLabel?: string }) | null;
  patterns?: GrammarHit[];
  sentencePoints?: GrammarHit[];
  onOpenPoint?: (id: string, hit?: GrammarHit) => void;
  onGrammarBack?: () => void;
  onAsWord?: () => void;
}

export function WordModal({ 
  isOpen, onClose, onDismissStart, mode, wordData, wordSentence,
  sentenceText, sentenceTranslation,
  anchor, onSetMastery, isLoading, targetRect,
  grammar, patterns = [], sentencePoints = [], onOpenPoint, onGrammarBack, onAsWord,
}: Props) {
  const wordDatabase = useAppStore(state => state.wordDatabase);
  const grammarProgress = useAppStore(state => state.grammarProgress);
  const scrollRef = useRef<HTMLDivElement>(null);

  const SYNC_DURATION = 1.05;
  const SYNC_EASE = [0.16, 1, 0.3, 1]; 

  useScrollLock(isOpen);

  // Opening a point is its lookup (store.noteGrammarOpen): met → medium, opened on
  // three separate days → hard, unless the learner rated it on the slider.
  const noteGrammarOpen = useAppStore(state => state.noteGrammarOpen);
  const openPointId = isOpen && grammar && GRAMMAR_POINTS[grammar.id] ? grammar.id : null;
  useEffect(() => {
    if (openPointId) noteGrammarOpen(openPointId);
  }, [openPointId, noteGrammarOpen]);

  useEffect(() => {
    if (isOpen && anchor === 'top' && !isLoading && scrollRef.current) {
      setTimeout(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = 9999;
      }, 50);
    }
  }, [isOpen, anchor, isLoading]);

  useEffect(() => {
    if (isOpen && anchor === 'top' && !isLoading && scrollRef.current) {
       scrollRef.current.scrollTop = 9999;
    }
  }, [isLoading, wordData, isOpen, anchor]);

  const Skeleton = ({ width = '100%', height = '1rem', style = {} }) => (
    <div className="skeleton-shimmer" style={{ 
      width, height, 
      backgroundColor: 'var(--border-light)', 
      borderRadius: '4px',
      marginBottom: '0.5rem',
      ...style 
    }} />
  );

  const renderSlider = (active: string) => {
    const levels = ['easy', 'medium', 'hard'] as const;
    const activeIndex = Math.max(0, levels.indexOf(active as typeof levels[number]));
    return (
      <div style={{ display: 'flex', backgroundColor: 'var(--border-light)', borderRadius: '100px', padding: '4px', height: '42px', position: 'relative' }}>
        <motion.div 
          initial={false}
          animate={{ left: `calc(4px + ${activeIndex} * (100% - 8px) / 3)` }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          style={{
            position: 'absolute', top: '4px', bottom: '4px',
            width: `calc((100% - 8px) / 3)`,
            backgroundColor: 'var(--bg-pure)', borderRadius: '100px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
            zIndex: 0
          }} 
        />
        {levels.map(level => (
          <button key={level} onClick={() => onSetMastery?.(level)} style={{ flex: 1, borderRadius: '100px', backgroundColor: 'transparent', color: active === level ? 'var(--text-main)' : 'var(--text-muted)', fontWeight: active === level ? 800 : 700, border: 'none', cursor: 'pointer', fontSize: '0.9rem', display: 'flex', justifyContent: 'center', alignItems: 'center', position: 'relative', zIndex: 1, textTransform: 'uppercase' }}>
            {level}
          </button>
        ))}
      </div>
    );
  };

  // ハルカに聞く: open the tutor about exactly this word / point / sentence. The
  // screen's own chip (the article, the episode) rides along after it.
  const tutor = useTutorMaybe();
  const askHaruka = () => {
    if (!tutor) return;
    const screen = tutor.snapshot();
    const where = screen?.detail ? ` ${screen.detail}` : '';
    const withScreen = (chip: string) => (screen?.chip ? `${chip} · ${screen.chip}` : chip);
    let ask: ScreenContext | null = null;
    if (mode === 'grammar' && grammar) {
      const p = GRAMMAR_POINTS[grammar.id];
      if (p) ask = {
        screen: screen?.screen ?? 'lookup',
        chip: withScreen(p.pattern),
        detail: `The learner opened the grammar point ${p.pattern} (${p.meaning}; id ${p.id}; their rating ${(grammarProgress[p.id]?.mastery ?? 'unrated').toUpperCase()})${grammar.hit ? ` as used in 「${grammar.hit.sentence}」` : ''} and asked you about it.${where}`,
      };
    } else if (mode === 'sentence' && sentenceText) {
      ask = {
        screen: screen?.screen ?? 'lookup',
        chip: withScreen(`「${sentenceText.length > 10 ? `${sentenceText.slice(0, 10)}…` : sentenceText}」`),
        detail: `The learner tapped this sentence to translate it: 「${sentenceText}」${sentenceTranslation ? ` (app translation: "${sentenceTranslation}")` : ''} and asked you about it.${where}`,
      };
    } else if (wordData) {
      ask = {
        screen: screen?.screen ?? 'lookup',
        chip: withScreen(wordData.word),
        detail: `The learner looked up ${wordData.word} (${wordData.reading}; ${wordData.meaning || 'no gloss'}${wordData.jlptLevel ? `; N${wordData.jlptLevel}` : ''})${wordSentence ? ` in the sentence 「${wordSentence}」` : ''} and asked you about it.${where}`,
      };
    }
    if (!ask) return;
    executeClose();
    tutor.openTutor({ ask });
  };
  const askButton = tutor ? (
    <button key="ask" className="tutor-ask" onClick={askHaruka}>
      <span className="tutor-av sm">ハ</span>ハルカに聞く<ChevronRight size={15} />
    </button>
  ) : null;

  const kickerStyle: React.CSSProperties ={ fontSize: '0.7rem', fontWeight: 900, color: OLIVE, display: 'flex', alignItems: 'center', gap: '0.5rem', letterSpacing: '0.05em' };
  const subKickerStyle: React.CSSProperties = { fontSize: '0.66rem', fontWeight: 800, letterSpacing: '0.1em', color: 'var(--text-muted)', margin: '1.1rem 0 0.35rem' };

  /** One grammar point as a tappable row (PATTERNS, the sentence's list). The dot
   *  is filled until the point is marked EASY. */
  const renderPointRows = (hits: GrammarHit[]) => {
    const seen = new Set<string>();
    return hits.filter(h => GRAMMAR_POINTS[h.id] && !seen.has(h.id) && seen.add(h.id)).map((h, i) => {
      const p = GRAMMAR_POINTS[h.id];
      const known = grammarProgress[h.id]?.mastery === 'easy';
      return (
        <div key={h.id} onClick={() => onOpenPoint?.(h.id, h)} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.55rem 0', cursor: 'pointer', borderTop: i ? '1px solid var(--border-light)' : undefined }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', flex: 'none', backgroundColor: known ? 'transparent' : 'var(--accent-progress)', border: known ? '1px solid var(--border-light)' : undefined }} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span className="serif" style={{ fontSize: '1.12rem', color: 'var(--text-main)', whiteSpace: 'nowrap' }}>{p.pattern}</span>
            <span style={{ fontSize: '0.62rem', fontWeight: 800, color: OLIVE, marginLeft: '0.45rem' }}>N{p.level}</span>
            <span style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.35 }}>{p.meaning}</span>
          </span>
          <ChevronRight size={16} color="var(--text-muted)" />
        </div>
      );
    });
  };

  const renderGrammar = () => {
    const p = grammar && GRAMMAR_POINTS[grammar.id];
    if (!grammar || !p) return null;
    const hit = grammar.hit;
    const partner = p.partner && GRAMMAR_POINTS[p.partner];
    const linkStyle: React.CSSProperties = { marginTop: '1rem', fontSize: '0.8rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.3rem', cursor: 'pointer', background: 'none', border: 'none', padding: 0 };
    const sections = [
      <div key="head" style={{ marginBottom: '0.9rem' }}>
        {grammar.backLabel && (
          <button onClick={onGrammarBack} style={{ ...linkStyle, marginTop: 0, marginBottom: '0.4rem', gap: '0.1rem', fontSize: '0.78rem' }}>
            <ChevronLeft size={15} /> {grammar.backLabel}
          </button>
        )}
        <div style={kickerStyle}><BookOpen size={13} /> GRAMMAR</div>
        <div className="serif" style={{ fontSize: '2.1rem', fontWeight: 500, lineHeight: 1.2, margin: '0.2rem 0 0.5rem', color: 'var(--text-main)' }}>{p.pattern}</div>
        <p className="serif" style={{ fontSize: '1.15rem', color: 'var(--text-main)', lineHeight: 1.45 }}>
          <span className="sans" style={{ fontSize: '0.85rem', fontWeight: 800, color: OLIVE, marginRight: '0.6rem', opacity: 0.8 }}>N{p.level}</span>
          {p.meaning}
        </p>
      </div>,
      <div key="mastery" style={{ marginBottom: '1.3rem' }}>{renderSlider(grammarProgress[p.id]?.mastery ?? 'medium')}</div>,
      hit && (
        <div key="insight" style={{ backgroundColor: 'var(--bg-card)', padding: '1rem', borderRadius: '14px', borderLeft: `5px solid ${OLIVE}`, marginBottom: '0.3rem' }}>
          <div style={{ ...kickerStyle, marginBottom: '0.55rem' }}><BookOpen size={13} /> GRAMMAR INSIGHT</div>
          {grammar.insight ? (
            <motion.p key={grammar.insight} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }} className="serif" style={{ color: 'var(--text-main)', fontSize: '1.05rem', lineHeight: 1.6 }}>{grammar.insight}</motion.p>
          ) : (
            <><Skeleton width="100%" height="1rem" /><Skeleton width="70%" height="1rem" /></>
          )}
        </div>
      ),
      hit && (
        <div key="sentence">
          <div style={subKickerStyle}>この文では</div>
          <p className="serif" style={{ fontSize: '1.05rem', lineHeight: 1.7, color: 'var(--text-main)' }}><Marked text={hit.sentence} start={hit.start} end={hit.end} /></p>
        </div>
      ),
      <div key="built">
        <div style={subKickerStyle}>HOW IT'S BUILT</div>
        <div style={{ backgroundColor: 'var(--bg-card)', borderRadius: '12px', padding: '0.6rem 0.8rem', display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {p.formation.map((x, k) => k === 0 || x.startsWith('（') ? (
            <span key={k} className="sans" style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', backgroundColor: 'var(--bg-pure)', borderRadius: '6px', padding: '0.15rem 0.45rem' }}>{x}</span>
          ) : (
            <span key={k} className="serif" style={{ fontSize: '1rem', color: 'var(--text-main)' }}>{x}</span>
          ))}
        </div>
      </div>,
      <div key="usage">
        <div style={subKickerStyle}>使い方</div>
        <p style={{ fontSize: '0.86rem', lineHeight: 1.6, color: 'var(--text-main)' }}>{p.note}</p>
      </div>,
      <div key="examples">
        <div style={subKickerStyle}>例</div>
        {p.examples.map((ex, k) => {
          const [before, mark = '', after = ''] = ex.ja.split(/[【】]/);
          return (
            <div key={k} style={{ marginTop: '0.25rem' }}>
              <p className="serif" style={{ fontSize: '1.05rem', lineHeight: 1.7, color: 'var(--text-main)' }}><Marked text={before + mark + after} start={before.length} end={before.length + mark.length} /></p>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{ex.en}</p>
            </div>
          );
        })}
      </div>,
      (partner || grammar.asWord) && (
        <div key="links" style={{ marginBottom: '1.5rem' }}>
          {partner && (
            <button onClick={() => onOpenPoint?.(partner.id)} style={linkStyle}>
              {p.casual ? 'Formal:' : partner.casual ? 'In speech:' : 'Compare:'} <span className="serif" style={{ fontSize: '1rem', color: 'var(--text-main)' }}>{partner.pattern}</span><ChevronRight size={15} />
            </button>
          )}
          {grammar.asWord && (
            <button onClick={onAsWord} style={linkStyle}>
              As a word: <span className="serif" style={{ fontSize: '1rem', color: 'var(--text-main)' }}>{grammar.asWord}</span><ChevronRight size={15} />
            </button>
          )}
        </div>
      ),
      askButton,
    ];
    return (
      <div style={{ display: 'flex', flexDirection: anchor === 'bottom' ? 'column' : 'column-reverse', paddingBottom: anchor === 'bottom' ? '1rem' : 0 }}>
        {sections}
      </div>
    );
  };

  const renderContent = () => {
    if (mode === 'grammar') return renderGrammar();
    if (mode === 'sentence') {
      return (
        <div style={{ padding: '0.1rem 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.5rem' }}>
            <Sparkles size={13} color="var(--text-muted)" />
            <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.1em' }}>AI SENTENCE ANALYSIS</span>
          </div>
          <p className="serif" style={{ fontSize: '1.25rem', lineHeight: 1.45, color: 'var(--text-main)', marginBottom: '0.75rem', backgroundColor: 'var(--bg-card)', padding: '0.75rem 1rem', borderRadius: '12px' }}>
            {sentenceText}
          </p>
          {isLoading ? (
             <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', paddingLeft: '0.6rem' }}>
                <Skeleton width="90%" height="1.1rem" />
                <Skeleton width="60%" height="1.1rem" />
             </div>
          ) : (
            <motion.p 
              key={sentenceTranslation}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
              className="sans" 
              style={{ fontSize: '1.1rem', lineHeight: 1.45, color: 'var(--text-main)', paddingLeft: '0.6rem', borderLeft: '4px solid #4a5d23' }}
            >
              {sentenceTranslation}
            </motion.p>
          )}
          {sentencePoints.length > 0 && (
            <div style={{ backgroundColor: 'var(--bg-card)', padding: '0.9rem 1rem', borderRadius: '14px', borderLeft: `5px solid ${OLIVE}`, margin: '1.2rem 0 1rem' }}>
              <div style={{ ...kickerStyle, marginBottom: '0.3rem' }}><BookOpen size={13} /> GRAMMAR · {new Set(sentencePoints.map(h => h.id)).size} IN THIS SENTENCE</div>
              {renderPointRows(sentencePoints)}
            </div>
          )}
          {!isLoading && <div style={{ marginTop: '1rem' }}>{askButton}</div>}
        </div>
      );
    }

    if (!wordData) return null;
    const stats = wordDatabase[canonicalWordKey({ jmdictEntryId: wordData.jmdictEntryId, word: wordData.word })];
    const activeMastery = (!stats || stats.mastery === 'unseen') ? 'medium' : stats.mastery;

    const getTrackedSegments = () => {
      let segments = wordData.furiganaMap || [];
      
      // Safety: If segments don't cover the full word string, "Heal" it by appending the missing tail
      const mappedWord = segments.map(s => s.kanji).join('');
      if (mappedWord !== wordData.word && wordData.word.startsWith(mappedWord)) {
        const extraChars = wordData.word.slice(mappedWord.length);
        const chars = Array.from(extraChars);
        const recovered = chars.map(c => ({ kanji: c, kana: c }));
        segments = [...segments, ...recovered];
      }

      if (segments.length > 0) return segments;

      // FALLBACK: Manual Guessing...
      const chars = Array.from(wordData.word);
      const r = wordData.reading;
      if (chars.length > 1 && r.length === chars.length * 2) {
         return chars.map((c, i) => ({ kanji: c, kana: r.substr(i*2, 2) }));
      }
      if (chars.length > 1 && r.length === chars.length) {
         return chars.map((c, i) => ({ kanji: c, kana: r[i] }));
      }
      const isKana = (c: string) => !!c.match(/[\u3040-\u309f\u30a0-\u30ff]/);
      if (chars.length === 2 && !isKana(chars[0]) && isKana(chars[1])) {
         return [
           { kanji: chars[0], kana: r.slice(0, Math.max(0, r.length - 1)) },
           { kanji: chars[1], kana: r.slice(-1) }
         ];
      }
      return null;
    };

    const segments = getTrackedSegments();

    // The grammar points this word takes part in, under its insight.
    const patternRows = patterns.length > 0 && (
      <>
        <div style={{ borderTop: '1px solid var(--border-light)', margin: '0.8rem 0 0.1rem', paddingTop: '0.6rem', fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.1em', color: 'var(--text-muted)' }}>PATTERNS</div>
        {renderPointRows(patterns)}
      </>
    );

    const sections = {
      header: (
        <div key="header" style={{ 
          marginBottom: '0.85rem', 
          display: 'flex', 
          gap: '1.25rem', 
          flexWrap: 'wrap', 
          alignItems: 'baseline', 
          justifyContent: anchor === 'top' ? 'center' : 'flex-start' 
        }}>
          {segments ? (
            segments.map((s, idx) => {
              // A multi-kanji segment (e.g. \u5927\u7d71\u9818 \u2192 \u3060\u3044\u3068\u3046\u308a\u3087\u3046) carries one
              // reading over the whole run \u2014 we don't have per-character readings,
              // so center the reading above the group and show each kanji's RTK
              // keyword below, rather than guess a wrong per-kanji split.
              const kanjiChars = Array.from(s.kanji);
              return (
                <div key={idx} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <span style={{
                    height: '0.9rem', fontSize: '0.75rem',
                    color: 'var(--text-muted)', letterSpacing: '0.04em',
                    fontFamily: 'var(--font-sans)', fontWeight: 800,
                    opacity: s.kanji === s.kana ? 0 : 1
                  }}>
                    {s.kana}
                  </span>
                  <div style={{ display: 'flex', gap: '1.25rem', alignItems: 'baseline' }}>
                    {kanjiChars.map((char, ci) => (
                      <div key={ci} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <span className="serif" style={{ fontSize: '2.8rem', lineHeight: 1, color: 'var(--text-main)', fontWeight: 500 }}>{char}</span>
                        <span style={{ height: '0.8rem', fontSize: '0.55rem', color: '#4a5d23', textTransform: 'uppercase', marginTop: '0.1rem', fontFamily: 'var(--font-sans)', fontWeight: 800, letterSpacing: '0.04em' }}>
                          {rtkKanjiMap[char] || ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          ) : (
             <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', letterSpacing: '0.25em', marginBottom: '0.2rem', fontFamily: 'var(--font-sans)', fontWeight: 800 }}>{wordData.reading}</span>
                <div style={{ display: 'flex', gap: '1.25rem', alignItems: 'baseline', justifyContent: 'center' }}>
                  {Array.from(wordData.word).map((char, i) => (
                    <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      <span className="serif" style={{ fontSize: '2.8rem', lineHeight: 1, color: 'var(--text-main)', fontWeight: 500 }}>{char}</span>
                      <span style={{ height: '0.8rem', fontSize: '0.55rem', color: '#4a5d23', textTransform: 'uppercase', marginTop: '0.1rem', fontFamily: 'var(--font-sans)', fontWeight: 800, letterSpacing: '0.04em' }}>
                        {rtkKanjiMap[char] || ''}
                      </span>
                    </div>
                  ))}
                </div>
             </div>
          )}
        </div>
      ),
      translation: (
        <div key="translation" style={{ marginBottom: '1.5rem', textAlign: anchor === 'top' ? 'center' : 'left' }}>
          {!wordData.meaning ? (
            isLoading ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: anchor === 'top' ? 'center' : 'flex-start', gap: '0.4rem' }}>
                <Skeleton width="80%" height="1.25rem" />
              </div>
            ) : (
              // Terminal state: the lookup finished with no gloss. Never leave a
              // skeleton up when nothing more is coming, or it reads as a hang.
              <p className="serif" style={{ fontSize: '1.1rem', color: 'var(--text-muted)', fontStyle: 'italic', lineHeight: 1.5 }}>
                No dictionary definition available.
              </p>
            )
          ) : (
            <>
              <motion.p 
                key={wordData.meaning}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.3 }}
                className="serif" 
                style={{ fontSize: '1.25rem', color: 'var(--text-main)', lineHeight: 1.5 }}
              >
                {wordData.jlptLevel && (
                  <span className="sans" style={{
                    fontSize: '0.85rem', fontWeight: 800, color: '#4a5d23',
                    marginRight: '0.6rem', opacity: 0.8, verticalAlign: 'middle'
                  }}
                  title={wordData.jlptDerived ? 'Approximate level (inferred from kanji / frequency)' : undefined}>
                    {wordData.jlptDerived ? '≈' : ''}N{wordData.jlptLevel}
                  </span>
                )}
                {wordData.meaning}
              </motion.p>
            </>
          )}
        </div>
      ),
      mastery: (
        <div key="mastery" style={{ marginBottom: '1.5rem' }}>
          {renderSlider(activeMastery || 'medium')}
        </div>
      ),
      grammar: (!wordData.grammarNote) ? (
        <div key="grammar" style={{ backgroundColor: 'var(--bg-card)', padding: '1rem', borderRadius: '14px', borderLeft: '5px solid #4a5d23', marginBottom: '2.5rem' }}>
           <div style={{ fontSize: '0.7rem', fontWeight: 900, color: '#4a5d23', display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.6rem', letterSpacing: '0.05em' }}><BookOpen size={13} /> INSIGHT</div>
           <Skeleton width="100%" height="1rem" />
           <Skeleton width="70%" height="1rem" />
           {patternRows}
        </div>
      ) : (
        <motion.div 
          key={wordData.grammarNote}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          style={{ backgroundColor: 'var(--bg-card)', padding: '1rem', borderRadius: '14px', borderLeft: '5px solid #4a5d23', marginBottom: '2.5rem' }}
        >
          <div style={{ fontSize: '0.7rem', fontWeight: 900, color: '#4a5d23', display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', letterSpacing: '0.05em' }}><BookOpen size={13} /> INSIGHT</div>
          <p className="serif" style={{ color: 'var(--text-main)', fontSize: '1.1rem', lineHeight: 1.55 }}>{wordData.grammarNote}</p>
          {patternRows}
        </motion.div>
      ),
      status: stats && stats.timesSeen > 0 && (
        <div key="status" style={{ display: 'flex', gap: '0.6rem', padding: '0.6rem', backgroundColor: 'var(--bg-card)', opacity: 0.65, border: '1px solid var(--border-light)', borderRadius: '10px', marginBottom: '0.5rem' }}>
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: '0.5rem', color: 'var(--text-muted)', fontWeight: 700 }}>SEEN</div>
            <div style={{ fontSize: '1rem', fontWeight: 900, color: 'var(--text-main)', marginTop: '0.1rem' }}>{stats.timesSeen} <span style={{fontSize: '0.8rem', fontWeight: 400}}>x</span></div>
          </div>
          <div style={{ width: '1px', backgroundColor: 'var(--border-light)' }} />
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: '0.5rem', color: 'var(--text-muted)', fontWeight: 700 }}>STREAK</div>
            <div style={{ fontSize: '1rem', fontWeight: 900, color: 'var(--text-main)', marginTop: '0.1rem' }}>{stats.streak || 0}</div>
          </div>
          <div style={{ width: '1px', backgroundColor: 'var(--border-light)' }} />
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: '0.5rem', color: 'var(--text-muted)', fontWeight: 700 }}>RANK</div>
            <div style={{ fontSize: '0.9rem', fontWeight: 900, color: 'var(--text-main)', marginTop: '0.3rem', textTransform: 'capitalize' }}>
              {activeMastery}
              {stats.difficulty != null && (
                <span style={{ fontSize: '0.6rem', fontWeight: 700, color: 'var(--text-muted)', marginLeft: '0.3rem' }}>{stats.difficulty}/10</span>
              )}
            </div>
          </div>
        </div>
      )
    };

    // The ask link tucks up under the INSIGHT box (which keeps a wide gap below it).
    const ask = askButton && <div key="ask" style={{ marginTop: anchor === 'bottom' ? '-1.5rem' : 0 }}>{askButton}</div>;
    const orderedList = [sections.header, sections.translation, sections.mastery, sections.grammar, ask, sections.status];
    
    return (
      <div style={{ 
        display: 'flex', 
        flexDirection: anchor === 'bottom' ? 'column' : 'column-reverse'
      }}>
        {orderedList.map(s => s)}
      </div>
    );
  };

  const executeClose = () => {
    if (onDismissStart) onDismissStart();
    onClose();
  };

  // COLLISION AVOIDANCE: Logic to stop drawer before it covers the word
  // Taller (70%) when there's grammar to show: an open point, PATTERNS rows, or a
  // sentence's points (#43). The collision rule below still applies.
  const getDynamicMaxHeight = () => {
    const hasGrammar = mode === 'grammar' || (mode === 'word' && patterns.length > 0) || (mode === 'sentence' && sentencePoints.length > 0);
    const cap = window.innerHeight * (hasGrammar ? 0.70 : 0.52);
    if (anchor === 'top' && targetRect) {
      // Gap of 2rem (32px) from the word
      const available = targetRect.top - 32;
      return Math.min(cap, Math.max(120, available));
    }
    if (anchor === 'bottom' && targetRect && hasGrammar) {
      // The taller cap could reach a word in the upper screen: stop short of it,
      // but never below the usual 52%.
      const available = window.innerHeight - targetRect.bottom - 32;
      return Math.min(cap, Math.max(window.innerHeight * 0.52, available));
    }
    return cap;
  };

  const dynamicMaxHeight = getDynamicMaxHeight();

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div 
            initial={{ opacity: 0 }} 
            animate={{ opacity: 1 }} 
            exit={{ opacity: 0 }} 
            onClick={executeClose}
            transition={{ duration: SYNC_DURATION }}
            style={{ 
              position: 'fixed', 
              top: 0, left: 0, right: 0, bottom: 0, 
              backgroundColor: 'transparent',
              zIndex: 40 
            }}
          />
          <motion.div
            drag="y" 
            dragDirectionLock={true} 
            dragConstraints={{ 
              top: anchor === 'top' ? -1000 : 0, 
              bottom: anchor === 'bottom' ? 1000 : 0,
              left: 0, right: 0
            }} 
            dragElastic={0.08}
            onDragEnd={(_, info) => {
              const vy = info.velocity.y;
              const dy = info.offset.y;
              const shouldClose = anchor === 'bottom' 
                ? (vy > 250 || dy > 40) 
                : (vy < -250 || dy < -40);

              if (shouldClose) {
                executeClose();
              }
            }}
            initial={{ y: anchor === 'bottom' ? '100%' : '-100%' }}
            animate={{ y: 0 }}
            exit={{ y: anchor === 'bottom' ? '120%' : '-120%' }} 
            transition={{ duration: SYNC_DURATION, ease: SYNC_EASE as any }}
            style={{
              position: 'fixed',
              [anchor === 'bottom' ? 'bottom' : 'top']: 0, left: 0, right: 0,
              backgroundColor: 'var(--bg-pure)',
              borderBottomLeftRadius: anchor === 'top' ? '24px' : 0,
              borderBottomRightRadius: anchor === 'top' ? '24px' : 0,
              borderTopLeftRadius: anchor === 'bottom' ? '24px' : 0,
              borderTopRightRadius: anchor === 'bottom' ? '24px' : 0,
              padding: '0.1rem 1.5rem', 
              paddingBottom: anchor === 'bottom' ? 'max(0.75rem, env(safe-area-inset-bottom))' : '0.1rem',
              paddingTop: anchor === 'top' ? '0.1rem' : '0.1rem',
              zIndex: 50, 
              boxShadow: anchor === 'bottom' ? '0 -10px 40px rgba(0,0,0,0.12)' : '0 10px 40px rgba(0,0,0,0.12)',
              height: 'auto',
              maxHeight: dynamicMaxHeight, 
              overflowY: 'hidden', 
              touchAction: 'none',
              display: 'flex',
              flexDirection: 'column'
            }}
          >
            {anchor === 'bottom' && (
               <div style={{ display: 'flex', justifyContent: 'center', padding: '0.25rem 0 0.5rem 0', cursor: 'grab', flexShrink: 0 }}>
                 <div style={{ width: '32px', height: '4px', backgroundColor: 'var(--border-light)', borderRadius: '2px' }} />
               </div>
            )}

            <div 
              ref={scrollRef}
              className="modal-content-scroller"
              style={{ 
                flex: 1, 
                overflowY: 'auto', 
                touchAction: 'pan-y',
                WebkitOverflowScrolling: 'touch',
                padding: '0 4px'
              }}
              onPointerDown={(e) => {
                 const isAtStart = scrollRef.current?.scrollTop === 0;
                 const isAtEnd = Math.abs((scrollRef.current?.scrollHeight || 0) - (scrollRef.current?.scrollTop || 0) - (scrollRef.current?.clientHeight || 0)) < 1;
                 if (anchor === 'bottom' && isAtStart) return;
                 if (anchor === 'top' && isAtEnd) return;
                 e.stopPropagation();
              }}
            >
              {renderContent()}
            </div>

            {anchor === 'top' && (
               <div style={{ display: 'flex', justifyContent: 'center', padding: '0.5rem 0 0.25rem 0', cursor: 'grab', flexShrink: 0 }}>
                 <div style={{ width: '32px', height: '4px', backgroundColor: 'var(--border-light)', borderRadius: '2px' }} />
               </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
