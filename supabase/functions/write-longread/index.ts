// write-longread: ハルカ's long reads (docs/haruka-longform-plan.md).
//
// Two ways in, one job:
//   scheduled  learner-dream, after the nightly pass, on the learner's local
//              Tuesday and Friday nights (service role)
//   requested  the learner tapped ハルカ's offer in chat (their own JWT); the
//              piece is written right away and a note lands in that chat
//
// Stages, each in its own invocation (a self-call with the service key, as in
// generate-podcast), so the research and the writing don't share one budget:
//   plan       choose the topic (scheduled) or shape the learner's (requested):
//              title, angle, 4-6 research questions, and whether it revisits an
//              earlier long read and what's new
//   research   _shared/research.ts: quarantined search + page reading → a checked dossier
//   write      the English source from the dossier only (no tools), screened, then
//              handed to process-article as a 'haruka' import (it prepares part 1)
//   announce   once part 1 is ready: the morning opener (scheduled) or the chat
//              note her followup turn shares (requested)
//
// Caps, server-side: one job in flight per learner (unique index), 4 pieces a
// week of which 2 requested, 4 attempts a day, one scheduled piece a night.
// Only the service role or the cron can start a scheduled piece; a user starts
// only their own requested one.
// deno-lint-ignore-file no-explicit-any
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { actingUserId, resolveCaller } from '../_shared/auth.ts';
import { callTool, emptyUsage, type Usage } from '../_shared/claude.ts';
import { CLAUDE_HAIKU, LONGREAD_MODEL, RESEARCH_MODEL } from '../_shared/models.ts';
import { latestProfile, renderProfile, utcDay } from '../_shared/learner.ts';
import { research } from '../_shared/research.ts';
import { hasContact, renderDossier, screenParagraphs, type FilteredDossier } from '../_shared/researchFilter.ts';
import { dataRule, fence, fenceInline } from '../_shared/untrusted.ts';
import { checkCaps, PAST_WORK_COLUMNS, type PastWork, relatedWorks, toPastWork } from '../_shared/longreads.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MIN_DOSSIER_NOTES = 6;
const MIN_DOSSIER_CHARS = 2500;
const TWO_PART_DOSSIER_CHARS = 6000;
const SOURCE_MIN_CHARS = 3000;
const SOURCE_MAX_CHARS = 24000;
const ANNOUNCE_WAIT_MS = 300_000; // for part 1 before announcing anyway
const MAX_TOPIC_FILLS = 12;       // past works given a topic line per run

type Stage = 'plan' | 'research' | 'write' | 'announce';

interface Plan {
  topic: string; angle: string; why: string; title: string; questions: string[];
  revisits: string; whatsNew: string;
}

