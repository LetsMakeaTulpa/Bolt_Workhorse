// Runs the real web-search handler under Node with realistic Exa/Tavily payloads, proving the
// path request → engine → parser → RRF → response (and the new per-engine diagnostics).
// Run: node experiments/web-engine-pipeline.test.mjs

import { execFileSync } from 'node:child_process';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const STUB = `${process.cwd()}/experiments/fixtures/supabase-stub.mjs`;

execFileSync(
  'npx',
  [
    '--yes', 'esbuild', 'supabase/functions/web-search/index.ts',
    '--bundle', '--format=esm', '--outfile=/tmp/web-search-pipeline.mjs',
    '--alias:npm:@supabase/supabase-js@2.45.4=' + STUB, `--external:${STUB}`, '--log-level=error',
  ],
  { stdio: 'inherit' },
);

// ── Deno stand-in ─────────────────────────────────────────────────────────────
let env = {};
globalThis.Deno = {
  env: { get: (name) => env[name] },
  serve: () => {},
};

const { handleRequest } = await import('/tmp/web-search-pipeline.mjs');

// ── fixture upstreams, shaped like the real APIs ──────────────────────────────
const EXA_PAYLOAD = {
  requestId: 'req-1',
  results: [
    {
      id: 'exa-1',
      title: 'Graph Neural Networks: A Review of Methods and Applications',
      url: 'https://arxiv.org/abs/1812.08434',
      score: 0.94,
      text: 'Graph neural networks (GNNs) have been widely studied in both academia and industry.',
    },
    {
      id: 'exa-2',
      title: 'A Gentle Introduction to Graph Neural Networks',
      url: 'https://distill.pub/2021/gnn-intro/',
      text: 'A gentle introduction to graph neural networks and message passing.',
    },
  ],
};

const TAVILY_PAYLOAD = {
  query: 'graph neural network survey',
  answer: 'Graph neural networks are deep models over graph-structured data.',
  results: [
    {
      title: 'A Gentle Introduction to Graph Neural Networks',
      url: 'https://distill.pub/2021/gnn-intro/',
      content: 'Neural networks that operate on graph data with message passing.',
      score: 0.88,
    },
    {
      title: 'Graph neural network — Wikipedia',
      url: 'https://en.wikipedia.org/wiki/Graph_neural_network',
      content: 'A graph neural network is a class of artificial neural network for graphs.',
      score: 0.81,
    },
  ],
};

let calls = [];
let exaStatus = 200;

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  calls.push({ url, body: init.body ? JSON.parse(init.body) : null, headers: init.headers ?? {} });
  if (url.includes('api.exa.ai')) {
    if (exaStatus !== 200) return new Response('{"error":"nope"}', { status: exaStatus });
    return new Response(JSON.stringify(EXA_PAYLOAD), { headers: { 'content-type': 'application/json' } });
  }
  if (url.includes('api.tavily.com')) {
    return new Response(JSON.stringify(TAVILY_PAYLOAD), { headers: { 'content-type': 'application/json' } });
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

// ── 1. both engines configured: results, attribution, dedupe ──────────────────
env = { EXA_API_KEY: 'exa-test', TAVILY_API_KEY: 'tavily-test' };
const resp = await search({ query: 'graph neural network survey', engines: ['exa', 'tavily'] });
const body = await resp.json();

check('handler answers 200', resp.status === 200, String(resp.status));
check('both engines ran with results', body.engine_status?.length === 2 && body.engine_status.every((s) => s.status === 'ok' && s.results > 0), JSON.stringify(body.engine_status));
check('results come back fused', body.total_results > 0 && body.results.length === body.total_results, `${body.total_results} results`);

const distill = body.results.filter((r) => r.url.includes('distill.pub'));
check('the URL both engines returned appears once', distill.length === 1, `${distill.length} entries`);
check('the shared source credits both engines', distill[0] && /exa/.test(distill[0].source_engine) && /tavily/.test(distill[0].source_engine), distill[0]?.source_engine);

const urls = body.results.map((r) => r.url);
check('no duplicate URLs in the response', new Set(urls).size === urls.length);
check('every result has a title, URL and snippet', body.results.every((r) => r.title && /^https?:\/\//.test(r.url) && r.snippet), '');
check('citation ids are assigned in order', body.results.every((r, i) => r.citation_id === `[${i + 1}]`));

// request shape: the engines are actually asked the question
const exaCall = calls.find((c) => c.url.includes('api.exa.ai'));
const tavilyCall = calls.find((c) => c.url.includes('api.tavily.com'));
check('exa is asked for text contents', exaCall?.body?.contents?.text?.maxCharacters > 0 && exaCall.body.numResults >= 5, JSON.stringify(exaCall?.body?.numResults));
check('tavily uses advanced depth', tavilyCall?.body?.search_depth === 'advanced' && tavilyCall.body.max_results === 6);
check('secrets never travel in the URL', !calls.some((c) => /api[_-]?key=/i.test(c.url)), '');

// ── 2. one engine without its secret ─────────────────────────────────────────
env = { TAVILY_API_KEY: 'tavily-test' };
const partial = await (await search({ query: 'graph neural network survey', engines: ['exa', 'tavily'] })).json();
const exaReport = partial.engine_status.find((s) => s.engine === 'exa');
check('a missing secret is reported, not hidden', exaReport?.status === 'missing_key' && /EXA_API_KEY/.test(exaReport.detail), JSON.stringify(exaReport));
check('the configured engine still answers', partial.engine_status.find((s) => s.engine === 'tavily')?.status === 'ok' && partial.total_results > 0);
check('the report names no secret values', !JSON.stringify(partial.engine_status).includes('tavily-test'));

// ── 3. the upstream rejects the key ──────────────────────────────────────────
env = { EXA_API_KEY: 'exa-expired', TAVILY_API_KEY: 'tavily-test' };
exaStatus = 401;
const rejected = await (await search({ query: 'graph neural network survey', engines: ['exa', 'tavily'] })).json();
const rejectedReport = rejected.engine_status.find((s) => s.engine === 'exa');
check('a rejected key surfaces its HTTP status', rejectedReport?.status === 'error' && /401/.test(rejectedReport.detail), JSON.stringify(rejectedReport));
check('one failing engine does not empty the response', rejected.total_results > 0);

// ── 4. an unknown engine name is not silently dropped ───────────────────────
const unknown = await (await search({ query: 'graph neural network survey', engines: ['nope'] })).json();
check('an unknown engine is reported', unknown.engine_status?.[0]?.status === 'unknown_engine', JSON.stringify(unknown.engine_status?.[0]));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) process.exit(1);
