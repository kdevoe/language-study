// tutor-chat: ハルカ, the tutor who is also your language-exchange partner
// (docs/tutor-agent-design.md, docs/learner-memory-design.md §4).
//
// actions
//   history  today's open thread (the panel reopens where you left off)
//   send     append the screen context (if new) and your message, stream ハルカ's
//            reply as server-sent events, running her tools in between
//   end      close the thread and write the recap (corrections, new words,
//            words used well)
//
// Prompt layout, stable so it caches (tools → system → messages):
//   tools · persona + rules · learner memory (changes once a day) · the thread,
//   with screen contexts appended as mid-thread <screen> notes.
// The chat never edits the profile: notes and usage are appended to
// learner_notes and folded in by the nightly dream (learner-dream).
//
// Auth: the signed-in user's JWT only.
// deno-lint-ignore-file no-explicit-any
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CLAUDE_HAIKU, TUTOR_MODEL } from '../_shared/models.ts';
import { addUsage, anthropic, callTool, emptyUsage, type Usage } from '../_shared/claude.ts';
import { loadMemory, renderMemory } from '../_shared/learner.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MAX_TOOL_ROUNDS = 4;
const MAX_HISTORY_MESSAGES = 80;   // older turns drop off (the dream already has them)
const MAX_USER_CHARS = 2000;

const PERSONA = `あなたはハルカ。30代。明るく好奇心旺盛で、相手と同じ目線で話す。Yugenという日本語学習アプリの中にいる、学習者の日本語の先生であり、ランゲージエクスチェンジの友だちでもある。

You are one person who switches languages fluidly, like a good exchange partner who tutors:
- Speak JAPANESE by default, at the learner's level (their JLPT level is in the memory below). Short, natural, friendly sentences (casual です/ます-free speech is fine, like a friend). One to three sentences per turn unless they ask for more.
- Use mostly words at or below their level. A slightly harder word is fine when it's the natural word — they can tap any word to look it up.
- Asides: when they ask about Japanese, or a mistake matters, step out briefly in {ASIDE_LANG}, then go straight back to Japanese. Put each aside inside <aside>…</aside> on its own line. Keep asides to one or two sentences unless they asked for a full explanation.
- Correction is your judgment, like a person's: small slips → recast in passing (say it back correctly, wrapping the corrected words in <fix>…</fix>, no comment); a pattern they keep getting wrong → a brief aside; anything they ask about → a full explanation. {CORRECTION}
- Never mark up anything else: no markdown, no bullet lists, no romaji, no furigana in brackets (the app adds furigana).
- If they write in English, answer the question, then invite them back into Japanese with an easy line.
- Stay with Japanese and their study material and life. If asked to do unrelated work (code, essays, homework in other subjects), say kindly that you're here for Japanese and offer to talk about it in Japanese instead.

What you know and can do:
- The LEARNER MEMORY below is what the app knows about them. Use it naturally — mention an article they finished or a plan they told you — but don't recite it.
- <screen> notes in the conversation say what is on their screen when they open you. Help with that if it's what they're asking about. On an unrevealed flashcard you only see the prompt side: give hints, never the answer.
- Tools: look words up before explaining a sense you're unsure of; fetch the article/podcast/song text when you need more than the screen note; save_note for lasting things they tell you (a trip, their job, a recurring mistake, how they like to be corrected); record_usage when they use a target word well or wrongly; add_to_deck when a new word comes up that they'd want to keep; suggest_grammar_rating only when the conversation gives clear evidence (it's a suggestion they confirm, never a change); request_content when they ask for a podcast on something.
- Never claim you saved, added or changed something unless you called the tool.`;

