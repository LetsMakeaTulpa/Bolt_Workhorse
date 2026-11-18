/**
 * Who is searching, and how much of somebody else's bill they may run up.
 *
 * `web-search` is deployed with `verify_jwt = false`, so the public anon key reaches it. One call
 * fans a query out across every selected engine — spending the deployment's provider keys and their
 * rate limits — and then pays a model to compile the queries before any of that. Without a counter
 * in front of it, a script with the key from the browser bundle can drain all of it.
 *
 * The mechanism is deliberately the same one the llm-proxy uses: the `consume_rate_limit` SQL
 * function from `20261115150000_add_request_rate_limits.sql`, one atomic insert-or-increment per
 * window, so two concurrent searches cannot both read "one left". Buckets are SHA-256 hashes built
 * here, so no raw address or user id is ever stored.
 *
 * Two deliberate differences from the proxy:
 *
 * 1. A namespace prefix. The proxy's buckets are `user:<hash>` / `anonymous:<hash>`; these are
 *    `web-search:user:<hash>`. Sharing the row would make one search eat an inference budget, and
 *    the two limits are not meant to trade against each other.
 * 2. The numbers are looser per minute and tighter per day. A search is bursty — the composer runs
 *    several lanes at once — but it is also the expensive call, so the day budget, not the minute
 *    window, is what a script actually runs into.
 *
 * Dependency-free on purpose: the Deno function and the Node suite import this file verbatim.
 */

export interface LimitPair {
  perMinute: number;
  perDay: number;
}

export interface Caller {
  kind: 'user' | 'anonymous';
  /** auth user id, or the client IP text (hashed before it reaches the database) */
  id: string;
}

/** Keeps these counters out of the llm-proxy's rows in the same table. */
export const BUCKET_NAMESPACE = 'web-search';

/**
 * Budgets, in whole requests — not in "a search". The composer's dork path sends one request per
 * expanded query, two in flight, up to ten per batch, so the minute window has to fit a batch or
 * two with room to retry. The day window is what an actual loop runs into.
 *
 * A signed-in person researching can search all day at 600; an unauthenticated caller is demo
 * traffic on a public key and gets 100 a day, enough for a real session and nowhere near enough
 * to sit on the owner's engine quotas.
 */
export const LIMITS: Record<Caller['kind'], LimitPair> = {
  user: { perMinute: 60, perDay: 600 },
  anonymous: { perMinute: 20, perDay: 100 },
};

/** Cloudflare sets one header; Supabase forwards the chain. First hop is the client. */
export function clientIp(headers: Headers): string {
  const direct = headers.get('cf-connecting-ip');
  if (direct && direct.trim()) return direct.trim();

  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }

  const real = headers.get('x-real-ip');
  if (real && real.trim()) return real.trim();

  // Everything unknown shares one bucket, so the limit still holds.
  return 'unknown';
}

/** Hash the identity so raw IPs and user ids are never stored in the counter table. */
export async function bucketKey(caller: Caller): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(caller.id));
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${BUCKET_NAMESPACE}:${caller.kind}:${hex.slice(0, 32)}`;
}

export function retryAfterSeconds(resetAt: string | Date | null | undefined, now = Date.now()): number {
  if (!resetAt) return 60;
  const when = resetAt instanceof Date ? resetAt.getTime() : Date.parse(resetAt);
  if (!Number.isFinite(when)) return 60;
  return Math.max(1, Math.ceil((when - now) / 1000));
}

export const RATE_LIMITED_MARKER = 'rate_limited';

export function rateLimitedMessage(caller: Caller, retryAfter: number): string {
  const wait = retryAfter <= 90 ? `${retryAfter}s` : `${Math.ceil(retryAfter / 60)} min`;
  return caller.kind === 'user'
    ? `Search rate limit reached for this account — try again in ${wait}.`
    : `Unauthenticated search limit reached for this network (${LIMITS.anonymous.perMinute}/min). Sign in, or try again in ${wait}.`;
}

export const WINDOWS: { scope: string; seconds: number; limit: (limits: LimitPair) => number }[] = [
  { scope: 'minute', seconds: 60, limit: (l) => l.perMinute },
  { scope: 'day', seconds: 86_400, limit: (l) => l.perDay },
];

/**
 * The one method this module needs from a Supabase client. Narrow on purpose: a caller cannot
 * accidentally hand it the service-role client's whole surface, and a test can hand it a counter
 * that refuses on request.
 */
export interface RateLimitStore {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: { message: string } | null }>;
}

export type Verdict =
  | { ok: true }
  | { ok: false; scope: string; limit: number; used: number; resetAt: string };

/**
 * Spend one search in every window before any engine is contacted. The first refusal stops the
 * loop, so a caller over the minute budget does not also consume a day slot.
 *
 * If the counter itself is unavailable the search is allowed and logged loudly — a database blip
 * must not take the product down — but that is an availability trade, not a silent bypass.
 */
export async function checkLimits(store: RateLimitStore, caller: Caller): Promise<Verdict> {
  const limits = LIMITS[caller.kind];
  const bucket = await bucketKey(caller);

  for (const window of WINDOWS) {
    const limit = window.limit(limits);
    const { data, error } = await store.rpc('consume_rate_limit', {
      p_bucket: `${bucket}:${window.scope}`,
      p_window_seconds: window.seconds,
      p_limit: limit,
    });

    if (error) {
      console.error('search rate limit check failed, allowing search', error.message);
      return { ok: true };
    }

    const row = (Array.isArray(data) ? data[0] : data) as
      | { allowed?: boolean; used?: number; reset_at?: string }
      | undefined;
    if (!row) return { ok: true };
    if (!row.allowed) {
      return {
        ok: false,
        scope: window.scope,
        limit,
        used: row.used ?? limit,
        resetAt: row.reset_at ?? '',
      };
    }
  }

  return { ok: true };
}
