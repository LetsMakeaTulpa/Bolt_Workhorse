/**
 * Who is calling, and how much of the owner's credit they may spend.
 *
 * Dependency-free so the Deno function and the Node test can both import it verbatim.
 * The limiter keys on the signed-in account when a real user token is present, and on the
 * client IP otherwise — the anon key is public, so an unauthenticated caller is treated as
 * demo traffic rather than a customer.
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

/** Deliberate: a person researching can go all day; a script burning credits cannot. */
export const LIMITS: Record<Caller['kind'], LimitPair> = {
  user: { perMinute: 30, perDay: 600 },
  anonymous: { perMinute: 4, perDay: 40 },
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
  return `${caller.kind}:${hex.slice(0, 32)}`;
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
    ? `Rate limit reached for this account — try again in ${wait}.`
    : `Unauthenticated limit reached for this network (${LIMITS.anonymous.perMinute}/min). Sign in, or try again in ${wait}.`;
}
