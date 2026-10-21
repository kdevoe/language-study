import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import { fetchRecap, type RecapRef, type WeeklyRecap } from '../../services/tutor';

// ハルカ's weekly recap (docs/mockups/weekly-recap.html, A; design-system §6.17).
// In the thread it's one block under her Sunday opener; a tap opens the report
// in a sheet over everything, nearly full height. Swipe it down (or tap the dim)
// and you're back in her chat, where she has the recap in her memory.

/** The block in the thread: white like your bubbles, the kicker, the title and the patterns. */
export function RecapBlock({ recap, onOpen }: { recap: RecapRef; onOpen: () => void }) {
  return (
    <button className="tutor-recap" onClick={onOpen}>
      <span className="tutor-recap-k">WEEKLY RECAP</span>
      <span className="tutor-recap-h"><span>今週のまとめ</span><ChevronRight size={18} strokeWidth={1.6} /></span>
      <span className="tutor-recap-s">{recap.title}</span>
    </button>
  );
}

const JP_RUN = /([぀-ヿ㐀-鿿ｦ-ﾟ々〆ー・〜]+)/;

/** English with Japanese inline: the Japanese runs go in the chat serif. */
function Mixed({ text }: { text: string }) {
  return <>{text.split(JP_RUN).map((part, i) => (i % 2 ? <span key={i} className="recap-jp">{part}</span> : part))}</>;
}

/** The corrected line with the changed part marked. */
function Fixed({ now, fix }: { now: string; fix?: string }) {
  const at = fix ? now.indexOf(fix) : -1;
  if (!fix || at < 0) return <>{now}</>;
  return <>{now.slice(0, at)}<span className="recap-fix">{fix}</span>{now.slice(at + fix.length)}</>;
}

const range = (r: WeeklyRecap) => {
  const fmt = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
  return `${fmt(r.week_start)} – ${fmt(r.week_end)}`;
};

export function RecapSheet({ id, onClose, onPractice }: {
  id: string | null;
  onClose: () => void;
  onPractice: (pattern: string) => void;
}) {
  const [recap, setRecap] = useState<WeeklyRecap | null>(null);
  const [failed, setFailed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!id) return;
    setFailed(false);
    if (recap?.id === id) return;
    setRecap(null);
    fetchRecap(id).then((r) => (r ? setRecap(r) : setFailed(true))).catch(() => setFailed(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const r = recap?.report;
  return (
    <AnimatePresence>
      {id && (
        <>
          <motion.div className="recap-dim" onClick={onClose}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }} />
          <motion.div
            className="recap-sheet"
            role="dialog"
            aria-label="今週のまとめ"
            drag="y"
            dragDirectionLock
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={(_, info) => { if (info.velocity.y > 250 || info.offset.y > 80) onClose(); }}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '105%' }}
            transition={{ type: 'spring', stiffness: 400, damping: 40 }}
          >
            <div className="recap-bar"><i /></div>
            <div
              className="recap-scroll"
              ref={scrollRef}
              // The sheet drags down only from the top of the report; further in, a swipe scrolls.
              onPointerDown={(e) => { if ((scrollRef.current?.scrollTop ?? 0) > 0) e.stopPropagation(); }}
            >
              {!r && !failed && <div className="tutor-typing" role="status" aria-label="読み込み中"><span /><span /><span /></div>}
              {failed && <p className="recap-p recap-muted">まとめを開けませんでした。</p>}
              {r && recap && (
                <div className="recap">
                  <div className="recap-k">{range(recap)}</div>
                  <h1 className="recap-title">今週のまとめ</h1>
                  <div className="recap-her">{r.intro}</div>
                  <p className="recap-p recap-lede"><Mixed text={r.lede} /></p>

                  {r.patterns.map((p, i) => (
                    <section className="recap-pat" key={i}>
                      <div className="recap-k">{i + 1} · {p.count} TIMES</div>
                      <h2 className="recap-h"><Mixed text={p.title} /></h2>
                      <div className="recap-ex">
                        {p.examples.map((e, j) => (
                          <div className="recap-ex-row" key={j}>
                            <span className="recap-was">{e.was}</span>
                            <span className="recap-now"><Fixed now={e.now} fix={e.fix} /></span>
                          </div>
                        ))}
                      </div>
                      {p.explain.map((t, j) => <p className="recap-p" key={j}><Mixed text={t} /></p>)}
                      <div className="recap-try"><b>This week:</b> <Mixed text={p.tip} /></div>
                      <button className="recap-prac" onClick={() => onPractice(p.short)}>ハルカと練習する →</button>
                    </section>
                  ))}

                  {r.words.length > 0 && (
                    <section className="recap-pat">
                      <div className="recap-k">WORDS THAT KEPT SLIPPING</div>
                      <div className="recap-words">
                        {r.words.map((w) => <div key={w.word}>{w.word}<small>{w.meaning}</small></div>)}
                      </div>
                    </section>
                  )}

                  {r.solid && (
                    <section className="recap-pat">
                      <div className="recap-k">WHAT GOT SOLID</div>
                      <p className="recap-p"><Mixed text={r.solid} /></p>
                    </section>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
