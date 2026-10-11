// Display data for the song styles. Mirrors the ids and labels in
// supabase/functions/_shared/songPrompt.ts (which holds the full style seeds
// sent to the songwriter) — keep the two in sync when adding a style there.
export interface SongStyleInfo {
  id: string;
  label: string;
  /** One line for Settings. */
  blurb: string;
}

export const SONG_STYLES: SongStyleInfo[] = [
  { id: 'anime', label: 'アニメ主題歌', blurb: 'Fast, soaring pop-rock: piano intro, galloping drums, strings at the chorus.' },
  { id: 'citypop', label: 'シティポップ', blurb: '1980s city pop: slap bass, electric piano, a warm relaxed voice, night drives.' },
  { id: 'ballad', label: 'バラード', blurb: 'Slow piano ballad that opens into strings; a tender, close vocal.' },
  { id: 'acoustic', label: 'アコースティック', blurb: 'Warm acoustic folk-pop, handclaps, a gentle friendly voice.' },
  { id: 'rock', label: 'ロック', blurb: 'Driving guitar rock with a big shout-along chorus.' },
  { id: 'lofi', label: 'ローファイ', blurb: 'Chill lo-fi: dusty drums, mellow keys, a soft breathy voice.' },
  { id: 'electro', label: 'エレクトロ', blurb: 'Bright electro-pop, sparkling synths, four-on-the-floor.' },
  { id: 'kids', label: '童謡', blurb: "Simple, cheerful children's song; slow and easy to sing along to." },
];

export const styleLabel = (id: string) => SONG_STYLES.find((s) => s.id === id)?.label ?? 'オリジナル';
