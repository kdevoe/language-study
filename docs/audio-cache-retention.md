# Audio caching and retention (proposal)
Status: built for podcasts, 2026-10-11 (`src/services/audioCache.ts`, `supabase/functions/audio-cleanup`, `database/30_audio_cleanup.sql`). Music plugs into the same pieces.
## Where things stand
- MP3s live in the private `podcasts` bucket at `<user_id>/<episode_id>.mp3`. There are 7 objects, 35 MB in total, about 5 MB each.
  
- The player streams through a **signed URL valid for 6 hours** (`episodeAudioUrl`). Every open creates a new URL with a new token, so the browser's HTTP cache never matches it. Each new session downloads the audio again.
  
- The upload sets no `cacheControl`, so Supabase's default of 1 hour applies.
  
- The service worker caches only the app shell and the kuromoji dictionary. It doesn't cache audio.
  
- Episodes are kept until the user deletes them (`deleteEpisodes` removes the MP3, then the row).
  
- `pg_cron` and `pg_net` are both enabled in the project.
  
## Caching
**Goal:** an episode you've started plays instantly and works offline, and resuming it doesn't download it again.

1. **Keep the audio on the device, keyed by** `audio_path`**, not by the signed URL.**
  

- When the player opens an episode, it first checks the Cache API (`podcast-audio` cache) for `audio_path`.
  
- **Hit:** play from a `blob:` object URL. There's no network request and no signed URL.
  
- **Miss:** start playing from the signed URL right away, as today. In the background, `fetch` the whole file and store it.
  
- The next open, or the next session, is then a hit.
  
- This is in-app code, not a service worker rule. The service worker would have to handle Range requests from the `<audio>` element and strip the signature token from the URL. That's fiddly and has bugs on iOS.
  

2. **Cap on the device:** the 5 most recently opened episodes, at most about 30 MB. Least recently used episodes go first. Deleting an episode also removes its cached copy.
  

- iOS can clear PWA storage on its own, so a miss must always fall back to streaming.
  
- Use `navigator.storage.persist()` where the browser supports it.
  

3. **Upload with** `cacheControl: '31536000'` (one year).
  

- This is safe because the path holds the episode id and the content never changes.
  
- Retry doesn't break this. Only failed episodes are voiced again, and `audio_path` is set only when an episode becomes ready, so nothing has fetched the old file. No versioned path is needed.
  

4. **Later, optionally:** download the new daily digest to the device in the background when 今日 loads on Wi-Fi, so the morning episode is already there. Leave this out of v1.
  

**What it saves:** honestly, not much download traffic today. Most episodes are played once or twice, and streaming downloads only what you hear. The real gains are instant resume, offline listening, and no repeat downloads when you scrub back and forth. Download savings grow if people replay episodes.
## Retention (server)
**Rule: no expiry.** Episodes and their audio are kept until the user deletes them. Storage is the cheap side at this scale. A daily episode is about 1.8 GB per user per year, roughly 4¢ a month beyond the plan's included storage. Re-voicing a deleted episode with ElevenLabs costs more than storing it for years.

Only junk gets cleaned up:

| What | When it goes |
| --- | --- |
| **Failed** episodes (no audio) | Row deleted after 7 days |
| **Orphan** objects (file with no row, older than a day) | Daily sweep |
| Episodes the user deletes | Immediately (as today) |

**How:**

- An edge function, `audio-cleanup`, run daily by `pg_cron` through `pg_net` with the service key.
  
- It deletes failed rows older than 7 days, then asks `audio_orphans()` (a service-role-only SQL function) for objects that no row points at, by `audio_path` or by id. It removes those through the Storage API, because deleting from `storage.objects` in SQL is refused.
  
- `{ "dryRun": true }` reports without deleting. It runs daily at 10:00 UTC (`cron.job` `audio-cleanup`).
  
- It covers both the `podcasts` and `music` buckets.
  
- There's no schema change and no client change.
  

**Revisit if:** storage ever shows up on the bill. The fallback then is a single long window, such as audio removed 1 year after an episode was last opened, with a transcript-only mode for expired episodes. That needs a `last_played_at` column, because `listened_at` is set only when an episode is finished.
## Music (later)
Music is generated with ElevenLabs and we own it, so we store it ourselves. It's a library, not a feed.

- **No time-based expiry.** A song costs as much to make as an episode, and people come back to it. The same rule as podcasts: a track goes only when the user deletes it, and `audio-cleanup` handles failed generations and orphan files.
  
- **A separate** `music` **bucket** (`<user_id>/<track_id>.mp3`), uploaded with the same one-year `cacheControl`.
  
- **The on-device cache matters more here than for podcasts.** Songs get replayed many times, and without the cache every replay is a full download. Give music its own cache, `music-audio`, with a larger cap: about 50 tracks or 150 MB, least recently played first. Saved songs should play offline.
  
- **This is where download traffic would grow,** so it's the case worth watching on the usage dashboard. The on-device cache is the first fix. R2, which charges nothing for downloads, is the fallback if it's still large.
  
- **Later: shared songs.** If a song is ever shared between users (a common song for a JLPT level, for example), store it once under a shared path rather than per user.
  
## Order of work
1. Upload with `cacheControl`, in `generate-podcast`.
  
2. The on-device cache in the player and `deleteEpisodes`. Client only. Build it shared (`audioCache.ts`, one cache per kind) so music reuses it.
  
3. `audio-cleanup` and its cron job. Needs your approval to deploy and schedule.
