// Who is calling an edge function. Every function runs with verify_jwt = false
// (the gateway rejects the project's ES256 user tokens), so each one checks its
// caller here instead. Never trust a userId from the request body unless the
// caller is the service role or the cron: anyone holding the public anon key
// could otherwise act for any user and spend the app's LLM and audio credits.
//
//   service — the service-role key: internal self-calls and fan-outs
//             (ensure-buffer → process-article, import → part 1, ops scripts)
//   cron    — pg_cron, proven by the x-cron-secret header (CRON_SECRET in the
//             functions' secrets, cron_secret in Vault; database/38_cron_secret.sql)
//   user    — a signed-in user, from the access token in Authorization
//
// The anon key alone is none of these. (DEV_ALLOW_ANON relaxes that for local
// development only — see resolveCaller.)

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type Caller =
  | { kind: 'service' }
  | { kind: 'cron' }
  | { kind: 'user'; userId: string };

export const bearerToken = (req: Request) =>
  (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();

/** The legacy service-role JWT, or a newer secret key (probed with an admin-only call). */
export async function isServiceToken(token: string, serviceKey: string): Promise<boolean> {
  if (!token) return false;
  if (token === serviceKey) return true;
  const probe = createClient(Deno.env.get('SUPABASE_URL')!, token, { auth: { persistSession: false } });
  const { error } = await probe.auth.admin.listUsers({ page: 1, perPage: 1 });
  return !error;
}

/** The caller, or null when the request carries no credential this app accepts. */
export async function resolveCaller(req: Request, admin: SupabaseClient, serviceKey: string): Promise<Caller | null> {
  const token = bearerToken(req);
  if (token === serviceKey) return { kind: 'service' };
  // Local development only (`supabase functions serve --env-file`): the app's
  // VITE_DEV_MODE skips sign-in and sends userId 'dev-user'. Never set in production.
  if (Deno.env.get('DEV_ALLOW_ANON') === 'true') return { kind: 'service' };
  const cronSecret = Deno.env.get('CRON_SECRET');
  if (cronSecret && req.headers.get('x-cron-secret') === cronSecret) return { kind: 'cron' };
  if (!token) return null;
  const { data } = await admin.auth.getUser(token);
  if (data?.user) return { kind: 'user', userId: data.user.id };
  return (await isServiceToken(token, serviceKey)) ? { kind: 'service' } : null;
}

/**
 * The user a request acts for: a signed-in user's own id (any body.userId is
 * ignored), or body.userId when the service role or the cron is calling.
 */
export function actingUserId(caller: Caller, bodyUserId: unknown): string | null {
  if (caller.kind === 'user') return caller.userId;
  return typeof bodyUserId === 'string' && bodyUserId ? bodyUserId : null;
}
