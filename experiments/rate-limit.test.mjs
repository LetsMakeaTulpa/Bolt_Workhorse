// Proves the llm-proxy limiter: identity extraction, hashing, the atomic SQL window counter,
// and that only the service role can touch either the counter table or the function.
// Run: node experiments/rate-limit.test.mjs

import { asUrl, tmpPath, ESBUILD } from './lib/build.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// 1. the helpers the Deno function imports, bundled and run as-is
execFileSync(
  process.execPath,
  [
    ESBUILD, 'supabase/functions/llm-proxy/rateLimit.ts',
    '--bundle', '--format=esm', `--outfile=${tmpPath('rate-limit.mjs')}`, '--log-level=error',
  ],
  { stdio: 'inherit' },
);

const {
  LIMITS, bucketKey, clientIp, retryAfterSeconds, rateLimitedMessage,
} = await import(asUrl(tmpPath('rate-limit.mjs')));

const ipFrom = (entries) => clientIp(new Headers(entries));

check(
  'Cloudflare header wins over the forwarded chain',
  ipFrom({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1, 10.0.0.1' }) === '203.0.113.7',
);
check(
  'first forwarded hop is the client, not the proxy',
  ipFrom({ 'x-forwarded-for': '198.51.100.9, 10.0.0.1, 10.0.0.2' }) === '198.51.100.9',
);
check('x-real-ip is the fallback', ipFrom({ 'x-real-ip': '192.0.2.5' }) === '192.0.2.5');
check('no headers still gets a shared bucket', ipFrom({}) === 'unknown');
check(
  'blank forwarded value falls through instead of becoming an empty key',
  ipFrom({ 'x-forwarded-for': '   ', 'x-real-ip': '192.0.2.9' }) === '192.0.2.9',
);

const keyA = await bucketKey({ kind: 'anonymous', id: '203.0.113.7' });
const keyB = await bucketKey({ kind: 'anonymous', id: '203.0.113.7' });
const keyC = await bucketKey({ kind: 'anonymous', id: '203.0.113.8' });
const userKey = await bucketKey({ kind: 'user', id: '203.0.113.7' });
check('the same caller hashes to the same bucket', keyA === keyB, keyA);
check('different callers get different buckets', keyA !== keyC);
check('the raw address never appears in the bucket', /^anonymous:[0-9a-f]{32}$/.test(keyA) && !keyA.includes('203'), keyA);
check('a user and an IP with the same text do not collide', userKey !== keyA && userKey.startsWith('user:'));

check(
  'anonymous traffic is limited far more tightly than a signed-in account',
  LIMITS.anonymous.perMinute < LIMITS.user.perMinute && LIMITS.anonymous.perDay < LIMITS.user.perDay,
  `anon ${LIMITS.anonymous.perMinute}/min · user ${LIMITS.user.perMinute}/min`,
);

const reset = new Date(Date.now() + 42_000).toISOString();
check('retry-after counts whole seconds upward', retryAfterSeconds(reset) === 42, String(retryAfterSeconds(reset)));
check('a past reset never returns a negative wait', retryAfterSeconds('2000-01-01T00:00:00Z') === 1);
check('a missing reset falls back to a minute', retryAfterSeconds(null) === 60);
check(
  'the anonymous message tells the caller to sign in',
  /sign in/i.test(rateLimitedMessage({ kind: 'anonymous', id: 'x' }, 30)),
);

// 2. the SQL counter, in real Postgres
const MIGRATIONS = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();
const db = new PGlite();
await db.exec(`
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
  GRANT SELECT, REFERENCES ON auth.users TO authenticated, service_role;
`);
for (const file of MIGRATIONS) await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'));

async function asService(fn) {
  await db.exec('SET ROLE service_role');
  try {
    return await fn();
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function rejects(fn) {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

const consume = (bucket, seconds, limit) =>
  db.query('SELECT * FROM public.consume_rate_limit($1, $2, $3)', [bucket, seconds, limit]);

const first = await asService(() => consume('test:minute', 60, 3));
check('first request in a window is allowed', first.rows[0].allowed === true && first.rows[0].used === 1);

await asService(() => consume('test:minute', 60, 3));
const third = await asService(() => consume('test:minute', 60, 3));
check('the last request inside budget still counts down', third.rows[0].allowed === true && third.rows[0].remaining === 0);

const fourth = await asService(() => consume('test:minute', 60, 3));
check('one over budget is refused', fourth.rows[0].allowed === false && fourth.rows[0].used === 4, `used=${fourth.rows[0].used}`);
check('the refusal exposes a reset time in the future', new Date(fourth.rows[0].reset_at) > new Date());

const other = await asService(() => consume('test:other', 60, 3));
check('another bucket is unaffected', other.rows[0].allowed === true && other.rows[0].used === 1);

const zero = await asService(() => consume('test:zero', 60, 0));
check('a zero budget refuses everything', zero.rows[0].allowed === false);

// window rollover: a one-second window must recover on its own
await asService(() => consume('test:rollover', 1, 1));
const blockedNow = await asService(() => consume('test:rollover', 1, 1));
check('a one-second window blocks the second call', blockedNow.rows[0].allowed === false);
await new Promise((resolve) => setTimeout(resolve, 1100));
const afterWindow = await asService(() => consume('test:rollover', 1, 1));
check('the window rolls over without any cleanup job', afterWindow.rows[0].allowed === true);

// 3. only the proxy may touch it
check(
  'anon cannot read the counter table',
  await rejects(async () => {
    await db.exec('SET ROLE anon');
    try {
      await db.query('SELECT * FROM public.request_rate_limits');
    } finally {
      await db.exec('RESET ROLE');
    }
  }),
);
check(
  'a signed-in user cannot read the counter table either',
  await rejects(async () => {
    await db.exec('SET ROLE authenticated');
    try {
      await db.query('SELECT * FROM public.request_rate_limits');
    } finally {
      await db.exec('RESET ROLE');
    }
  }),
);
check(
  'anon cannot execute the counter function',
  await rejects(async () => {
    await db.exec('SET ROLE anon');
    try {
      await db.query('SELECT * FROM public.consume_rate_limit($1,$2,$3)', ['x', 60, 5]);
    } finally {
      await db.exec('RESET ROLE');
    }
  }),
);

// 4. the proxy handler itself: refuses before spending credit, and tiers by identity
const STUB = `${process.cwd()}/experiments/fixtures/supabase-stub.mjs`;
execFileSync(
  process.execPath,
  [
    ESBUILD, 'supabase/functions/llm-proxy/index.ts',
    '--bundle', '--format=esm', `--outfile=${tmpPath('llm-proxy.mjs')}`,
    // bundled, not external: an external Windows path becomes the URL scheme `c:` at run time,
    // and the stub publishes its state on globalThis so both copies share it anyway
    '--alias:npm:@supabase/supabase-js@2.45.4=' + STUB, '--log-level=error',
  ],
  { stdio: 'inherit' },
);

globalThis.Deno = {
  env: { get: (name) => (name === 'SUPABASE_URL' ? 'https://stub.supabase.co' : 'service-key') },
  serve: () => {},
};

const stub = await import(asUrl(STUB));
const { handleRequest } = await import(asUrl(tmpPath('llm-proxy.mjs')));

let featherlessCalls = 0;
globalThis.fetch = async () => {
  featherlessCalls += 1;
  return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
};

const chatRequest = (headers = {}) =>
  new Request('https://stub.supabase.co/functions/v1/llm-proxy/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });

stub.reset({ quota: { minute: 1 } });
const anonHeaders = { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' };
const allowed = await handleRequest(chatRequest(anonHeaders));
const refused = await handleRequest(chatRequest(anonHeaders));
const refusedBody = await refused.json();

check('the first anonymous request is forwarded', allowed.status === 200 && featherlessCalls === 1, `status=${allowed.status}`);
check('the request over budget is refused with 429', refused.status === 429, `status=${refused.status}`);
check('the refusal body is machine-readable', refusedBody.error === 'rate_limited' && typeof refusedBody.message === 'string', refusedBody.message);
check('the refusal carries a retry-after header', Number(refused.headers.get('Retry-After')) > 0, refused.headers.get('Retry-After'));
check('no credit is spent on a refused request', featherlessCalls === 1, `featherless calls=${featherlessCalls}`);
check('the refusal names the anonymous tier', refusedBody.tier === 'anonymous');
check('the anonymous bucket is keyed by the first forwarded hop', stubGlobalRpcKeys().every((k) => k.startsWith('anonymous:')) && stubGlobalRpcKeys().every((k) => !k.includes('198.51.100.7')));
check('CORS survives the refusal', refused.headers.get('Access-Control-Allow-Origin') === '*');

function stubGlobalRpcKeys() {
  return globalThis.__supabaseStub.rpcCalls.map((call) => call.args.p_bucket);
}

stub.reset({ quota: { minute: 2 } });
featherlessCalls = 0;
const userHeaders = { Authorization: 'Bearer user-token', 'x-forwarded-for': '198.51.100.7' };
const userFirst = await handleRequest(chatRequest(userHeaders));
const userSecond = await handleRequest(chatRequest(userHeaders));
check(
  'a verified session is not throttled by the anonymous budget',
  userFirst.status === 200 && userSecond.status === 200 && featherlessCalls === 2,
  `${userFirst.status},${userSecond.status}`,
);
check('a verified session is keyed by account, not IP', stubGlobalRpcKeys().every((k) => k.startsWith('user:')));

stub.reset();
const anonKeyRequest = await handleRequest(chatRequest({ Authorization: 'Bearer some-anon-key' }));
check('an invalid token falls back to the anonymous tier', anonKeyRequest.status === 200);
check('the bucket hash hides the raw ip', !stubGlobalRpcKeys()[0].includes('198.51.100.7'), stubGlobalRpcKeys()[0]);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) process.exit(1);