interface Job {
  id: string; user_id: string; trigger: 'scheduled' | 'requested'; status: string;
  topic: string | null; angle: string | null; thread_id: string | null;
  plan: Plan | null; dossier: FilteredDossier | null; work_id: string | null; usage: Record<string, unknown>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey);
    const body = await req.json().catch(() => ({}));
    const caller = await resolveCaller(req, admin, serviceKey);
    if (!caller) return json({ error: 'sign in required', errorKind: 'unauthorized' }, 401);

    // Internal: the next stage, in a fresh invocation.
    if (body.action === 'stage') {
      if (caller.kind !== 'service') return json({ error: 'forbidden' }, 403);
      const stage = body.stage as Stage;
      if (!['plan', 'research', 'write', 'announce'].includes(stage) || typeof body.jobId !== 'string') return json({ error: 'bad stage' }, 400);
      background(runStage(admin, body.jobId, stage));
      return json({ ok: true }, 202);
    }

    const userId = actingUserId(caller, body.userId);
    if (!userId) return json({ error: 'userId required' }, 400);

    if (body.action === 'status') {
      const { data } = await admin.from('longread_jobs').select('id, status, topic, work_id, error')
        .eq('user_id', userId).eq('id', String(body.jobId ?? '')).maybeSingle();
      return data ? json({ job: data }) : json({ error: 'not found' }, 404);
    }

    if (body.action !== 'start') return json({ error: 'unknown action' }, 400);
    const trigger = body.trigger === 'scheduled' ? 'scheduled' : 'requested';
    if (trigger === 'scheduled' && caller.kind === 'user') return json({ error: 'forbidden' }, 403);

    let topic: string | null = null;
    let angle: string | null = null;
    let threadId: string | null = null;
    if (trigger === 'requested') {
      const asked = typeof body.topic === 'string' ? body.topic.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
      if (asked.length < 2) return json({ error: 'topic required', errorKind: 'bad_request' }, 400);
      topic = asked;
      angle = typeof body.angle === 'string' && body.angle.trim() ? body.angle.replace(/\s+/g, ' ').trim().slice(0, 300) : null;
      if (typeof body.threadId === 'string' && /^[0-9a-f-]{36}$/.test(body.threadId)) {
        const { data: t } = await admin.from('tutor_threads').select('id').eq('user_id', userId).eq('id', body.threadId).maybeSingle();
        threadId = t?.id ?? null;
      }
    }

    const gate = await checkCaps(admin, userId, trigger);
    if (gate) {
      console.log(JSON.stringify({ fn: 'write-longread', userId, trigger, refused: gate.kind }));
      return json({ error: gate.message, errorKind: gate.kind }, gate.status);
    }
    const { data: job, error } = await admin.from('longread_jobs')
      .insert({ user_id: userId, trigger, topic, angle, thread_id: threadId, status: 'planning' })
      .select('id').single();
    if (error || !job) {
      // The unique in-flight index: another start won the race.
      if (error?.code === '23505') return json({ error: 'already writing one', errorKind: 'busy' }, 409);
      throw error ?? new Error('job insert failed');
    }
    handOff(job.id, 'plan');
    console.log(JSON.stringify({ fn: 'write-longread', userId, trigger, jobId: job.id, started: true }));
    return json({ jobId: job.id }, 202);
  } catch (err) {
    console.error('[write-longread] Error:', err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

function background(p: Promise<unknown>) {
  const run = p.catch((e) => console.error('[write-longread] background failed:', e));
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(run);
}

/** Start a stage in a fresh invocation (its own wall-clock budget). */
function handOff(jobId: string, stage: Stage) {
  background(fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/write-longread`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'stage', jobId, stage }),
  }).then(async (res) => {
    if (!res.ok) console.warn(`[write-longread] ${stage} for ${jobId} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }));
}

// ── Stages ───────────────────────────────────────────────────────────────────

const STAGE_STATUS: Record<Stage, string> = { plan: 'planning', research: 'researching', write: 'writing', announce: 'writing' };

async function runStage(admin: SupabaseClient, jobId: string, stage: Stage) {
  const { data: job } = await admin.from('longread_jobs').select('*').eq('id', jobId).maybeSingle<Job>();
  // A stage runs once, in order: a duplicate or late hand-off finds the job moved on.
  if (!job || job.status !== STAGE_STATUS[stage]) return;
  const t0 = Date.now();
  try {
    if (stage === 'plan') await planStage(admin, job);
    else if (stage === 'research') await researchStage(admin, job);
    else if (stage === 'write') await writeStage(admin, job);
    else await announceStage(admin, job);
    console.log(JSON.stringify({ fn: 'write-longread', jobId, stage, ms: Date.now() - t0 }));
  } catch (e) {
    await failJob(admin, job, stage, e);
  }
}

async function update(admin: SupabaseClient, jobId: string, patch: Record<string, unknown>) {
  const { error } = await admin.from('longread_jobs').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', jobId);
  if (error) throw error;
}

const costOf = (u: Usage) => ({ model: u.model, in: u.inputTokens, out: u.outputTokens, searches: u.webSearches, fetches: u.webFetches, costUsd: +u.costUsd.toFixed(5) });

