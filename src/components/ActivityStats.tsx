import { useEffect, useMemo, useState } from 'react';
import { SliderToggle } from './SliderToggle';
import { supabase } from '../services/supabase';
import { localDay } from '../services/activity';

// 進捗's activity block (docs/mockups/progress-stats.html, B without the
// sentence): minutes per day (week), per week (month) or per month (all time),
// split into reading, listening, reviews and ハルカ, with time in Yugen above and
// a grid of counts below. Data: progress_activity() (database/37).

type Period = 'week' | 'month' | 'all';
interface Day {
  day: string; app: number; read: number; listen: number; review: number; chat: number; turns: number;
  podcasts: number; songs: number; cards: number; kanji: number; lookups: number; opened: number; finished: number;
}
interface Stats { today: string; days: Day[]; streak: number }

const PERIODS = [
  { value: 'week', label: '週' },
  { value: 'month', label: '月' },
  { value: 'all', label: '全部' },
] as const;
// Colours already in the app: the progress blue, the olive and the two mastery tones.
const KINDS = [
  { key: 'read', label: 'Reading', color: 'var(--accent-progress)' },
  { key: 'listen', label: 'Listening', color: '#4a5d23' },
  { key: 'review', label: 'Reviews', color: '#c79a3f' },
  { key: 'chat', label: 'ハルカ', color: '#5b8c5a' },
] as const;
type Kind = typeof KINDS[number]['key'];
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true';

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parse = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const mins = (secs: number) => Math.round(secs / 60);
const hm = (secs: number) => { const m = mins(secs); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };
const md = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;

// The rough y-axis (docs/mockups/activity-axis.html, C): two or three round
// marks, so a bar reads as "about an hour". The step is the smallest round one
// that fits the tallest bar in three; the plot's top is the last mark.
const STEPS = [5, 10, 15, 30, 60, 120, 180, 300, 600, 1200, 1800, 3000, 6000]; // minutes
function axis(maxSecs: number) {
  const max = Math.max(1, maxSecs / 60);
  const step = STEPS.find((st) => Math.ceil(max / st) <= 3) ?? STEPS[STEPS.length - 1];
  const n = Math.max(1, Math.ceil(max / step));
  return { top: step * n * 60, ticks: Array.from({ length: n }, (_, i) => step * (i + 1)) };
}
const tickLabel = (m: number) => (m < 60 ? `${m}m` : `${+(m / 60).toFixed(1)}h`);

/** The period's span, the same span one period back (for the change), and how to bucket it. */
function spans(period: Period, today: Date) {
  if (period === 'week') {
    const start = addDays(today, -((today.getDay() + 6) % 7));                // Monday
    return { start, end: addDays(start, 6), prevStart: addDays(start, -7), prevEnd: addDays(today, -7) };
  }
  if (period === 'month') {
    const start = new Date(today.getFullYear(), today.getMonth(), 1);
    const end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    const prevStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const prevEnd = new Date(today.getFullYear(), today.getMonth() - 1, Math.min(today.getDate(), new Date(today.getFullYear(), today.getMonth(), 0).getDate()));
    return { start, end, prevStart, prevEnd };
  }
  return { start: new Date(2020, 0, 1), end: today, prevStart: null, prevEnd: null };
}

/** The counts grid for some days (the period, or a tapped bar). */
function counts(rows: Day[], streak: number): { n: number | string; l: string }[] {
  const sum = (k: keyof Day) => rows.reduce((a, d) => a + (d[k] as number), 0);
  return [
    { n: sum('opened'), l: 'articles opened' },
    { n: sum('podcasts'), l: 'podcasts' },
    { n: sum('songs'), l: 'songs' },
    { n: sum('cards'), l: 'cards reviewed' },
    { n: sum('kanji'), l: 'kanji reviewed' },
    { n: sum('lookups'), l: 'lookups' },
    { n: sum('turns'), l: 'ハルカ turns' },
    { n: rows.filter((d) => d.app >= 60 || d.cards + d.kanji + d.lookups + d.opened > 0).length, l: 'days active' },
    { n: `${streak}日`, l: 'streak' },
  ];
}

