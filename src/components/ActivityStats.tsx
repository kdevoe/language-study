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
    let buckets: { label: string; rows: Day[]; current: boolean }[];
    if (period === 'week') {
      buckets = Array.from({ length: 7 }, (_, i) => {
        const day = addDays(s.start, i);
        return { label: WEEKDAYS[day.getDay()], rows: cur.filter((d) => d.day === iso(day)), current: iso(day) === data.today };
      });
    } else if (period === 'month') {
      const weeks = Math.ceil(s.end.getDate() / 7);
      buckets = Array.from({ length: weeks }, (_, w) => ({
        label: `${w + 1}週`,
        rows: cur.filter((d) => Math.floor((parse(d.day).getDate() - 1) / 7) === w),
        current: Math.floor((today.getDate() - 1) / 7) === w,
      }));
    } else {
      const tracked = cur.filter((d) => d.app + d.read + d.listen + d.review + d.chat > 0);
      const first = tracked.length ? parse(tracked[0].day) : today;
      const months: { label: string; rows: Day[]; current: boolean }[] = [];
      for (let m = new Date(first.getFullYear(), first.getMonth(), 1); m <= today; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
        const key = iso(m).slice(0, 7);
        months.push({ label: `${m.getMonth() + 1}月`, rows: cur.filter((d) => d.day.startsWith(key)), current: key === data.today.slice(0, 7) });
      }
      buckets = months.slice(-8);
    }

    const firstTracked = data.days.find((d) => d.app > 0)?.day;
    const app = sum(cur, 'app');
    const delta = period === 'all' ? 0 : app - sum(prev, 'app');
    return {
      buckets, app, delta, firstTracked,
      kinds: KINDS.map((k) => ({ ...k, secs: sum(cur, k.key) })),
      counts: [
        { n: sum(cur, 'opened'), l: 'articles opened' },
        { n: sum(cur, 'podcasts'), l: 'podcasts' },
        { n: sum(cur, 'songs'), l: 'songs' },
        { n: sum(cur, 'cards'), l: 'cards reviewed' },
        { n: sum(cur, 'kanji'), l: 'kanji reviewed' },
        { n: sum(cur, 'lookups'), l: 'lookups' },
        { n: sum(cur, 'turns'), l: 'ハルカ turns' },
        { n: cur.filter((d) => d.app >= 60 || d.cards + d.kanji + d.lookups + d.opened > 0).length, l: 'days active' },
        { n: `${data.streak}日`, l: 'streak' },
      ],
    };
  }, [stats, period]);

  const max = view ? Math.max(1, ...view.buckets.map((b) => b.rows.reduce((a, d) => a + d.read + d.listen + d.review + d.chat, 0))) : 1;
  const prevLabel = period === 'week' ? 'last week' : 'last month';

  return (
    <div className="act">
      <SliderToggle options={PERIODS} value={period} onChange={setPeriod} ariaLabel="Period" style={{ marginBottom: '1.1rem' }} />

      <div className="act-card">
        <div className="act-head">
          <span className="act-kick">{period === 'week' ? 'MINUTES PER DAY' : period === 'month' ? 'MINUTES PER WEEK' : 'MINUTES PER MONTH'}</span>
          {view && (
            <span className="act-app">
              <b>{hm(view.app)}</b> in Yugen
              {period !== 'all' && view.delta !== 0 && <span className={view.delta > 0 ? 'up' : ''}> · {view.delta > 0 ? '+' : '−'}{hm(Math.abs(view.delta))} vs {prevLabel}</span>}
            </span>
          )}
        </div>
        <div className="act-bars">
          {(view?.buckets ?? Array.from({ length: 7 }, () => ({ label: '', rows: [], current: false }))).map((b, i) => {
            const parts = KINDS.map((k) => b.rows.reduce((a, d) => a + d[k.key as Kind], 0));
            const total = parts.reduce((a, p) => a + p, 0);
            return (
              <div key={i} className={`act-bar${b.current ? ' now' : ''}`}>
                <div className="act-stack" style={{ height: `calc((100% - 1.1rem) * ${(total / max).toFixed(3)})` }}>
                  {parts.map((p, k) => p > 0 && <i key={k} style={{ flexGrow: p, background: KINDS[k].color }} />)}
                </div>
                <span>{b.label}</span>
              </div>
            );
          })}
        </div>
        <div className="act-legend">
          {(view?.kinds ?? KINDS.map((k) => ({ ...k, secs: 0 }))).map((k) => (
            <span key={k.key}><i style={{ background: k.color }} />{k.label} <b>{hm(k.secs)}</b></span>
          ))}
        </div>
        {period === 'all' && view?.firstTracked && (
          <div className="act-since">Minutes tracked since {parse(view.firstTracked).toLocaleDateString('en', { day: 'numeric', month: 'short' })}.</div>
        )}
      </div>

      <div className="act-card act-counts">
        {(view?.counts ?? []).map((c) => (
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
