import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { actingUserId, resolveCaller } from '../_shared/auth.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Server-side JIT buffer orchestrator (issue #31) ──────────────────────────
// Invariant: every active user always has N unread processed articles in
// processed_news. This is the ONE entrypoint that enforces it, idempotently,
// from any trigger (overnight cron, read/dismiss, app-open). The atomic, cost-
// critical accounting (advisory lock → reclaim → count → bounded deficit →
// claim `pending`) lives in the ensure_buffer_claim() RPC; this function fetches
// candidates, calls the RPC once, then does the slow Gemini work (process-
// article) for ONLY the claimed slots — outside the lock.
//
// Guardrails (see issue #31): #1 in-flight counts toward buffer, #2 bounded
// deficit/no internal loop, #3 hard daily cap, #4 failures→failed (no loop) +
// stale-pending reclaim, #5 no source ⇒ stop, #6 only processed reads/dismisses
// move the buffer (enforced by callers), #7 kill switch + one log line/run.

const N = Number(Deno.env.get('JIT_BUFFER_N') ?? 2);        // target buffer depth
const M = Number(Deno.env.get('JIT_DAILY_CAP') ?? 15);      // hard daily cap/user/24h
const RECLAIM_MIN = Number(Deno.env.get('JIT_RECLAIM_MIN') ?? 5); // stale-pending window
// Full text only: process-article refuses a story whose article body couldn't
// be fetched (422 thin_source) — those came out as three sentences off a
// headline. Each refusal frees its slot, and the buffer claims again with the
// remaining stories from that topic first, so the topic mix holds. Bounded:
// at most this many replacement rounds per run (each refused row is marked
// failed, so it's never retried and still counts toward the daily cap), and
// none started once the run is past REPLACEMENT_BUDGET_MS (a slow extraction
// can take ~30s, and the function has a wall-clock limit).
const MAX_REPLACEMENT_ROUNDS = 2;
const REPLACEMENT_BUDGET_MS = 60_000;

interface RawCard {
  id: string;
  title: string;
  category?: string;
  topic?: string;      // editor mode: catalog topic id, one-line summary, why it was picked
  summary?: string;
  reason?: string;
  sources?: { title?: string; url?: string; teaser?: string }[];
  blocks?: { content?: { text?: string }[] }[];
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(supabaseUrl, serviceKey);

    // ── Guardrail #7: kill switch (off by default) ───────────────────────────
    if (Deno.env.get('JIT_ENABLED') !== 'true') {
      console.log(JSON.stringify({ fn: 'ensure-buffer', reason: 'disabled' }));
      return json({ ok: true, reason: 'disabled' });
    }

    const body = await req.json().catch(() => ({}));

    // ── Resolve userId (_shared/auth.ts). A signed-in user acts only for
    // themselves; body.userId counts only from the cron (x-cron-secret) or the
    // service role. The anon key alone used to fall through to body.userId,
    // letting anyone trigger production for any user. ─────────────────────────
    const caller = await resolveCaller(req, admin, serviceKey);
    if (!caller) return json({ error: 'unauthorized', errorKind: 'unauthorized' }, 401);
    const userId = actingUserId(caller, body.userId);
    if (!userId) return json({ error: 'userId required' }, 400);

    // ── Cheap pre-check: avoid hitting RSS/NewsAPI when the buffer is already
    // full. Counts ready + FRESH pending only (stale pending excluded so an
    // orphan can't mask a real deficit — the RPC reclaims them under the lock).
    const freshCutoff = new Date(Date.now() - RECLAIM_MIN * 60_000).toISOString();
    const dayCutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
    // News rows only: long-form work parts (source_type import/magazine) never
    // occupy a buffer slot or eat the news daily cap (design §1; database/26).
    const [readyRes, pendRes, prodRes] = await Promise.all([
      admin.from('processed_news').select('*', { count: 'exact', head: true })
        .eq('user_id', userId).eq('source_type', 'news').eq('status', 'ready'),
      admin.from('processed_news').select('*', { count: 'exact', head: true })
        .eq('user_id', userId).eq('source_type', 'news').eq('status', 'pending').gt('created_at', freshCutoff),
      admin.from('processed_news').select('*', { count: 'exact', head: true })
        .eq('user_id', userId).eq('source_type', 'news').gt('created_at', dayCutoff),
    ]);
    const buffer = (readyRes.count ?? 0) + (pendRes.count ?? 0);
    const produced24h = prodRes.count ?? 0;
    const preDeficit = Math.min(N - buffer, M - produced24h);

    if (preDeficit <= 0) {
      const reason = (M - produced24h) <= 0 ? 'daily-cap' : 'full';
      console.log(JSON.stringify({ fn: 'ensure-buffer', userId, buffer, produced24h, deficit: 0, reason }));
      return json({ ok: true, reason, buffer, produced24h, produced: 0 });
    }