async function failJob(admin: SupabaseClient, job: Job, stage: string, e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[write-longread] ${stage} failed for ${job.id}:`, msg);
  await admin.from('longread_jobs').update({ status: 'failed', error: `${stage}: ${msg}`.slice(0, 500), updated_at: new Date().toISOString() }).eq('id', job.id);
  if (job.trigger === 'requested' && job.thread_id) {
    await threadNote(admin, job, `The long read on ${fenceInline('document', job.topic ?? '')} that you started earlier couldn't be written this time. Tell the learner lightly at a natural moment; they can ask again another day.`);
  }
}

/** A note in the learner's chat that her followup turn picks up (tutor-chat's research_status / followup). */
async function threadNote(admin: SupabaseClient, job: Job, text: string, work?: { id: string; title: string }) {
  const { error } = await admin.from('tutor_messages').insert({
    thread_id: job.thread_id, user_id: job.user_id, role: 'context', text: null,
    context: { screen: 'research', id: job.id, question: job.topic ?? '', detail: '', ...(work && { work }) },
    content: [{ type: 'text', text }],
  });
  if (error) console.error('[write-longread] thread note failed:', error.message);
}

// ── Plan ─────────────────────────────────────────────────────────────────────

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    topic: { type: 'string', description: 'the subject, in a few English words' },
    angle: { type: 'string', description: 'the angle this piece takes, one sentence' },
    why: { type: 'string', description: 'why this learner, now: one sentence citing the evidence' },
    title: { type: 'string', description: 'a working English title' },
    questions: { type: 'array', items: { type: 'string' }, description: '4-6 English research questions' },
    revisits: { type: 'string', description: "the id of the earlier long read this builds on, or ''" },
    whatsNew: { type: 'string', description: "when revisiting: what this piece adds that the earlier one didn't have; else ''" },
  },
  required: ['topic', 'angle', 'why', 'title', 'questions', 'revisits', 'whatsNew'],
};

async function planStage(admin: SupabaseClient, job: Job) {
  const usage = emptyUsage(LONGREAD_MODEL);
  const ctx = await loadContext(admin, job.user_id);
  let plan: Plan | null;
  if (job.trigger === 'requested') {
    plan = await planRequested(job, ctx, usage);
  } else {
    plan = await planScheduled(ctx, usage);
    if (!plan) {
      await update(admin, job.id, { status: 'skipped', error: 'no fresh topic', usage: { ...job.usage, plan: costOf(usage) } });
      return;
    }
  }
  await update(admin, job.id, {
    status: 'researching', topic: plan.topic, angle: plan.angle, plan, usage: { ...job.usage, plan: costOf(usage) },
  });
  handOff(job.id, 'research');
}

interface Context {
  jlpt: number | null;
  profile: string;
  days: string;
  conversations: string;
  articles: string;
  ideas: string;
  works: PastWork[];
  today: string;
}

async function loadContext(admin: SupabaseClient, userId: string): Promise<Context> {
  const since = new Date(Date.now() - 14 * 86400_000).toISOString();
  const [prof, prefs, digests, threads, events, brief] = await Promise.all([
    latestProfile(admin, userId),
    admin.from('user_preferences').select('jlpt_level').eq('user_id', userId).maybeSingle(),
    admin.from('learner_digests').select('day, text').eq('user_id', userId).order('day', { ascending: false }).limit(14),
    admin.from('tutor_threads').select('day, summary').eq('user_id', userId).gt('started_at', since).not('summary', 'is', null).order('started_at'),
    admin.from('learner_events').select('at, kind, detail').eq('user_id', userId).gt('at', since)
      .in('kind', ['article_finished', 'article_skipped']).order('at').limit(300),
    admin.from('learner_briefs').select('brief').eq('user_id', userId).order('day', { ascending: false }).limit(1).maybeSingle(),
  ]);
  const ideas = ((brief.data?.brief?.ideas ?? []) as { kind: string; topic: string; why: string }[])
    .filter((i) => i?.kind === 'longform').map((i) => `- ${i.topic} (${i.why})`).join('\n');
  return {
    jlpt: prefs.data?.jlpt_level ?? null,
    profile: renderProfile(prof?.profile ?? null),
    days: ((digests.data ?? []) as any[]).reverse().map((d) => `${d.day}: ${d.text}`).join('\n'),
    conversations: ((threads.data ?? []) as any[]).map((t) => `${t.day}: ${t.summary}`).join('\n'),
    articles: ((events.data ?? []) as any[]).filter((e) => e.detail?.title)
      .map((e) => `- ${String(e.at).slice(0, 10)} ${e.kind === 'article_finished' ? 'FINISHED' : 'skipped'}: ${e.detail.title}`).join('\n'),
    ideas,
    works: await pastWorks(admin, userId),
    today: utcDay(),
  };
}