const TOOLS: any[] = [
  {
    name: 'lookup_word',
    description: 'Look a Japanese word up in JMDict: readings, parts of speech and English senses.',
    input_schema: { type: 'object', properties: { word: { type: 'string', description: 'dictionary form, kanji or kana' } }, required: ['word'] },
  },
  {
    name: 'get_text',
    description: "Fetch the full Japanese text of one of the learner's articles, podcast episodes or songs, by the id given in a <screen> note.",
    input_schema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['article', 'podcast', 'song'] }, id: { type: 'string' } },
      required: ['kind', 'id'],
    },
  },
  {
    name: 'add_to_deck',
    description: "Offer a word for the learner's flashcard deck. It appears in the recap with a one-tap add; it isn't added until they tap.",
    input_schema: {
      type: 'object',
      properties: { word: { type: 'string' }, reading: { type: 'string' }, meaning: { type: 'string', description: 'short English gloss' } },
      required: ['word', 'reading', 'meaning'],
    },
  },
  {
    name: 'record_usage',
    description: 'Note that the learner used a word or grammar point in their own Japanese, correctly or not. Shown in the recap and remembered.',
    input_schema: {
      type: 'object',
      properties: { item: { type: 'string', description: 'the word or grammar point' }, correct: { type: 'boolean' }, note: { type: 'string' } },
      required: ['item', 'correct'],
    },
  },
  {
    name: 'save_note',
    description: 'Remember something lasting about the learner. Folded into their profile overnight.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['struggle', 'interest', 'personal', 'preference'] },
        text: { type: 'string', description: 'one plain-English line, with a date if it has one (YYYY-MM-DD)' },
        aboutRelationship: { type: 'boolean', description: 'true for things they told you personally (their weekend, their job)' },
      },
      required: ['kind', 'text'],
    },
  },
  {
    name: 'set_preference',
    description: 'Change how you tutor them when they ask: correction style and the language of asides.',
    input_schema: {
      type: 'object',
      properties: {
        correction: { type: 'string', enum: ['recast', 'all', 'ask'], description: 'recast: recast slips, explain repeats · all: correct everything · ask: only when asked' },
        asides: { type: 'string', enum: ['en', 'ja'], description: 'explain in English or easy Japanese' },
      },
    },
  },
  {
    name: 'search_history',
    description: 'Search what the learner read, heard and talked about before ("the article about the breakfast street", "what we talked about last Tuesday").',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'a few English or Japanese keywords' } }, required: ['query'] },
  },
  {
    name: 'suggest_grammar_rating',
    description: "Suggest changing one of their grammar-panel ratings (EASY/MEDIUM/HARD) when the conversation shows clear evidence. They confirm it; you never change it.",
    input_schema: {
      type: 'object',
      properties: { pointId: { type: 'string', description: 'grammar point id, e.g. te_iru' }, rating: { type: 'string', enum: ['easy', 'medium', 'hard'] }, why: { type: 'string' } },
      required: ['pointId', 'rating', 'why'],
    },
  },
  {
    name: 'request_content',
    description: 'Make a podcast episode for them on a topic they asked for. It appears in 聞く when ready (a few minutes).',
    input_schema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['podcast'] }, topic: { type: 'string', description: '2-80 characters' }, angle: { type: 'string', description: 'optional: what to focus on' } },
      required: ['kind', 'topic'],
    },
  },
];
TOOLS[TOOLS.length - 1].cache_control = { type: 'ephemeral' };

interface ScreenContext { screen: string; chip?: string; detail: string }

