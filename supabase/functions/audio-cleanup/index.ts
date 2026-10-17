// audio-cleanup (docs/audio-cache-retention.md): generated audio is kept until
// the user deletes it, so this only clears junk. Run daily by pg_cron
// (database/30_audio_cleanup.sql):
//   • failed episodes (no audio to keep) older than 7 days are deleted;
//   • objects in the bucket with no episode row are removed (orphans), through
//     the Storage API, since deleting from storage.objects in SQL is refused.
// Body: { dryRun?: true } reports what it would delete without deleting.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveCaller } from '../_shared/auth.ts';

const FAILED_AFTER_DAYS = 7;
const BATCH = 100;
const SWEEPS = [
  { bucket: 'podcasts', table: 'podcast_episodes' },
  { bucket: 'music', table: 'songs' },
];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey);
  // It deletes rows and files across all users: the cron or the service role
  // only. The gateway's JWT check alone let the public anon key through.
  const caller = await resolveCaller(req, supabase, serviceKey);
  if (!caller || caller.kind === 'user') return json(401, { error: 'unauthorized' });

  const body = await req.json().catch(() => ({}));
  const dryRun = body?.dryRun === true;
  const report: Record<string, unknown> = { dryRun };

  try {
    for (const { bucket, table } of SWEEPS) {
      const cutoff = new Date(Date.now() - FAILED_AFTER_DAYS * 86_400_000).toISOString();
      const failed = supabase.from(table).select('id').eq('status', 'failed').lt('updated_at', cutoff);
      const { data: failedRows, error: fErr } = await failed;
      if (fErr) throw fErr;
      const failedIds = (failedRows ?? []).map((r) => r.id as string);
      if (!dryRun && failedIds.length) {
        const { error } = await supabase.from(table).delete().in('id', failedIds);
        if (error) throw error;
      }

      // After the failed rows are gone, so any file they left behind is swept too.
      const { data: orphans, error: oErr } = await supabase.rpc('audio_orphans', { p_bucket: bucket, p_table: table });
      if (oErr) throw oErr;
      const names = (orphans ?? []) as string[];
      let removed = 0;
      if (!dryRun) {
        for (let i = 0; i < names.length; i += BATCH) {
          const { data, error } = await supabase.storage.from(bucket).remove(names.slice(i, i + BATCH));
          if (error) throw error;
          removed += data?.length ?? 0;
        }
      }
      report[bucket] = { failedEpisodes: failedIds.length, orphans: names, removed };
    }
    console.log('[audio-cleanup]', JSON.stringify(report));
    return json(200, report);
  } catch (e) {
    console.error('[audio-cleanup] failed:', e);
    return json(500, { error: e instanceof Error ? e.message : String(e), report });
  }
});