/** Every long read so far (ハルカ's and the learner's imports), each with a topic
 *  line and a short summary; works without them get them now (Haiku). */
async function pastWorks(admin: SupabaseClient, userId: string): Promise<PastWork[]> {
  const { data } = await admin.from('long_form_works')
    .select(PAST_WORK_COLUMNS)
    .eq('user_id', userId).order('created_at', { ascending: false }).limit(200);
  const rows = (data ?? []) as any[];
  const missing = rows.filter((r) => !r.meta?.topic).slice(0, MAX_TOPIC_FILLS);
  if (missing.length) {
    const { data: texts } = await admin.from('long_form_works').select('id, raw_text').in('id', missing.map((r) => r.id));
    const usage = emptyUsage(CLAUDE_HAIKU);
    await Promise.all(((texts ?? []) as any[]).map(async (t) => {
      try {
        const out = await callTool<{ topic: string; summary: string }>({
          model: CLAUDE_HAIKU, usage, maxTokens: 400, name: 'describe_text',
          description: 'Record what a text is about.',
          prompt: `Say what this text is about, for a list of what a reader has already read.
- topic: its subject in 3-10 plain English words.
- summary: 2-3 neutral English sentences on what it covers.

${fence('document', String(t.raw_text ?? '').slice(0, 5000))}

${dataRule(['document'])}`,
          schema: { type: 'object', properties: { topic: { type: 'string' }, summary: { type: 'string' } }, required: ['topic', 'summary'] },
        });
        const row = rows.find((r) => r.id === t.id);
        const meta = { ...(row?.meta ?? {}), topic: String(out.topic ?? '').slice(0, 120), summary: String(out.summary ?? '').slice(0, 600) };
        await admin.from('long_form_works').update({ meta }).eq('id', t.id);
        if (row) row.meta = meta;
      } catch (e) {
        console.warn('[write-longread] topic line failed for', t.id, e instanceof Error ? e.message : e);
      }
    }));
  }
  return rows.map(toPastWork);
}

const renderWorks = (works: PastWork[], withSummary = false) => works.map((w) =>
  `- [${w.id}] ${w.day} ${w.sourceType === 'haruka' ? 'ハルカ' : 'their import'}, ${w.state}: 「${w.title}」${w.topic ? ` — ${w.topic}` : ''}${withSummary && w.summary ? `\n  ${w.summary}` : ''}`).join('\n');

const level = (jlpt: number | null) => (jlpt ? `N${jlpt}` : 'N4');

