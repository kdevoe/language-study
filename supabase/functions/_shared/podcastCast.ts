// Podcast cast (docs/podcast-design.md "Cast rotation"): a pool of named
// personas, each backed by an ElevenLabs Voice Design voice. Every episode
// draws a fresh host + guest pairing so the show keeps changing, while each
// persona keeps the same name and personality wherever it appears.
//
// Adding a persona is config-only: design the voice (scripts/spike-podcast.mjs
// `design` → `audition` QC), then add an entry here. Cast admission bar: noise
// floor under -50 dB and a female pitch around 210 Hz or lower (user review,
// 2026-10-09). `gainDb` levels the voice to -20 LUFS (measured, informational —
// the dialogue endpoint renders one mix, so it isn't applied per turn today).

export type Gender = 'female' | 'male';

export interface Persona {
  id: string;
  name: string;
  gender: Gender;
  /** Spoken register written into the script; '標準語' or a regional dialect. */
  dialect: string;
  /** Personality blurb fed to the script prompt (Japanese). */
  persona: string;
  voiceId: string;
  gainDb: number;
}

export const STANDARD = '標準語';

export const CAST: Persona[] = [
  { id: 'haruka', name: 'ハルカ', gender: 'female', dialect: STANDARD, voiceId: 'gMxKcX5u6nQBRESc6mBs', gainDb: -2.1,
    persona: '30代。明るく好奇心旺盛で、リスナーと同じ目線で素朴な質問をする。' },
  { id: 'yoko', name: 'ヨウコ', gender: 'female', dialect: STANDARD, voiceId: '1eoYiY6KtnzgK2sEA4pH', gainDb: -1.1,
    persona: '50代。落ち着いたベテランの語り手。やさしく、具体例を使って説明する。' },
  { id: 'sota', name: 'ソウタ', gender: 'male', dialect: STANDARD, voiceId: 'laAHgJalkDoYSctrKMLw', gainDb: -0.8,
    persona: '40代。物知りで穏やかな解説役。難しいことを短い文でやさしく説明する。' },
  { id: 'yuki', name: 'ユウキ', gender: 'male', dialect: STANDARD, voiceId: 'q1QLKBDpgC1siPehRsAH', gainDb: 0,
    persona: '20代。元気で好奇心が強い。カジュアルだが聞き取りやすく話す。' },
  { id: 'kenji', name: 'ケンジ', gender: 'male', dialect: '関西弁（大阪・やわらかめ）', voiceId: '2E4sAMvL1ysyi98ZdVOZ', gainDb: 0,
    persona: '30代。気さくでノリがいい。ツッコミ役で、リスナーの気持ちを代弁する。' },
  { id: 'aya', name: 'アヤ', gender: 'female', dialect: '関西弁（大阪・やわらかめ）', voiceId: 'KaB6BfFo9uyIdxTvBtCe', gainDb: -0.7,
    persona: '20代後半。明るくて機転がきく。身近な例えで話を面白くする。' },
  { id: 'takumi', name: 'タクミ', gender: 'male', dialect: '博多弁（やわらかめ）', voiceId: '3WsyiW3y0xhuA1gceJLE', gainDb: 0.7,
    persona: '30代。おおらかでユーモアがある。のんびりした口調で場を和ませる。' },
];

export const personaById = (id: string): Persona | undefined => CAST.find((p) => p.id === id);

export interface Pairing {
  host: Persona;
  guest: Persona;
}

/** Past episode pairings, most recent first (persona ids). */
export type PairHistory = { host: string; guest: string }[];

const pairKey = (a: string, b: string) => [a, b].sort().join('+');
const isDialect = (p: Persona) => p.dialect !== STANDARD;

/**
 * Choose the next host + guest:
 *   1. host ≠ guest;
 *   2. at most one dialect speaker (a learner always has a 標準語 anchor);
 *   3. never the previous episode's pair, in either order;
 *   4. prefer the least-recently-heard pairing (never-heard first);
 *   5. prefer mixed gender;
 *   6. ties broken randomly.
 * A dialect speaker always hosts (the personality-forward role); otherwise the
 * host is picked at random so both personas get to lead.
 */
export function pickPairing(history: PairHistory, rand: () => number = Math.random, pool: Persona[] = CAST): Pairing {
  const lastSeen = new Map<string, number>(); // pairKey → episodes ago (0 = last)
  history.forEach((h, i) => {
    const k = pairKey(h.host, h.guest);
    if (!lastSeen.has(k)) lastSeen.set(k, i);
  });
  const prev = history[0] ? pairKey(history[0].host, history[0].guest) : null;

  const candidates: { a: Persona; b: Persona; ago: number; mixed: boolean; tie: number }[] = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i];
      const b = pool[j];
      if (isDialect(a) && isDialect(b)) continue;
      const k = pairKey(a.id, b.id);
      if (k === prev && pool.length > 2) continue;
      candidates.push({ a, b, ago: lastSeen.get(k) ?? Infinity, mixed: a.gender !== b.gender, tie: rand() });
    }
  }
  candidates.sort((x, y) => (y.ago - x.ago) || (Number(y.mixed) - Number(x.mixed)) || (x.tie - y.tie));
  const { a, b } = candidates[0];
  if (isDialect(a)) return { host: a, guest: b };
  if (isDialect(b)) return { host: b, guest: a };
  return rand() < 0.5 ? { host: a, guest: b } : { host: b, guest: a };
}
