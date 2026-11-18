// The anon key is public, and web-search is deployed with `verify_jwt = false`: before this gate a
// script holding the key from the browser bundle could fan one request across every paid engine
// and spend a model call compiling the queries, with nothing counting any of it. This suite drives
// the real handler against the supabase stub to prove three things:
//
//   1. a caller over budget is refused before the body is read, so nothing is spent;
//   2. the compiler's model call is bounded (one attempt, a token cap, an abort, a query cap) and
//      reported in the response so the trail can name it;
//   3. a refusal says which budget ran out, and a broken counter does not take search down.
//
// Run: node experiments/websearch-limits.test.mjs (or npm run smoke)
import { asUrl, bundle, tmpPath } from './lib/build.mjs';
import * as stub from './fixtures/supabase-stub.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const STUB = `${process.cwd()}/experiments/fixtures/supabase-stub.mjs`.replaceAll('\\', '/');
const OUT = tmpPath('web-search-limits.mjs');

// The module reads its Supabase configuration at import, so it has to exist before the import:
// the counters are enabled here exactly as they are in the deployed function.
let env = {
  SUPABASE_URL: 'https://stub.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
  // the real default is 12s; a suite cannot wait for it to prove the abort works
  SEARCH_COMPILER_TIMEOUT_MS: '60',
};
globalThis.Deno = { env: { get: (name) => env[name] }, serve: () => {} };

bundle('supabase/functions/web-search/index.ts', OUT, [
  '--alias:npm:@supabase/supabase-js@2.45.4=' + STUB,
]);

const { handleRequest } = await import(asUrl(OUT));

// ── upstream stub: the compiler, and engines that should never be reached ────
let calls = [];
let compiler = { mode: 'ok', content: '', usage: 123 };

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  calls.push({ url, body: init.body ? JSON.parse(init.body) : null });

  if (url.includes('api.featherless.ai')) {
    if (compiler.mode === 'hang') {
      // honours the abort the handler attaches, the way a real slow provider would
      return new Promise((_, reject) => {
        const stop = () => reject(new DOMException('aborted', 'AbortError'));
        if (init.signal?.aborted) stop();
        else init.signal?.addEventListener('abort', stop);
      });
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: compiler.content } }],
        usage: { total_tokens: compiler.usage },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  }

  // engines are not expected to answer well in this suite; the counts are what matter
  return new Response('{}', { status: 404 });
};

const search = (body = {}, headers = {}) =>
  handleRequest(
    new Request('https://stub.supabase.co/functions/v1/web-search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        query: 'byzantine grain supply',
        engines: ['duckduckgo'],
        maxResultsPerEngine: 2,
        ...body,
      }),
    }),
  );

// ── 1. over budget: refused before the body, no engine, no model ─────────────
stub.reset({ quota: { minute: 0 } });
calls = [];
const refused = await search();
const refusal = await refused.json();

check('an over-budget caller is refused with 429', refused.status === 429, String(refused.status));
check(
  'the refusal names the marker, the budget and the wait',
  refusal.error === 'rate_limited' && refusal.scope === 'minute' && refusal.limit === 20 && refusal.retry_after > 0,
  JSON.stringify(refusal),
);
check('Retry-After is readable by the client', Number(refused.headers.get('retry-after')) > 0, refused.headers.get('retry-after'));
check('no engine and no model were contacted', calls.length === 0, calls.map((c) => c.url).join(', '));

// ── 2. signed-in and anonymous callers are told apart ────────────────────────
stub.reset({ quota: { minute: 0 } });
const anonRefusal = await (await search()).json();
stub.reset({ quota: { minute: 0 } });
const userRefusal = await (await search({}, { authorization: 'Bearer user-token' })).json();

check('an anonymous refusal says how to get more', /sign in|try again/i.test(anonRefusal.message ?? ''), anonRefusal.message);
check('a signed-in refusal is tiered to the account', userRefusal.tier === 'user' && /account/i.test(userRefusal.message ?? ''), JSON.stringify(userRefusal));

// ── 3. within budget: the compiler runs, is bounded, and reports itself ──────
stub.reset({});
const REWRITTEN = [
  'Here are the queries:',
  '1. byzantine grain supply constantinople',
  '2. Byzantine grain supply Constantinople',
  '- "byzantine bread dole"',
  `3. ${'grain distribution logistics '.repeat(12)}`,
  '4. late roman annona',
  '5. constantinople population estimates',
  '6. sixth century egyptian wheat',
].join('\n');
compiler = { mode: 'ok', content: REWRITTEN, usage: 123 };
calls = [];

const served = await search();
const body = await served.json();
const report = body.compilation ?? {};