async function planScheduled(ctx: Context, usage: Usage): Promise<Plan | null> {
  const base = `You are ハルカ, a Japanese tutor inside Yugen, and twice a week you write your learner a long read: a magazine-style feature (2,000-3,000 words) that the app rewrites into Japanese at their level (JLPT ${level(ctx.jlpt)}). Tonight (${ctx.today}) you choose what it's about.

What makes a good choice:
- Something this learner would want to read now, from the evidence below: what they keep talking about with you, what they finished, plans and interests in their profile. Strong signals: things said in conversation, finished articles. Skips are weak: a skip is about one story, never a dislike of its subject.
- Longer arcs than the news: history, how something works, a place, a person, the background to a story they've been following. Not breaking news; the daily feed covers that.
- Variety: spread across areas. Every few pieces, bring in a neighbouring interest (a trip + food → the food of that place).
- Past long reads (below) are there so you don't retell one. Coming back to a subject is fine when it's worth it: the story has moved on, they kept talking about it or asked for more, or there's a side the earlier piece only touched. Then set revisits to that piece's id and say in whatsNew what this one adds; the new piece will build on the old one. Most pieces should be new ground. When nothing new is worth saying about a subject, choose something else.
- An unfinished or unopened long read counts a little against similar topics; one they finished or talked about counts for them.

PROFILE
${fence('profile', ctx.profile)}

LAST TWO WEEKS, DAY BY DAY
${fence('days', ctx.days || '(none)')}

CONVERSATIONS WITH YOU
${fence('conversations', ctx.conversations || '(none)')}

ARTICLES FINISHED AND SKIPPED
${fence('articles', ctx.articles || '(none)')}

IDEAS FROM LAST NIGHT'S MEMORY PASS
${fence('ideas', ctx.ideas || '(none)')}

PAST LONG READS (newest first)
${fence('works', renderWorks(ctx.works) || '(none yet)')}

${dataRule(['profile', 'days', 'conversations', 'articles', 'ideas', 'works'])}

Call plan_long_read with the topic, the angle, why (cite the evidence), a working English title, and 4-6 research questions that would give a writer the background, the timeline, the people and places, a few memorable stories, and what's happened recently.`;

  let feedback = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const plan = cleanPlan(await callTool<Plan>({
      model: LONGREAD_MODEL, usage, maxTokens: 3000, name: 'plan_long_read',
      description: "Choose tonight's long read and plan its research.",
      prompt: base + feedback, schema: PLAN_SCHEMA,
    }), ctx.works);
    const clash = await undeclaredRepeat(plan, ctx.works);
    if (!clash) return plan;
    console.log(JSON.stringify({ fn: 'write-longread', repeat: plan.topic, matches: clash.title }));
    feedback = `\n\nYou chose "${plan.topic}", which covers the same subject as the earlier long read [${clash.id}] 「${clash.title}」 (${clash.topic}). Either choose something else, or, if coming back to it is worth it, set revisits to "${clash.id}" and say in whatsNew what the new piece adds.`;
  }
  return null;
}

async function planRequested(job: Job, ctx: Context, usage: Usage): Promise<Plan> {
  const related = relatedWorks(`${job.topic} ${job.angle ?? ''}`, ctx.works);
  const plan = cleanPlan(await callTool<Plan>({
    model: LONGREAD_MODEL, usage, maxTokens: 3000, name: 'plan_long_read',
    description: 'Plan the research for the long read the learner asked for.',
    prompt: `You are ハルカ, a Japanese tutor inside Yugen. Your learner asked you for a long read: a magazine-style feature (2,000-3,000 words) that the app rewrites into Japanese at their level (JLPT ${level(ctx.jlpt)}). Plan it.

THEIR REQUEST (the topic, and the angle if they gave one)
${fence('request', `${job.topic}${job.angle ? `\nAngle: ${job.angle}` : ''}`)}

Keep to what they asked for: the topic stays theirs, in a few English words. Shape the angle around their request and what you know of them.

EARLIER LONG READS ON NEARBY SUBJECTS
${fence('works', renderWorks(related, true) || '(none)')}
If one of these covers the same subject, set revisits to its id and say in whatsNew what the new piece adds, so it builds on the earlier one instead of retelling it.

WHAT YOU KNOW ABOUT THEM
${fence('profile', ctx.profile)}

${dataRule(['request', 'works', 'profile'])}

Call plan_long_read with the topic, the angle, why (one line), a working English title, and 4-6 research questions that would give a writer the background, the timeline, the people and places, a few memorable stories, and what's happened recently.`,
    schema: PLAN_SCHEMA,
  }), ctx.works);
  return { ...plan, topic: plan.topic || job.topic || '' };
}

