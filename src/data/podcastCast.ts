// Display data for the podcast cast. Mirrors the persona ids, names, dialects and
// personality lines in supabase/functions/_shared/podcastCast.ts (which also holds
// the voice ids and the rotation rule) — keep the two in sync when adding a persona there.
export interface CastMember {
  name: string;
  /** Short dialect tag for cards; null for 標準語. */
  dialect: string | null;
  /** The original personality line (Settings › 聞く shows it and lets the reader rewrite it). */
  persona: string;
}

export const PODCAST_CAST: Record<string, CastMember> = {
  haruka: { name: 'ハルカ', dialect: null, persona: '30代。明るく好奇心旺盛で、リスナーと同じ目線で素朴な質問をする。' },
  yoko: { name: 'ヨウコ', dialect: null, persona: '50代。落ち着いたベテランの語り手。やさしく、具体例を使って説明する。' },
  sota: { name: 'ソウタ', dialect: null, persona: '40代。物知りで穏やかな解説役。難しいことを短い文でやさしく説明する。' },
  yuki: { name: 'ユウキ', dialect: null, persona: '20代。元気で好奇心が強い。カジュアルだが聞き取りやすく話す。' },
  kenji: { name: 'ケンジ', dialect: '関西弁', persona: '30代。気さくでノリがいい。ツッコミ役で、リスナーの気持ちを代弁する。' },
  aya: { name: 'アヤ', dialect: '関西弁', persona: '20代後半。明るくて機転がきく。身近な例えで話を面白くする。' },
  takumi: { name: 'タクミ', dialect: '博多弁', persona: '30代。おおらかでユーモアがある。のんびりした口調で場を和ませる。' },
};

export const castMember = (id: string | undefined): CastMember =>
  (id && PODCAST_CAST[id]) || { name: '—', dialect: null, persona: '' };