check('a caller within budget is served', served.status === 200, String(served.status));
check('the compiler call is reported, not hidden', report.ran === true && report.reason === 'ok', JSON.stringify(report));
check('the report names the model that ran', report.model === 'Qwen/Qwen2.5-7B-Instruct', report.model);
check('the report carries what it cost', report.tokens === 123 && report.duration_ms >= 0, JSON.stringify(report));
check(
  'the reported queries are the ones actually searched',
  JSON.stringify(body.queries_used) === JSON.stringify(report.queries),
  JSON.stringify(body.queries_used),
);
check(
  'list markers and the preamble never reach an engine',
  report.queries.every((q) => !/^(\d+[.)]|[-*])\s/.test(q) && !/^here are/i.test(q)),
  JSON.stringify(report.queries),
);
check(
  'a duplicate query is dropped',
  new Set(report.queries.map((q) => q.toLowerCase())).size === report.queries.length,
  JSON.stringify(report.queries),
);
check('a chatty model cannot fan out past the cap', report.queries.length <= 5, String(report.queries.length));
check('every query is bounded in length', report.queries.every((q) => q.length <= 160), String(Math.max(...report.queries.map((q) => q.length))));

const compilerCall = calls.find((c) => c.url.includes('api.featherless.ai'));
check('the model call carries a token cap', compilerCall?.body?.max_tokens <= 220, String(compilerCall?.body?.max_tokens));
check(
  'the reported model is the one the provider was asked for',
  compilerCall?.body?.model === report.model,
  String(compilerCall?.body?.model),
);

// ── 4. a slow compiler is abandoned, and the search still answers ────────────
stub.reset({});
compiler = { mode: 'hang', content: '', usage: 0 };
calls = [];
const slowStarted = Date.now();
const slow = await search();
const slowReport = (await slow.json()).compilation ?? {};

check('a slow compiler is abandoned instead of holding the search', slowReport.reason === 'timeout', JSON.stringify(slowReport));
check('the search still runs on the question as typed', slowReport.queries?.[0] === 'byzantine grain supply', JSON.stringify(slowReport.queries));
check('the abandoned call returns promptly', Date.now() - slowStarted < 5_000, `${Date.now() - slowStarted} ms`);

// ── 5. no key, or compilation turned off: nothing is spent, and it says so ───
stub.reset({ config: { featherless_api_key: '', default_model: 'stub/model' } });
compiler = { mode: 'ok', content: 'never reached', usage: 0 };
calls = [];
const keyless = await (await search()).json();

check('without a key the compiler does not run', keyless.compilation?.ran === false && keyless.compilation.reason === 'no_key', JSON.stringify(keyless.compilation));
check('and no model call was made', !calls.some((c) => c.url.includes('featherless.ai')), String(calls.length));

stub.reset({});
compiler = { mode: 'ok', content: 'never reached', usage: 0 };
calls = [];
const direct = await (await search({ compileQueries: false })).json();

check('a caller that turns compilation off gets a disabled report', direct.compilation?.reason === 'disabled' && direct.compilation.ran === false, JSON.stringify(direct.compilation));
check('and still pays for no model call', !calls.some((c) => c.url.includes('featherless.ai')), String(calls.length));

// ── 6. the counter module itself: namespaced, hashed, and fail-open ──────────
const LIMIT_OUT = tmpPath('web-search-rate-limit.mjs');
bundle('supabase/functions/web-search/rateLimit.ts', LIMIT_OUT);
const { bucketKey, checkLimits } = await import(asUrl(LIMIT_OUT));

const bucket = await bucketKey({ kind: 'user', id: 'user-1' });
check('search buckets are namespaced away from the proxy counters', bucket.startsWith('web-search:user:'), bucket);
check('the identity itself is not stored', !bucket.includes('user-1'), bucket);

const refusing = {
  rpc: async () => ({ data: [{ allowed: false, used: 61, reset_at: new Date(Date.now() + 2_000).toISOString() }], error: null }),
};
const verdict = await checkLimits(refusing, { kind: 'user', id: 'user-1' });
check('a refusal names the window it came from', verdict.ok === false && verdict.scope === 'minute', JSON.stringify(verdict));

const broken = { rpc: async () => ({ data: null, error: { message: 'function does not exist' } }) };
const quiet = console.error;
console.error = () => {};
const failOpen = await checkLimits(broken, { kind: 'anonymous', id: '203.0.113.9' });
console.error = quiet;
check('a broken counter does not take search down', failOpen.ok === true, JSON.stringify(failOpen));

// ── summary ────────────────────────────────────────────────────────────────
const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed) process.exitCode = 1;
