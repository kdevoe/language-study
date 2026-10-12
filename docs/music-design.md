# 音楽: generated songs

Songs written for the reader's vocabulary, sung by ElevenLabs, with lyrics timed to the audio. They're built to sound like real songs first and to teach second.

## Pipeline (`supabase/functions/generate-song`)

1. **create** adds a `songs` row with status `writing`. Limits: 2 songs in flight and 10 a day per user.
2. **writing:** Claude Opus 5.5 (`CLAUDE_OPUS`) writes the song plan through the `submit_song` tool: title, hook, mood, a composition plan (sections with styles and lyrics) and the lyric lines. `normalizePlan` scales section durations to the exact length, keeps each chunk between 3 and 120s, and adds `english vocals` to the negative styles.
3. **composing:** ElevenLabs is sent each section's `sung` lines, not the display `lines`. These are the same lyrics written all in kana, exactly as pronounced (は → わ, 段々 → だんだん), with the same phrase breaks. The music model dropped or misread some kanji: 段々 in 「風の強い夜」 came out silent. The reader still sees the kanji lines. A sung line that has kanji or breaks into different phrases from its display line falls back to the display line. The call is `/v1/music/detailed` (`music_v2_5`, `with_timestamps`). The multipart response is parsed for the audio and the phrase timestamps, and `lineTimings` maps those timestamps to lyric lines, matching against the sung lines. In parallel, Gemini (`GEMINI_IMAGE`) draws a 512px JPEG cover (see Cover art). If the cover fails, the song still ships. The covers come from Gemini because the ElevenLabs key has no image permission.
4. **ready** (or **failed**, with 再試行). A `bad_prompt` error clears the plan, so a retry writes the song again.

Each stage runs as a self-call with the service key. One song takes about 40s: about 25s to write and 15s to compose.

## Cover art

The songwriter writes only the cover's **scene** (`cover_prompt`: subject, setting, composition, mood), never its look. The look comes from the reader's **art direction**: `user_preferences.song_cover_style`, set in Settings › 聞く › Cover art, or `DEFAULT_COVER_STYLE` when it's null. The default is a flat risograph-print illustration in the app's palette (off-white paper, mist blue, olive, charcoal) with lots of empty space. The image prompt is `Scene + Art direction`, plus a fixed tail: an illustration, never a photograph or 3D render, filling the square edge to edge (no frame or paper border), with no text and no real people. Every cover in the grid shares one look, whatever the music style.

The default was chosen against ink-wash (sumi-e) and shin-hanga woodblock candidates, which also work as custom directions. To repaint a cover, upload it under a new name (`<id>-v2.jpg`) and update `cover_path`, so cached copies of the old image can't linger. `audio_orphans` matches files to songs by the uuid prefix (33_song_cover_style.sql).

## Styles and custom requests

`SONG_STYLES` in `_shared/songPrompt.ts` (labels in `src/data/songStyles.ts`) has 8 presets: アニメ主題歌, シティポップ, バラード, アコースティック, ロック, ローファイ, エレクトロ, and 童謡 (N4 and easier only). Each preset is a seed of plain style words and names no artist. With 自分で, the reader describes a song in their own words. The songwriter turns any real artist or track named there into plain style words, then saves the cleaned text as `request_clean` in place of the original. No real names are ever sent to ElevenLabs or stored.

## Vocabulary: the article mechanism (`_shared/readerVocab.ts`)

- **Body = known words.** `buildLexicon` gives the reader's full known list, the same list articles use (confirmed-easy words, then N5/N4 minus anything graded medium or hard). It goes in as an ALLOWED LIST.
- **A few review words slipped in.** `pickReviewWords` picks about 3 struggling or due words in their pre-due window. Using them is a soft ask, never forced: the song comes first.
- Grammar sits one JLPT level easier than the reader's level, because sung lines go by quickly.
- Auto songs draw their theme from what the reader has read recently.

## Variety: history

The prompt carries the past 30 days of the reader's songs: the latest 8 in detail (title, hook, mood, style) and the rest in compact form. The model is asked not to repeat themes, hooks or imagery.

## Automatic songs

The `song-auto` cron runs at 09:30 UTC (`database/32_song_auto.sql`). It calls `generate-song` with `action: 'auto'`, gated by the `x-cron-secret` header (`SONG_CRON_SECRET`, also stored in Vault as `song_cron_secret`). For each user active in the last 2 days, it makes at most one song, and skips the user when any of these holds:

- `song_frequency` is `off`, or the last auto song was too recent: every other day needs a gap of at least 2 calendar days, daily needs 1.
- 2 or more auto songs are still unplayed, so songs don't pile up.
- There were fewer than 20 study events since the last auto song, so there's nothing new to sing about.

The style comes from the reader's chosen `song_styles` (Settings › 聞く; null means all styles). It is never one of the last two styles used, and each style is weighted by (1 + plays) / (1 + uses) over the past 30 days, so styles the reader actually plays come up more often.

## Settings › 聞く

- `user_preferences.song_frequency`: off, every_other_day (the default) or daily.
- `song_styles text[]`: the styles auto songs draw from. At least one stays on.
- `podcast_cast text[]`: the hosts in the podcast rotation. If the list leaves fewer than 2 hosts, or no 標準語 speaker, generate-podcast falls back to the full cast.
- `song_cover_style text`: the art direction for covers (null = the default), at most 400 characters.
- `podcast_personas jsonb`: the reader's rewrite of a host's personality, `{ id: text }`, at most 200 characters. The rewrite replaces the original in the script prompt.

## Storage and caching

Songs go in the private `music` bucket (`database/31_songs.sql`), as `<user>/<id>.mp3` and `.jpg`. The client caches the audio with `audioCache` (kind `music`: 50 songs or 150 MB, LRU). Cover URLs are signed for 7 days and memoised. `audio-cleanup` also sweeps failed songs and orphan files from `music`.

## Lists

`playlists` (id, user_id, name, created_at, touched_at) and `playlist_songs` (playlist_id, song_id, user_id, position, added_at), from `database/34_playlists.sql`. Both have RLS per user and are written by the client directly; deleting a song or a list cascades. `touched_at` moves when a list is made or a song is added to it, and orders the shelf and the リストに追加 sheet (last used first). Before the migration is applied the load fails quietly and the shelf shows only すべての曲, which is built on the client and never stored.

The client keeps one shared store (`services/playlists.ts`, `usePlaylists()`) so the shelf, a list's page and the player's sheet agree. Writes apply locally first and roll back on error. The queue lives in App (`songQueue`): the grid's ready songs, or a list's in order (shuffled for シャッフル). When a song ends, the player hands off to the next one; the handoff and the 次の曲 rows don't play the unlock clip, because the shared element is already playing.