const sse = (obj: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return json({ error: 'sign in required' }, 401);
  const userId = user.id;

  const body = await req.json().catch(() => ({}));
  const day = typeof body.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.day) ? body.day : new Date().toISOString().slice(0, 10);

  try {
    if (body.action === 'history') {
      const thread = await openThread(admin, userId, day);
      if (!thread) return json({ thread: null, messages: [] });
      const { data } = await admin.from('tutor_messages').select('id, role, text, context, created_at')
        .eq('thread_id', thread.id).not('text', 'is', null).order('created_at');
      return json({ thread, messages: data ?? [] });
    }

    if (body.action === 'end') {
      const thread = typeof body.threadId === 'string' ? body.threadId : (await openThread(admin, userId, day))?.id;
      if (!thread) return json({ recap: null });
      return json({ recap: await endThread(admin, userId, thread) });
    }

    // ── send ──
    const message = typeof body.message === 'string' ? body.message.trim().slice(0, MAX_USER_CHARS) : '';
    if (!message) return json({ error: 'message required' }, 400);
    let thread = body.newThread ? null : await openThread(admin, userId, day);
    if (!thread) {
      const { data, error } = await admin.from('tutor_threads').insert({ user_id: userId, day }).select('id, day, started_at').single();
      if (error) throw error;
      thread = data;
    }
    const threadId = thread!.id as string;

    // New screen context (opened from a different place) → a <screen> note.
    const ctx = body.context as ScreenContext | undefined;
    if (ctx?.detail) {
      const { data: lastCtx } = await admin.from('tutor_messages').select('context').eq('thread_id', threadId)
        .eq('role', 'context').order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (lastCtx?.context?.detail !== ctx.detail) {
        await admin.from('tutor_messages').insert({
          thread_id: threadId, user_id: userId, role: 'context', context: ctx, text: null,
          content: [{ type: 'text', text: `<screen>${ctx.detail}</screen>` }],
        });
      }
    }
    // The Home card's opener is ハルカ's first line of a fresh thread.
    if (typeof body.opener === 'string' && body.opener.trim()) {
      const { count } = await admin.from('tutor_messages').select('id', { count: 'exact', head: true }).eq('thread_id', threadId).neq('role', 'context');
      if (!count) {
        if (!ctx?.detail) {
          await admin.from('tutor_messages').insert({
            thread_id: threadId, user_id: userId, role: 'context', text: null, context: { screen: 'home', detail: 'Opened from the Home card.' },
            content: [{ type: 'text', text: '<screen>The learner opened you from the Home card.</screen>' }],
          });
        }
        const opener = body.opener.trim().slice(0, 300);
        await admin.from('tutor_messages').insert({
          thread_id: threadId, user_id: userId, role: 'assistant', text: opener, content: [{ type: 'text', text: opener }],
        });
      }
    }
    await admin.from('tutor_messages').insert({
      thread_id: threadId, user_id: userId, role: 'user', text: message, content: [{ type: 'text', text: message }],
    });

    const memory = await loadMemory(admin, userId);
    const system = [
      { type: 'text', text: persona(memory.tutorPrefs) },
      { type: 'text', text: `LEARNER MEMORY (today is ${day})\n\n${renderMemory(memory, { brief: true })}`, cache_control: { type: 'ephemeral' } },
    ];

    const stream = new ReadableStream({
      async start(controller) {
        const send = (o: unknown) => { try { controller.enqueue(sse(o)); } catch { /* client went away */ } };
        send({ type: 'thread', threadId });
        try {
          await runTurn({ admin, userId, threadId, system, send });
        } catch (e) {
          console.error('[tutor-chat] turn failed:', e);
          send({ type: 'error', error: 'ハルカが今は答えられません。少し待ってからもう一度どうぞ。' });
        }
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { ...corsHeaders, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    });
  } catch (err) {
    console.error('[tutor-chat] Error:', err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

function persona(prefs: { correction?: string; asides?: string }) {
  const correction = prefs.correction === 'all'
    ? 'They asked you to correct every mistake: recast each one with <fix>, and add a short aside for anything beyond a slip.'
    : prefs.correction === 'ask'
      ? 'They asked to be corrected only when they ask: just keep talking naturally (a quiet recast is fine).'
      : '';
  return PERSONA
    .replace('{ASIDE_LANG}', prefs.asides === 'ja' ? 'easy Japanese' : 'English')
    .replace('{CORRECTION}', correction);
}

async function openThread(admin: SupabaseClient, userId: string, day: string) {
  const { data } = await admin.from('tutor_threads').select('id, day, started_at')
    .eq('user_id', userId).eq('day', day).is('ended_at', null)
    .order('started_at', { ascending: false }).limit(1).maybeSingle();
  return data as { id: string; day: string; started_at: string } | null;
}

/** The thread as API messages: contexts become user-role notes, same-role runs merge. */
async function loadThread(admin: SupabaseClient, threadId: string) {
  const { data } = await admin.from('tutor_messages').select('role, content').eq('thread_id', threadId).order('created_at');
  let rows = (data ?? []) as { role: string; content: any[] }[];
  if (rows.length > MAX_HISTORY_MESSAGES) {
    // Cut at a plain user message so no tool_use loses its tool_result.
    let start = rows.length - MAX_HISTORY_MESSAGES;
    while (start < rows.length && !(rows[start].role !== 'assistant' && rows[start].content.every((b) => b.type === 'text'))) start++;
    rows = rows.slice(start);
  }
  const messages: { role: 'user' | 'assistant'; content: any[] }[] = [];
  for (const r of rows) {
    const role = r.role === 'assistant' ? 'assistant' : 'user';
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content = [...last.content, ...r.content];
    else messages.push({ role, content: [...r.content] });
  }
  while (messages.length && messages[0].role !== 'user') messages.shift();
  return messages;
}

async function runTurn(opts: {
  admin: SupabaseClient; userId: string; threadId: string; system: any[]; send: (o: unknown) => void;
}) {
  const { admin, userId, threadId, system, send } = opts;
  const usage = emptyUsage(TUTOR_MODEL);
  const messages = await loadThread(admin, threadId);
  let finalText = '';

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    // Cache the whole conversation so far: the next turn reads it back cheaply.
    const last = messages[messages.length - 1];
    const lastBlock = last.content[last.content.length - 1];
    const marked = { ...lastBlock, cache_control: { type: 'ephemeral' } };
    const req = {
      model: TUTOR_MODEL,
      max_tokens: 2048,
      system,
      tools: TOOLS,
      messages: [...messages.slice(0, -1), { role: last.role, content: [...last.content.slice(0, -1), marked] }],
    };
    const stream = anthropic.messages.stream(req as any);
    stream.on('text', (t: string) => send({ type: 'text', text: t }));
    const msg: any = await stream.finalMessage();
    addUsage(usage, msg.usage);

    const text = msg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    finalText += text;
    // Keep every block (thinking included): a tool loop must hand back the
    // assistant turn exactly as it came.
    const content = msg.content;
    await admin.from('tutor_messages').insert({
      thread_id: threadId, user_id: userId, role: 'assistant', content,
      text: text.trim() || null, usage: msg.stop_reason === 'tool_use' ? null : usage,
    });
    messages.push({ role: 'assistant', content });

    if (msg.stop_reason !== 'tool_use') break;
    const results: any[] = [];
    for (const call of msg.content.filter((b: any) => b.type === 'tool_use')) {
      send({ type: 'tool', name: call.name });
      let out: string;
      try {
        out = await runTool(admin, userId, threadId, call.name, call.input ?? {}, send);
      } catch (e) {
        out = `error: ${e instanceof Error ? e.message : String(e)}`;
      }
      results.push({ type: 'tool_result', tool_use_id: call.id, content: out });
    }
    await admin.from('tutor_messages').insert({ thread_id: threadId, user_id: userId, role: 'user', content: results, text: null });
    messages.push({ role: 'user', content: results });
    if (text.trim()) send({ type: 'text', text: '\n' });
  }

  // Running cost on the thread.
  const { data: t } = await admin.from('tutor_threads').select('usage').eq('id', threadId).maybeSingle();
  const prev = (t?.usage ?? {}) as Partial<Usage> & { turns?: number };
  await admin.from('tutor_threads').update({
    usage: {
      model: TUTOR_MODEL,
      turns: (prev.turns ?? 0) + 1,
      inputTokens: (prev.inputTokens ?? 0) + usage.inputTokens,
      outputTokens: (prev.outputTokens ?? 0) + usage.outputTokens,
      cacheReadTokens: (prev.cacheReadTokens ?? 0) + usage.cacheReadTokens,
      cacheWriteTokens: (prev.cacheWriteTokens ?? 0) + usage.cacheWriteTokens,
      costUsd: +(((prev.costUsd ?? 0) + usage.costUsd).toFixed(5)),
    },
  }).eq('id', threadId);
  send({ type: 'done', text: finalText, costUsd: +usage.costUsd.toFixed(5) });
}

// ── Tools ────────────────────────────────────────────────────────────────────

async function runTool(
  admin: SupabaseClient, userId: string, threadId: string, name: string, input: any, send: (o: unknown) => void,
): Promise<string> {
  switch (name) {
    case 'lookup_word': return lookupWord(admin, String(input.word ?? ''));
    case 'get_text': return getText(admin, userId, input.kind, String(input.id ?? ''));
    case 'add_to_deck': {
      send({ type: 'action', action: { type: 'add_to_deck', word: input.word, reading: input.reading, meaning: input.meaning } });
      await admin.from('learner_notes').insert({
        user_id: userId, kind: 'usage', source: 'tutor', text: `offered ${input.word} (${input.meaning}) for the deck`,
        ref: { threadId, offer: { word: input.word, reading: input.reading, meaning: input.meaning } },
      });
      return 'Offered in the recap with a one-tap add.';
    }
    case 'record_usage': {
      await admin.from('learner_notes').insert({
        user_id: userId, kind: 'usage', source: 'tutor',
        text: `${input.correct ? 'used well' : 'got wrong'}: ${input.item}${input.note ? ` — ${input.note}` : ''}`,
        ref: { threadId, item: input.item, correct: !!input.correct },
      });
      return 'Recorded.';
    }
    case 'save_note': {
      const kind = ['struggle', 'interest', 'personal', 'preference'].includes(input.kind) ? input.kind : 'personal';
      await admin.from('learner_notes').insert({
        user_id: userId, kind, source: 'tutor', text: String(input.text ?? '').slice(0, 500),
        persona: input.aboutRelationship ? 'haruka' : null, ref: { threadId },
      });
      return 'Saved. It joins their profile overnight.';
    }
    case 'set_preference': {
      const { data } = await admin.from('user_preferences').select('tutor_prefs').eq('user_id', userId).maybeSingle();
      const next = { ...(data?.tutor_prefs ?? {}) };
      if (['recast', 'all', 'ask'].includes(input.correction)) next.correction = input.correction;
      if (['en', 'ja'].includes(input.asides)) next.asides = input.asides;
      await admin.from('user_preferences').upsert({ user_id: userId, tutor_prefs: next });
      send({ type: 'action', action: { type: 'preference', prefs: next } });
      return `Saved: ${JSON.stringify(next)}. It applies from the next message.`;
    }
    case 'search_history': return searchHistory(admin, userId, String(input.query ?? ''));
    case 'suggest_grammar_rating': {
      send({ type: 'action', action: { type: 'grammar_rating', pointId: input.pointId, rating: input.rating, why: input.why } });
      return 'Shown to them as a suggestion to confirm.';
    }
    case 'request_content': return requestPodcast(userId, String(input.topic ?? ''), input.angle, send);
    default: return `unknown tool ${name}`;
  }
}

async function lookupWord(admin: SupabaseClient, word: string): Promise<string> {
  if (!word) return 'no word given';
  const [k, r] = await Promise.all([
    admin.from('jmdict_kanji').select('entry_id').eq('text', word).limit(5),
    admin.from('jmdict_kana').select('entry_id').eq('text', word).limit(5),
  ]);
  const ids = [...new Set([...(k.data ?? []), ...(r.data ?? [])].map((x: any) => x.entry_id))].slice(0, 3);
  if (!ids.length) return `${word}: not in JMDict`;
  const [senses, kana, kanji] = await Promise.all([
    admin.from('jmdict_senses').select('entry_id, pos, gloss').in('entry_id', ids).order('id'),
    admin.from('jmdict_kana').select('entry_id, text').in('entry_id', ids),
    admin.from('jmdict_kanji').select('entry_id, text').in('entry_id', ids),
  ]);
  return ids.map((id) => {
    const forms = (kanji.data ?? []).filter((x: any) => x.entry_id === id).map((x: any) => x.text).slice(0, 3);
    const reads = (kana.data ?? []).filter((x: any) => x.entry_id === id).map((x: any) => x.text).slice(0, 3);
    const ss = (senses.data ?? []).filter((x: any) => x.entry_id === id).slice(0, 4)
      .map((s: any, n: number) => `${n + 1}. [${(s.pos ?? []).slice(0, 2).join(', ')}] ${(s.gloss ?? []).slice(0, 4).join('; ')}`);
    return `${forms.join('・') || reads[0]} 【${reads.join('・')}】\n${ss.join('\n')}`;
  }).join('\n\n');
}

async function getText(admin: SupabaseClient, userId: string, kind: string, id: string): Promise<string> {
  const cap = (s: string) => (s.length > 6000 ? s.slice(0, 6000) + '…' : s);
  if (kind === 'article') {
    const { data } = await admin.from('processed_news').select('title, content').eq('user_id', userId).eq('id', id).maybeSingle();
    if (!data) return 'not found';
    const paras = ((data.content?.blocks ?? []) as any[]).filter((b) => b.type === 'paragraph')
      .map((b, n) => `[段落${n + 1}] ${b.text ?? (b.content ?? []).map((t: any) => t.text).join('')}`);
    return cap(`${data.title}\n${paras.join('\n')}`);
  }
  if (kind === 'podcast') {
    const { data } = await admin.from('podcast_episodes').select('title, script').eq('user_id', userId).eq('id', id).maybeSingle();
    if (!data) return 'not found';
    return cap(`${data.title}\n${((data.script?.turns ?? []) as any[]).map((t) => `${t.speaker}: ${t.text}`).join('\n')}`);
  }
  if (kind === 'song') {
    const { data } = await admin.from('songs').select('title, plan').eq('user_id', userId).eq('id', id).maybeSingle();
    if (!data) return 'not found';
    return cap(`${data.title}\n${((data.plan?.sections ?? []) as any[]).map((s) => `[${s.name}]\n${(s.lines ?? []).join('\n')}`).join('\n')}`);
  }
  return 'unknown kind';
}

async function searchHistory(admin: SupabaseClient, userId: string, query: string): Promise<string> {
  const terms = query.split(/[\s,、]+/).map((t) => t.replace(/[%_,()]/g, '')).filter((t) => t.length >= 2).slice(0, 4);
  if (!terms.length) return 'query too short';
  const or = (cols: string[]) => cols.flatMap((c) => terms.map((t) => `${c}.ilike.%${t}%`)).join(',');
  const [arts, digests, threads] = await Promise.all([
    admin.from('processed_news').select('id, title, summary, created_at, status, finished_at')
      .eq('user_id', userId).not('title', 'is', null).or(or(['title', 'summary']))
      .order('created_at', { ascending: false }).limit(8),
    admin.from('learner_digests').select('day, text').eq('user_id', userId).or(or(['text']))
      .order('day', { ascending: false }).limit(5),
    admin.from('tutor_threads').select('day, summary').eq('user_id', userId).or(or(['summary']))
      .order('day', { ascending: false }).limit(5),
  ]);
  const lines = [
    ...(arts.data ?? []).map((a: any) => `article ${String(a.created_at).slice(0, 10)} (id ${a.id}, ${a.finished_at ? 'finished' : a.status}): ${a.title}${a.summary ? ` — ${a.summary}` : ''}`),
    ...(digests.data ?? []).map((d: any) => `day ${d.day}: ${d.text}`),
    ...(threads.data ?? []).map((t: any) => `conversation ${t.day}: ${t.summary}`),
  ];
  return lines.length ? lines.join('\n') : 'nothing found';
}

async function requestPodcast(userId: string, topic: string, angle: unknown, send: (o: unknown) => void): Promise<string> {
  const t = topic.trim().slice(0, 80);
  if (t.length < 2) return 'topic too short';
  const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/generate-podcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` },
    body: JSON.stringify({
      userId, source: { kind: 'topic', topic: t }, minutes: 5,
      ...(typeof angle === 'string' && angle.trim() ? { instructions: angle.trim().slice(0, 300) } : {}),
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) return `couldn't start it: ${data?.error ?? res.status}`;
  send({ type: 'action', action: { type: 'content_queued', kind: 'podcast', topic: t, episodeId: data?.episode?.id } });
  return 'Started. It will appear in 聞く in a few minutes.';
}

// ── Recap ────────────────────────────────────────────────────────────────────

async function endThread(admin: SupabaseClient, userId: string, threadId: string) {
  const [{ data: msgs }, { data: notes }] = await Promise.all([
    admin.from('tutor_messages').select('role, text').eq('thread_id', threadId).in('role', ['user', 'assistant'])
      .not('text', 'is', null).order('created_at'),
    admin.from('learner_notes').select('ref').eq('user_id', userId).eq('kind', 'usage').contains('ref', { threadId }),
  ]);
  const lines = (msgs ?? []) as { role: string; text: string }[];
  const learnerSpoke = lines.some((m) => m.role === 'user');
  const offers = (notes ?? []).map((n: any) => n.ref?.offer).filter(Boolean);
  const used = (notes ?? []).filter((n: any) => n.ref?.correct === true).map((n: any) => String(n.ref.item));

  let recap = { corrections: [] as { said: string; better: string; note: string }[], newWords: offers, usedWords: [...new Set(used)] };
  if (learnerSpoke) {
    const usage = emptyUsage(CLAUDE_HAIKU);
    try {
      const out = await callTool<{ corrections: { said: string; better: string; note: string }[] }>({
        model: CLAUDE_HAIKU, usage, maxTokens: 3000, name: 'write_recap',
        description: 'The corrections worth remembering from this conversation.',
        prompt: `A Japanese learner just finished chatting with their tutor ハルカ. Pick the 2-3 corrections most worth remembering (the tutor's <fix> recasts and explanations show them). For each: what the learner said, the better Japanese, and a short English note on why. If there were none, return an empty list.

${lines.map((m) => `${m.role === 'user' ? 'Learner' : 'ハルカ'}: ${m.text}`).join('\n').slice(-12000)}`,
        schema: {
          type: 'object',
          properties: {
            corrections: {
              type: 'array',
              items: {
                type: 'object',
                properties: { said: { type: 'string' }, better: { type: 'string' }, note: { type: 'string' } },
                required: ['said', 'better', 'note'],
              },
            },
          },
          required: ['corrections'],
        },
      });
      recap = { ...recap, corrections: (out.corrections ?? []).slice(0, 3) };
    } catch (e) {
      console.warn('[tutor-chat] recap failed:', e);
    }
  }
  await admin.from('tutor_threads').update({ ended_at: new Date().toISOString(), recap }).eq('id', threadId).eq('user_id', userId);
  return recap;
}
