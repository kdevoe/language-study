// Display data for the podcast cast. Mirrors the persona ids/names/dialects in
// supabase/functions/_shared/podcastCast.ts (which also holds the voice ids and
// the rotation rule) — keep the two in sync when adding a persona there.
export interface CastMember {
  name: string;
  /** Short dialect tag for cards; null for 標準語. */
  dialect: string | null;
}

export const PODCAST_CAST: Record<string, CastMember> = {
  haruka: { name: 'ハルカ', dialect: null },
  yoko: { name: 'ヨウコ', dialect: null },
  sota: { name: 'ソウタ', dialect: null },
  yuki: { name: 'ユウキ', dialect: null },
  kenji: { name: 'ケンジ', dialect: '関西弁' },
  aya: { name: 'アヤ', dialect: '関西弁' },
  takumi: { name: 'タクミ', dialect: '博多弁' },
};

export const castMember = (id: string | undefined): CastMember =>
  (id && PODCAST_CAST[id]) || { name: '—', dialect: null };