function cleanPlan(p: Plan, works: PastWork[]): Plan {
  const str = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
  const questions = (Array.isArray(p?.questions) ? p.questions : []).map((q) => str(q, 240)).filter((q) => q.length >= 8).slice(0, 6);
  const revisits = works.some((w) => w.id === p?.revisits) ? p.revisits : '';
  const plan = {
    topic: str(p?.topic, 120), angle: str(p?.angle, 300), why: str(p?.why, 400), title: str(p?.title, 160),
    questions, revisits, whatsNew: revisits ? str(p?.whatsNew, 400) : '',
  };
  if (plan.topic.length < 2 || questions.length < 3) throw new Error('plan came back without a topic or questions');
  return plan;
}

/** A close match to a past work that the plan didn't declare as a revisit (Haiku confirms). */
async function undeclaredRepeat(plan: Plan, works: PastWork[]): Promise<PastWork | null> {
  const close = relatedWorks(`${plan.topic} ${plan.title}`, works).filter((w) => w.id !== plan.revisits);
  if (!close.length) return null;
  if (plan.revisits && plan.whatsNew) return null;
  try {
    const out = await callTool<{ same: boolean[] }>({
      model: CLAUDE_HAIKU, usage: emptyUsage(CLAUDE_HAIKU), maxTokens: 200, name: 'compare_subjects',
      description: 'Whether each earlier piece is about the same subject as the new one.',
      prompt: `A new feature is planned on: ${fenceInline('topic', `${plan.topic} — ${plan.angle}`)}
For each earlier piece below, in order, answer true if it is about the same subject (a retelling), false if it is only in the same area ("Kyoto's tea houses" vs "Kyoto's temples" is false).
${close.map((w, i) => `${i + 1}. ${fenceInline('piece', `${w.title} — ${w.topic}`)}`).join('\n')}
${dataRule(['topic', 'piece'])}`,
      schema: { type: 'object', properties: { same: { type: 'array', items: { type: 'boolean' } } }, required: ['same'] },
    });
    return close.find((_, i) => out.same?.[i] === true) ?? null;
  } catch {
    return null;   // the check is a nudge; never block a piece on it
  }
}

// ── Research ─────────────────────────────────────────────────────────────────

async function researchStage(admin: SupabaseClient, job: Job) {
  const plan = job.plan!;
  const usage = emptyUsage(RESEARCH_MODEL);
  const dossier = await research(`${plan.topic}. ${plan.angle}${plan.whatsNew ? ` New since an earlier piece: ${plan.whatsNew}` : ''}`.slice(0, 600), plan.questions, usage);
  const cost = { ...job.usage, research: { ...costOf(usage), notes: dossier.notes.length, withheld: dossier.withheld.length, chars: dossier.chars } };
  if (dossier.notes.length < MIN_DOSSIER_NOTES || dossier.chars < MIN_DOSSIER_CHARS) {
    await update(admin, job.id, { usage: cost });
    throw new Error(`not enough material (${dossier.notes.length} notes, ${dossier.chars} chars)`);
  }
  await update(admin, job.id, { status: 'writing', dossier: { notes: dossier.notes, withheld: [], chars: dossier.chars }, usage: cost });
  handOff(job.id, 'write');
}

// ── Write ────────────────────────────────────────────────────────────────────

interface Written { title: string; titleJa: string; summary: string; body: string; opener: string }

