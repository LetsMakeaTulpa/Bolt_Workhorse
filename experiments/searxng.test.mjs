// The searxng adapter is the only general-web engine that needs no paid key, but it is the easiest
// one to get silently wrong: the URL list is comma-separated, instances answer HTML instead of JSON
// unless the instance enables it, and a dead instance must not end the engine. This drives the real
// handler against stubs that behave like those instances.
// Run: node experiments/searxng.test.mjs

import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const STUB = `${process.cwd()}/experiments/fixtures/supabase-stub.mjs`.replaceAll('\\', '/');
// a literal /tmp resolves to C:\tmp on Windows, where nothing was written
const OUT = (process.env.SEARXNG_MODULE ?? join(tmpdir(), 'web-search-searxng.mjs')).replaceAll('\\', '/');
const ESBUILD = `${process.cwd()}/node_modules/esbuild/bin/esbuild`.replaceAll('\\', '/');

// local esbuild under node: spawning `npx` fails through cmd.exe on Windows
execFileSync(
  process.execPath,
  [
    ESBUILD, 'supabase/functions/web-search/index.ts',
    '--bundle', '--format=esm', `--outfile=${OUT}`,
    '--alias:npm:@supabase/supabase-js@2.45.4=' + STUB, '--log-level=error',
  ],
  { stdio: 'inherit' },
);

// ── Deno stand-in ─────────────────────────────────────────────────────────────
let env = {};
globalThis.Deno = { env: { get: (name) => env[name] }, serve: () => {} };

const { handleRequest } = await import(pathToFileURL(OUT).href);

// ── instances that behave like the real ones ──────────────────────────────────
const LONG = 'a'.repeat(500);
const SX_PAYLOAD = {
  query: 'byzantine empire',
  number_of_results: 4,
  results: [
    { title: 'Byzantine Empire', url: 'https://en.wikipedia.org/wiki/Byzantine_Empire', content: 'The Byzantine Empire was the eastern continuation of the Roman Empire.', engine: 'wikipedia' },
    { title: 'Byzantine Empire - World History Encyclopedia', url: 'https://www.worldhistory.org/Byzantine_Empire/', content: 'A survey of Byzantine history from Constantine to 1453.', engine: 'google' },
    { title: 'Byzantine studies', url: 'https://example.test/byzantine-studies', content: LONG, engine: 'bing' },
  ],
};

let calls = [];
let mode = { dead: 403, live: 'json', last: 'json' };

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  calls.push({ url, headers: init.headers ?? {} });
  if (url.startsWith('http://dead.test/')) {
    // JSON disabled: a real instance answers 403 (or an HTML page) rather than results
    return new Response('<html>format not allowed</html>', { status: mode.dead });
  }
  if (url.startsWith('http://last.test/')) {
    return mode.last === 'json'
      ? new Response(JSON.stringify(SX_PAYLOAD), { headers: { 'content-type': 'application/json' } })
      : new Response('<html>no json</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  }
  if (url.startsWith('http://sx.test/')) {
    return new Response(JSON.stringify(SX_PAYLOAD), { headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 404 });
};

const search = (body) =>
  handleRequest(
    new Request('https://stub.supabase.co/functions/v1/web-search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ compileQueries: false, maxResultsPerEngine: 6, ...body }),
    }),
  );

// ── 1. a dead instance, then a live one, from one comma-separated value ───────
env = { SEARXNG_URL: 'http://dead.test, http://sx.test/ ' };
calls = [];
const first = await search({ query: 'byzantine empire', engines: ['searxng'], maxResultsPerEngine: 3 });
const body = await first.json();

check('handler answers 200', first.status === 200, String(first.status));
check('the live instance is used after the dead one', body.total_results > 0, `${body.total_results} results`);
check('the dead instance was tried first', calls[0]?.url.startsWith('http://dead.test/'), calls[0]?.url);
check('the second instance was asked next', calls.some((c) => c.url.startsWith('http://sx.test/')), calls.map((c) => c.url).join(' '));
check('results are attributed to searxng', body.results.every((r) => r.source_engine === 'searxng'), body.results.map((r) => r.source_engine).join(','));
check('titles, URLs and snippets survive', body.results.every((r) => r.title && /^https?:\/\//.test(r.url) && r.snippet));
check('the per-engine cap is respected', body.results.length <= 3, `${body.results.length} results`);
check('a long snippet is truncated', body.results.every((r) => r.snippet.length <= 300), `${Math.max(...body.results.map((r) => r.snippet.length))} chars`);

const asked = calls.filter((c) => c.url.startsWith('http://sx.test/'));
check('the instance is asked for JSON', asked.every((c) => /[?&]format=json(&|$)/.test(c.url)), asked[0]?.url);
check('the instance is asked without safesearch', asked.every((c) => /[?&]safesearch=0(&|$)/.test(c.url)), asked[0]?.url);
check('the query is URL-encoded', asked.every((c) => c.url.includes('byzantine%20empire')), asked[0]?.url);
check('a browser-ish user agent is sent', asked.every((c) => Boolean((c.headers ?? {})['User-Agent'] ?? (c.headers ?? {}).get?.('User-Agent'))), JSON.stringify(asked[0]?.headers));

// ── 2. no instance configured: reported, not hidden ─────────────────────────
env = {};
const missing = await (await search({ query: 'byzantine empire', engines: ['searxng'] })).json();
const missingReport = missing.engine_status?.find((s) => s.engine === 'searxng');
check('an unconfigured instance is reported', missingReport?.status === 'missing_key', JSON.stringify(missingReport));
check('the report names SEARXNG_URL', /SEARXNG_URL/.test(missingReport?.detail ?? ''), missingReport?.detail);

// ── 3. every instance answers HTML: empty, but not an exception ─────────────
env = { SEARXNG_URL: 'http://dead.test,http://last.test' };
mode = { dead: 403, live: 'html', last: 'html' };
const allHtml = await search({ query: 'byzantine empire', engines: ['searxng'] });
const htmlBody = await allHtml.json();
check('HTML instances do not throw', allHtml.status === 200, String(allHtml.status));
check('HTML instances yield no results', htmlBody.total_results === 0, `${htmlBody.total_results} results`);
check('the empty report still names the engine', htmlBody.engine_status?.[0]?.engine === 'searxng', JSON.stringify(htmlBody.engine_status?.[0]));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) {
  console.log(failed.map((r) => `  ✗ ${r.name}`).join('\n'));
  process.exit(1);
}