    // ── Guardrail #5: fetch fresh candidates. No source ⇒ stop. ───────────────
    // The user's topic selection (#10) rides along so server-produced buffer
    // articles match their interests. NULL/absent → fetch-raw-news defaults.
    // mode 'edit' = the Haiku news editor: it reads this learner's memory and
    // history and returns picks with their full text already fetched.
    const { data: prefs } = await admin.from('user_preferences')
      .select('feed_topics').eq('user_id', userId).maybeSingle();
    let candidates: RawCard[] = [];
    try {
      const resp = await fetch(`${supabaseUrl}/functions/v1/fetch-raw-news`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${serviceKey}` },
        body: JSON.stringify({ page: 1, topics: prefs?.feed_topics ?? null, userId, mode: 'edit' }),
      });
      if (resp.ok) {
        const data = await resp.json();
        candidates = Array.isArray(data.articles) ? data.articles : [];
      } else {
        console.warn(`[ensure-buffer] fetch-raw-news ${resp.status}`);
      }
    } catch (e) {
      console.warn('[ensure-buffer] fetch-raw-news failed:', e instanceof Error ? e.message : e);
    }

    if (candidates.length === 0) {
      console.log(JSON.stringify({ fn: 'ensure-buffer', userId, buffer, produced24h, deficit: preDeficit, reason: 'no-source' }));
      return json({ ok: true, reason: 'no-source', buffer, produced24h, produced: 0 });
    }

    // ── Atomic claim under the per-user advisory lock (the authoritative truth;
    // the pre-check above is only an optimization). ───────────────────────────
    const byId = new Map(candidates.map((c) => [c.id, c]));
    const claimSlots = async (ordered: RawCard[]) => {
      const { data, error } = await admin.rpc('ensure_buffer_claim', {
        p_user_id: userId,
        p_candidates: ordered.map((c) => ({ id: c.id, title: c.title })),
        p_n: N,
        p_m: M,
        p_reclaim_minutes: RECLAIM_MIN,
      });
      if (error) throw error;
      return data as { buffer?: number; produced24h?: number; deficit?: number; reclaimed?: number; claimed?: { id: string; title: string }[] } | null;
    };

    const startedAt = Date.now();
    let claim: Awaited<ReturnType<typeof claimSlots>>;
    try {
      claim = await claimSlots(candidates);
    } catch (rpcErr) {
      console.error('[ensure-buffer] ensure_buffer_claim error:', rpcErr);
      return json({ error: (rpcErr as { message?: string })?.message ?? String(rpcErr) }, 500);
    }

    // ── Produce each claimed slot (slow Gemini work, OUTSIDE the lock). ───────
    let produced = 0, failed = 0, thin = 0, claimedTotal = 0;
    const markFailed = (id: string) => admin.from('processed_news')
      .update({ status: 'failed', retry_count: 1 })
      .eq('user_id', userId).eq('id', id).eq('status', 'pending');

    // Returns the topics whose story was refused as too thin.
    const produceSlots = async (slots: { id: string; title: string }[]) => {
      const thinTopics: string[] = [];
      for (const slot of slots) {
        const card = byId.get(slot.id);
        const snippet = card?.blocks?.[0]?.content?.[0]?.text || slot.title;
        let ok = false;
        try {
          const resp = await fetch(`${supabaseUrl}/functions/v1/process-article`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${serviceKey}` },
            body: JSON.stringify({
              userId,
              articleId: slot.id,
              title: slot.title,
              snippet,
              sources: card?.sources ?? [],
              requireFull: true,
              topic: card?.topic,
              category: card?.category,
              summary: card?.summary,
              reason: card?.reason,
            }),
          });
          ok = resp.ok; // process-article upserts the pending row → status='ready'
          if (!ok) {
            const text = await resp.text();
            if (resp.status === 422 && text.includes('thin_source')) {
              thin++;
              thinTopics.push(card?.category ?? '');
            } else {
              console.error(`[ensure-buffer] process-article ${resp.status} for ${slot.id}:`, text);
            }
          }
        } catch (e) {
          console.error(`[ensure-buffer] process-article threw for ${slot.id}:`, e instanceof Error ? e.message : e);
        }

        if (ok) {
          produced++;
        } else {
          failed++;
          // Guardrail #4: failures don't revert into a deficit and don't loop — mark
          // the claimed-but-unproduced row failed (still counts toward the daily cap)
          // so the slot frees and the headline isn't retried indefinitely.
          await markFailed(slot.id);
        }
      }
      return thinTopics;
    };

    let slots = claim?.claimed ?? [];
    for (let round = 0; slots.length > 0; round++) {
      claimedTotal += slots.length;
      const thinTopics = await produceSlots(slots);
      if (thinTopics.length === 0 || round >= MAX_REPLACEMENT_ROUNDS || Date.now() - startedAt > REPLACEMENT_BUDGET_MS) break;
      // Replace thin stories: the same topics' remaining candidates first (in
      // their existing order), then everything else. The RPC skips any story
      // this user already has a row for, including the ones just refused.
      const want = new Set(thinTopics);
      const reordered = [
        ...candidates.filter((c) => want.has(c.category ?? '')),
        ...candidates.filter((c) => !want.has(c.category ?? '')),
      ];
      try {
        slots = (await claimSlots(reordered))?.claimed ?? [];
      } catch (rpcErr) {
        console.error('[ensure-buffer] replacement claim error:', rpcErr);
        break;
      }
    }

    const reason = produced > 0 ? 'produced'
      : claimedTotal === 0 ? 'no-deficit-or-source'
      : 'all-failed';
    console.log(JSON.stringify({
      fn: 'ensure-buffer', userId,
      buffer: claim?.buffer, produced24h: claim?.produced24h,
      deficit: claim?.deficit, reclaimed: claim?.reclaimed,
      claimed: claimedTotal, produced, failed, thin, reason,
    }));

    return json({ ok: true, reason, claimed: claimedTotal, produced, failed, thin });

  } catch (err) {
    console.error('[ensure-buffer] Error:', err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