async function writeStage(admin: SupabaseClient, job: Job) {
  // Already handed over (a repeated hand-off): just announce.
  if (job.work_id) return handOff(job.id, 'announce');
  const plan = job.plan!;
  const dossier = job.dossier!;
  const usage = emptyUsage(LONGREAD_MODEL);
  const [{ data: prefs }, prof, earlier] = await Promise.all([
    admin.from('user_preferences').select('jlpt_level').eq('user_id', job.user_id).maybeSingle(),
    latestProfile(admin, job.user_id),
    plan.revisits
      ? admin.from('long_form_works').select('title, meta, created_at').eq('user_id', job.user_id).eq('id', plan.revisits).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const jlpt = prefs?.jlpt_level ?? null;
  const twoParts = dossier.chars >= TWO_PART_DOSSIER_CHARS;
  const target = twoParts ? '2,200-2,800 words (about 13,000-16,000 characters)' : '1,200-1,500 words (about 7,000-9,000 characters)';
  const known = prof?.profile ? [prof.profile.summary, ...prof.profile.items.slice(0, 12).map((i) => `- ${i.text}`)].join('\n') : '';

  const out = await callTool<Written>({
    model: LONGREAD_MODEL, usage, maxTokens: 12000, name: 'write_long_read',
    description: 'The long read, in English, ready to be rewritten into Japanese.',
    prompt: `You are writing a long read for one Japanese learner (JLPT ${level(jlpt)}). Your English text is the source: the app rewrites it into Japanese at their level, paragraph by paragraph. Write it like a good magazine feature that a curious adult would enjoy.

THE PIECE
Topic: ${fenceInline('plan', plan.topic)}
Angle: ${fenceInline('plan', plan.angle)}
Working title: ${fenceInline('plan', plan.title)}
${earlier?.data ? `This piece builds on an earlier long read they have, ${fenceInline('plan', earlier.data.title)} (${String(earlier.data.created_at).slice(0, 10)}), which covered:
${fence('earlier', String(earlier.data.meta?.summary ?? earlier.data.meta?.topic ?? ''))}
What's new: ${fenceInline('plan', plan.whatsNew)}
Recall the earlier piece in a sentence or two at most, then spend the piece on what's new. Don't retell it.
` : ''}
THE RESEARCH (your only source for specifics)
${fence('dossier', renderDossier(dossier))}

How to write it:
- Length: ${target}. Paragraphs of 100-200 words, separated by a blank line. No headings, lists, bullet points or markdown.
- Specifics (names, numbers, dates, quotes, recent events) come only from the research. Widely known background is fine. Never invent a quote, a number, a date or a person. Where the research is thin, write less rather than fill in.
- It will become simple Japanese: concrete over abstract, clear chronology, one idea per sentence where you can, explain any term a newcomer wouldn't know. No wordplay that only works in English.
- Tell it: open with a scene or a moment, follow people, end on something that lingers. Say where facts come from by name when it helps ("according to the city's records").
- Never: links, web addresses, email addresses or phone numbers; addressing the reader as "you"; anything about AI tutors, apps, prompts or this piece being written. If the topic itself is AI, write about it as a subject like any other.

Also:
- titleJa: a short Japanese title (under 20 characters) at ${level(jlpt)} or easier.
- title: the English title.
- summary: 2-3 neutral English sentences on what the piece covers (kept so later pieces can build on it).
- opener: one short, casual Japanese line ハルカ can say to tell the learner she wrote it, at ${level(jlpt)} or easier, naming the topic and ending with an easy question or invitation. No links, romaji or markup; never call the learner by a name, and never as ハルカ.

What ハルカ knows about the learner (for the opener's tone; the piece itself is for anyone):
${fence('profile', known || '(nothing yet)')}

${dataRule(['plan', 'earlier', 'dossier', 'profile'])}`,
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' }, titleJa: { type: 'string' }, summary: { type: 'string' },
        body: { type: 'string' }, opener: { type: 'string' },
      },
      required: ['title', 'titleJa', 'summary', 'body', 'opener'],
    },
  });

  // Checks before anything is saved: shape, then paragraph by paragraph.
  let paragraphs = String(out.body ?? '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
  const flagged = screenParagraphs(paragraphs);
  if (flagged.length > Math.max(2, Math.floor(paragraphs.length / 10))) {
    throw new Error(`source failed the checks (${flagged.map((f) => f.reason).join(', ')})`);
  }
  if (flagged.length) {
    console.warn('[write-longread] dropped paragraphs:', JSON.stringify(flagged));
    const drop = new Set(flagged.map((f) => f.index));
    paragraphs = paragraphs.filter((_, i) => !drop.has(i));
  }
  const body = paragraphs.join('\n\n');
  if (body.length < SOURCE_MIN_CHARS || body.length > SOURCE_MAX_CHARS) throw new Error(`source length ${body.length} out of bounds`);
  const clean = (s: unknown, n: number) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
    return t && !hasContact(t) && !/[<>{}`]/.test(t) ? t : '';
  };
  const titleJa = clean(out.titleJa, 40);
  const title = titleJa || clean(out.title, 160) || plan.title;
  const opener = /[぀-ヿ一-鿿]/.test(String(out.opener ?? '')) ? clean(out.opener, 140) : '';

  // process-article saves the work and prepares part 1 in the background.
  const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/process-article`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: job.user_id, importText: body, title, sourceType: 'haruka',
      meta: {
        topic: plan.topic, summary: clean(out.summary, 600), why: plan.why, trigger: job.trigger,
        revisits: plan.revisits || null, whatsNew: plan.whatsNew || null, jobId: job.id, englishTitle: clean(out.title, 160),
      },
    }),
  });
  const handed = await res.json().catch(() => ({}));
  if (!res.ok || !handed?.work?.id) throw new Error(`process-article ${res.status}: ${String(handed?.error ?? '').slice(0, 200)}`);

  await update(admin, job.id, {
    work_id: handed.work.id,
    plan: { ...plan, opener },
    usage: { ...job.usage, write: { ...costOf(usage), chars: body.length, parts: handed.work.part_count } },
  });
  handOff(job.id, 'announce');
}