export function ActivityStats() {
  const [period, setPeriod] = useState<Period>('week');
  const [stats, setStats] = useState<Record<Period, Stats | null>>({ week: null, month: null, all: null });

  useEffect(() => {
    if (stats[period]) return;
    const today = parse(localDay());
    const s = spans(period, today);
    const from = iso(s.prevStart ?? s.start);
    let live = true;
    const load: Promise<Stats | null> = DEV_MODE
      ? Promise.resolve(devStats(from, today))
      : Promise.resolve(supabase.rpc('progress_activity', { p_from: from, p_tz: Intl.DateTimeFormat().resolvedOptions().timeZone }))
        .then(({ data, error }) => { if (error) throw error; return data as Stats | null; });
    load
      .then((data) => { if (live && data) setStats((prev) => ({ ...prev, [period]: data })); })
      .catch((e: Error) => console.warn('[progress] activity failed:', e.message));
    return () => { live = false; };
  }, [period, stats]);

  const view = useMemo(() => {
    const data = stats[period];
    if (!data) return null;
    const today = parse(data.today);
    const s = spans(period, today);
    const inRange = (d: Day, a: Date, b: Date) => d.day >= iso(a) && d.day <= iso(b);
    const cur = data.days.filter((d) => inRange(d, s.start, s.end));
    const prev = s.prevStart && s.prevEnd ? data.days.filter((d) => inRange(d, s.prevStart!, s.prevEnd!)) : [];
    const sum = (rows: Day[], k: keyof Day) => rows.reduce((a, d) => a + (d[k] as number), 0);

    // Buckets: days of the week, weeks of the month (1–7, 8–14…), or months tracked.
    // `detail` names the bar when it's tapped.
    let buckets: { label: string; detail: string; rows: Day[]; current: boolean }[];
    if (period === 'week') {
      buckets = Array.from({ length: 7 }, (_, i) => {
        const day = addDays(s.start, i);
        return { label: WEEKDAYS[day.getDay()], detail: `${WEEKDAYS[day.getDay()]} ${md(day)}`, rows: cur.filter((d) => d.day === iso(day)), current: iso(day) === data.today };
      });
    } else if (period === 'month') {
      const weeks = Math.ceil(s.end.getDate() / 7);
      buckets = Array.from({ length: weeks }, (_, w) => ({
        label: `${w + 1}週`,
        detail: `${md(new Date(s.start.getFullYear(), s.start.getMonth(), w * 7 + 1))}–${md(new Date(s.start.getFullYear(), s.start.getMonth(), Math.min(w * 7 + 7, s.end.getDate())))}`,
        rows: cur.filter((d) => Math.floor((parse(d.day).getDate() - 1) / 7) === w),
        current: Math.floor((today.getDate() - 1) / 7) === w,
      }));
    } else {
      const tracked = cur.filter((d) => d.app + d.read + d.listen + d.review + d.chat > 0);
      const first = tracked.length ? parse(tracked[0].day) : today;
      const months: { label: string; detail: string; rows: Day[]; current: boolean }[] = [];
      for (let m = new Date(first.getFullYear(), first.getMonth(), 1); m <= today; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
        const key = iso(m).slice(0, 7);
        months.push({ label: `${m.getMonth() + 1}月`, detail: m.toLocaleDateString('en', { month: 'long', year: 'numeric' }), rows: cur.filter((d) => d.day.startsWith(key)), current: key === data.today.slice(0, 7) });
      }
      buckets = months.slice(-8);
    }

    const firstTracked = data.days.find((d) => d.app > 0)?.day;
    const app = sum(cur, 'app');
    const delta = period === 'all' ? 0 : app - sum(prev, 'app');
    return {
      buckets, app, delta, firstTracked,
      kinds: KINDS.map((k) => ({ ...k, secs: sum(cur, k.key) })),
      counts: counts(cur, data.streak),
    };
  }, [stats, period]);

  // A tapped bar: the header and legend show its own numbers until it's tapped again.
  const [sel, setSel] = useState<number | null>(null);
  useEffect(() => setSel(null), [period]);
  const scale = axis(view ? Math.max(0, ...view.buckets.map((b) => b.rows.reduce((a, d) => a + d.read + d.listen + d.review + d.chat, 0))) : 0);
  const picked = view && sel !== null ? view.buckets[sel] : null;
  const pickedSum = (k: keyof Day) => (picked ? picked.rows.reduce((a, d) => a + (d[k] as number), 0) : 0);
  const prevLabel = period === 'week' ? 'last week' : 'last month';

  return (
    <div className="act">
      <SliderToggle options={PERIODS} value={period} onChange={setPeriod} ariaLabel="Period" style={{ marginBottom: '1.1rem' }} />

      <div className="act-card">
        <div className="act-head">
          <span className="act-kick">{period === 'week' ? 'MINUTES PER DAY' : period === 'month' ? 'MINUTES PER WEEK' : 'MINUTES PER MONTH'}</span>
          {picked ? (
            <span className="act-app">{picked.detail} · <b>{hm(pickedSum('app'))}</b> in Yugen</span>
          ) : view && (
            <span className="act-app">
              <b>{hm(view.app)}</b> in Yugen
              {period !== 'all' && view.delta !== 0 && <span className={view.delta > 0 ? 'up' : ''}> · {view.delta > 0 ? '+' : '−'}{hm(Math.abs(view.delta))} vs {prevLabel}</span>}
            </span>
          )}
        </div>
        <div className="act-plot">
          <div className="act-axis" aria-hidden="true">
            {view && scale.ticks.map((t) => (
              <div key={t} className="act-tick" style={{ bottom: `${(t * 60 / scale.top * 100).toFixed(2)}%` }}><em>{tickLabel(t)}</em></div>
            ))}
          </div>
          <div className={`act-bars${picked ? ' picking' : ''}`}>
            {(view?.buckets ?? Array.from({ length: 7 }, () => ({ label: '', detail: '', rows: [], current: false }))).map((b, i) => {
              const parts = KINDS.map((k) => b.rows.reduce((a, d) => a + d[k.key as Kind], 0));
              const total = parts.reduce((a, p) => a + p, 0);
              return (
                <button
                  key={i} type="button" disabled={!view}
                  className={`act-bar${b.current ? ' now' : ''}${sel === i ? ' sel' : ''}`}
                  aria-pressed={sel === i} aria-label={b.detail ? `${b.detail}: ${hm(total)}` : undefined}
                  onClick={() => setSel((cur) => (cur === i ? null : i))}
                >
                  <div className="act-stack" style={{ height: `calc((100% - 1.1rem) * ${(total / scale.top).toFixed(3)})` }}>
                    {parts.map((p, k) => p > 0 && <i key={k} style={{ flexGrow: p, background: KINDS[k].color }} />)}
                  </div>
                  <span>{b.label}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="act-legend">
          {(picked ? KINDS.map((k) => ({ ...k, secs: pickedSum(k.key) })) : view?.kinds ?? KINDS.map((k) => ({ ...k, secs: 0 }))).map((k) => (
            <span key={k.key}><i style={{ background: k.color }} />{k.label} <b>{hm(k.secs)}</b></span>
          ))}
        </div>
        {period === 'all' && view?.firstTracked && (
          <div className="act-since">Minutes tracked since {parse(view.firstTracked).toLocaleDateString('en', { day: 'numeric', month: 'short' })}.</div>
        )}
      </div>

      <div className="act-card act-counts">
        {(picked ? counts(picked.rows, stats[period]?.streak ?? 0) : view?.counts ?? []).map((c) => (
          <div key={c.l}><div className="n">{typeof c.n === 'number' ? c.n.toLocaleString() : c.n}</div><div className="l">{c.l}</div></div>
        ))}
      </div>
    </div>
  );
}

/** Dev mode has no session: a plausible few weeks so the block can be laid out. */
function devStats(from: string, today: Date): Stats {
  const days: Day[] = [];
  for (let d = parse(from) < addDays(today, -60) ? addDays(today, -60) : parse(from); d <= today; d = addDays(d, 1)) {
    const r = (n: number) => Math.round(((d.getDate() * 37 + n * 11) % 17) / 17 * n);
    const read = r(1500), listen = r(900), review = r(700), chat = r(500);
    days.push({ day: iso(d), app: read + listen + review + chat + r(400), read, listen, review, chat, turns: r(12),
      podcasts: r(2), songs: r(4), cards: r(60), kanji: r(15), lookups: r(30), opened: r(4), finished: r(3) });
  }
  return { today: iso(today), days, streak: 12 };
}