// ── Announce ─────────────────────────────────────────────────────────────────

async function announceStage(admin: SupabaseClient, job: Job) {
  if (!job.work_id) throw new Error('no work to announce');
  const { data: work } = await admin.from('long_form_works').select('id, title, part_count').eq('id', job.work_id).maybeSingle();
  if (!work) throw new Error('work missing');
  // Wait for part 1, so the block opens straight into it.
  const deadline = Date.now() + ANNOUNCE_WAIT_MS;
  let partStatus = '';
  while (Date.now() < deadline) {
    const { data: part } = await admin.from('processed_news').select('status')
      .eq('user_id', job.user_id).eq('id', `lf-${work.id}-p1`).maybeSingle();
    partStatus = part?.status ?? '';
    if (partStatus && partStatus !== 'pending') break;
    await new Promise((r) => setTimeout(r, 8000));
  }
  const ref = { id: work.id as string, title: work.title as string };

  if (job.trigger === 'requested') {
    if (job.thread_id) {
      const ready = partStatus === 'failed'
        ? `The long read you started earlier is written, ${fenceInline('document', ref.title)}, but its Japanese version hit a problem. It's in the learner's 本棚, where tapping it tries again; the app shows it under your next line. Tell them lightly at a natural moment.`
        : `The long read you started earlier is ready: ${fenceInline('document', ref.title)} (${work.part_count} part${work.part_count > 1 ? 's' : ''}). It's in the learner's 本棚, and the app shows it under your next line so they can open it from the chat. Tell them it's ready at a natural moment, in a line or two; don't summarise the piece.`;
      await threadNote(admin, job, ready, ref);
    }
  } else {
    // The dream wrote this morning's brief minutes ago: her line about the piece
    // goes first (after a Sunday recap teaser), and the brief names the work.
    const { data: b } = await admin.from('learner_briefs').select('day, brief').eq('user_id', job.user_id)
      .order('day', { ascending: false }).limit(1).maybeSingle();
    const opener = (job.plan as any)?.opener as string | undefined;
    if (b?.brief && opener) {
      const openers = (b.brief.openers ?? []) as string[];
      const next = !opener ? openers : b.brief.recap ? [openers[0], opener, ...openers.slice(1)] : [opener, ...openers];
      await admin.from('learner_briefs').update({ brief: { ...b.brief, openers: next.slice(0, 3), longread: ref } })
        .eq('user_id', job.user_id).eq('day', b.day);
    }
  }
  await update(admin, job.id, { status: 'done', error: partStatus === 'failed' ? 'part 1 failed (retry from 本棚)' : null });
}
