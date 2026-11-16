// Fixture tests for the web-search response mappers.
// Run: bash scripts/smoke.sh, which bundles supabase/functions/web-search/parsers.ts and sets
// PARSERS_MODULE to it
import { asUrl, tmpPath, ESBUILD } from './lib/build.mjs';
import assert from 'node:assert/strict';

const modulePath = process.env.PARSERS_MODULE ?? tmpPath('parsers.mjs');
const { mapExaResults, mapGrepHits, mapShodanMatches, mapTavilyResults, stripMarkup } = await import(asUrl(modulePath));

// ─── grep.app ────────────────────────────────────────────────────
const grepPayload = {
  facets: {},
  hits: {
    total: 2,
    hits: [
      {
        repo: { raw: 'facebook/react' },
        path: { raw: 'packages/react/src/ReactHooks.js' },
        branch: { raw: 'main' },
        content: {
          snippet:
            '<table><tr><td><pre><code>export function <mark>useState</mark>(initial) {</code></pre></td></tr></table>',
        },
      },
      {
        repo: { raw: 'microsoft/vscode' },
        path: { raw: 'src/vs/editor/common/model.ts' },
        branch: { raw: 'main' },
        content: { snippet: 'class <mark>Model</mark> &amp; friends' },
      },
      // malformed entry must be skipped, not thrown on
      { repo: { raw: '' }, path: { raw: '' }, content: { snippet: '' } },
    ],
  },
};

const grepResults = mapGrepHits(grepPayload, 5);
assert.equal(grepResults.length, 2, 'skips entries without a repo/path');
assert.equal(grepResults[0].title, 'facebook/react/packages/react/src/ReactHooks.js');
assert.equal(
  grepResults[0].url,
  'https://github.com/facebook/react/blob/main/packages/react/src/ReactHooks.js',
  'links to the file on GitHub',
);
assert.ok(grepResults[0].snippet.includes('useState'), 'markup stripped, code kept');
assert.ok(!grepResults[0].snippet.includes('<'), 'no HTML leaks into the snippet');
assert.equal(grepResults[1].snippet, 'class Model & friends', 'entities decoded');
assert.equal(grepResults[0].source_engine, 'grepapp');

assert.equal(mapGrepHits(grepPayload, 1).length, 1, 'respects maxResults');
assert.deepEqual(mapGrepHits(null, 5), [], 'null payload is safe');
assert.deepEqual(mapGrepHits({ hits: { hits: 'nope' } }, 5), [], 'wrong shape is safe');

// ─── Shodan ──────────────────────────────────────────────────────
const shodanPayload = {
  matches: [
    {
      ip_str: '203.0.113.10',
      port: 9200,
      hostnames: ['es.example.com'],
      org: 'ACME Hosting',
      product: 'Elasticsearch',
      country_name: 'Germany',
      data: 'HTTP/1.1 200 OK\r\nContent-Type: application/json\n{"cluster_name":"prod"}',
    },
    { ip_str: '198.51.100.7', port: 22, hostnames: [], data: 'SSH-2.0-OpenSSH_8.9' },
    { port: 443, hostnames: ['no-ip.example'] }, // no ip_str → skipped
  ],
};

const shodanResults = mapShodanMatches(shodanPayload, 5);
assert.equal(shodanResults.length, 2, 'skips matches without an IP');
assert.equal(shodanResults[0].title, 'es.example.com:9200 (Elasticsearch)');
assert.equal(shodanResults[0].url, 'https://www.shodan.io/host/203.0.113.10');
assert.ok(shodanResults[0].snippet.includes('ACME Hosting'), 'org in snippet');
assert.ok(shodanResults[0].snippet.includes('Germany'), 'country in snippet');
assert.ok(shodanResults[0].snippet.includes('cluster_name'), 'banner included');
assert.ok(!shodanResults[0].snippet.includes('\n'), 'banner whitespace flattened');
assert.equal(shodanResults[1].title, '198.51.100.7:22', 'falls back to IP when no hostname');
assert.equal(shodanResults[1].source_engine, 'shodan');

assert.equal(mapShodanMatches(shodanPayload, 1).length, 1, 'respects maxResults');
assert.deepEqual(mapShodanMatches(null, 5), [], 'null payload is safe');
assert.deepEqual(mapShodanMatches({ matches: {} }, 5), [], 'wrong shape is safe');

// ─── Exa ────────────────────────────────────────────────────────
// Shape of https://api.exa.ai/search (type: 'auto' with contents.text requested)
const exaPayload = {
  results: [
    {
      id: 'exa-1',
      title: 'Graph Neural Networks: A Review of Methods and Applications',
      url: 'https://arxiv.org/abs/1812.08434',
      publishedDate: '2018-12-20T00:00:00.000Z',
      author: 'Jie Zhou',
      score: 0.94,
      text: 'Graph neural networks (GNNs) have been widely studied…\n\n  in both academia and industry.',
    },
    {
      id: 'exa-2',
      title: '',
      url: 'https://distill.pub/2021/gnn-intro/',
      text: 'A gentle introduction to graph neural networks.',
    },
    { id: 'exa-3', title: 'No URL here', text: 'should be skipped' },
    null,
  ],
};

const exaResults = mapExaResults(exaPayload, 5);
assert.equal(exaResults.length, 2, 'skips entries without a URL');
assert.equal(exaResults[0].source_engine, 'exa');
assert.equal(exaResults[0].url, 'https://arxiv.org/abs/1812.08434');
assert.ok(exaResults[0].snippet.includes('widely studied'), 'text becomes the snippet');
assert.ok(!exaResults[0].snippet.includes('\n'), 'newlines flattened');
assert.equal(exaResults[1].title, 'https://distill.pub/2021/gnn-intro/', 'falls back to the URL as title');
assert.equal(exaResults[0].published, '2018-12-20', 'exa publishedDate normalised to a date');
assert.equal(exaResults[1].published, undefined, 'no date when the engine reports none');
assert.equal(
  mapExaResults({ results: [{ url: 'https://x.test/a', publishedDate: 'not-a-date' }] }, 5)[0].published,
  undefined,
  'an unparseable date is dropped rather than guessed',
);
assert.equal(mapExaResults(exaPayload, 1).length, 1, 'respects maxResults');
assert.deepEqual(mapExaResults(null, 5), [], 'null payload is safe');
assert.deepEqual(mapExaResults({ results: 'nope' }, 5), [], 'wrong shape is safe');

// ─── Tavily ─────────────────────────────────────────────────────
// Shape of https://api.tavily.com/search with search_depth: 'advanced'
const tavilyPayload = {
  query: 'graph neural networks',
  answer: 'GNNs are a class of deep learning models…',
  results: [
    {
      title: 'Graph neural network — Wikipedia',
      url: 'https://en.wikipedia.org/wiki/Graph_neural_network',
      content: 'A graph neural network (GNN) is a class of artificial neural networks…',
      score: 0.91,
      raw_content: 'longer page text',
    },
    {
      title: 'A Gentle Introduction to Graph Neural Networks',
      url: 'https://distill.pub/2021/gnn-intro/',
      content: 'Neural networks that operate on graphs.',
      score: 0.88,
    },
    { title: 'missing url', content: 'skipped' },
  ],
};

const tavilyResults = mapTavilyResults(tavilyPayload, 5);
assert.equal(tavilyResults.length, 2, 'skips entries without a URL');
assert.equal(tavilyResults[0].source_engine, 'tavily');
assert.ok(tavilyResults[0].snippet.includes('class of artificial neural networks'), 'content becomes the snippet');
assert.ok(
  !tavilyResults.some((r) => r.snippet.includes('GNNs are a class')),
  'the synthesized answer is not used as a snippet',
);
const datedTavily = mapTavilyResults(
  { results: [{ title: 'Fresh', url: 'https://x.test/f', content: 'c', published_date: '2026-11-12T09:00:00Z' }] },
  5,
);
assert.equal(datedTavily[0].published, '2026-11-12', 'tavily published_date normalised to a date');
assert.equal(tavilyResults[0].published, undefined, 'tavily without a date reports none');
assert.equal(mapTavilyResults(tavilyPayload, 1).length, 1, 'respects maxResults');
assert.deepEqual(mapTavilyResults(null, 5), [], 'null payload is safe');
assert.deepEqual(mapTavilyResults({ results: {} }, 5), [], 'wrong shape is safe');

// ─── both engines through the real fusion layer ──────────────────
// The point of the paid engines is that they survive ranking, de-duplication and attribution,
// so feed their mapped output into fuseResults exactly as the app does.
const { execFileSync } = await import('node:child_process');
const FUSION_MODULE = tmpPath('fieldwork-fusion-test.mjs');
execFileSync(
  process.execPath,
  [ESBUILD, 'src/lib/fusion.ts', '--bundle', '--format=esm', `--outfile=${FUSION_MODULE}`, '--log-level=error'],
  { stdio: 'inherit' },
);
const { fuseResults } = await import(`${asUrl(FUSION_MODULE)}?t=${Date.now()}`);

const fused = fuseResults('graph neural networks', {
  exa: exaResults,
  tavily: tavilyResults,
});
assert.ok(fused.length >= 2, `fusion returns sources (${fused.length})`);

const shared = fused.find((item) => item.url.includes('distill.pub'));
assert.ok(shared, 'the source both engines returned survives fusion');
assert.deepEqual([...(shared.engines ?? [])].sort(), ['exa', 'tavily'], 'agreement is attributed to both engines');

const urls = fused.map((item) => item.url);
assert.equal(new Set(urls).size, urls.length, 'no duplicate URLs after fusion');
assert.equal(
  fused.filter((item) => item.url.includes('distill.pub')).length,
  1,
  'the shared URL is not duplicated as two sources',
);
assert.ok(
  fused.every((item) => typeof item.relevance === 'number' && item.relevance > 0),
  'every fused source carries a relevance score',
);
assert.ok(fused.every((item) => item.snippet && item.snippet.length > 0), 'snippets are preserved');

// an off-topic result must not be ranked into a query about graphs
const offTopic = fuseResults('graph neural networks', {
  exa: [{ title: 'Best pizza in Naples', url: 'https://example.test/pizza', snippet: 'dough and tomatoes', source_engine: 'exa' }],
});
// the gate relaxes instead of returning an empty page: an unrelated result is kept but scored low
// (fusion-intent pins the same contract through fuseResultsDetailed's `relaxed` flag)
assert.equal(offTopic.length, 1, 'a lone off-topic result is kept rather than emptying the page');
assert.ok(offTopic[0].relevance < 0.35, `off-topic relevance stays below the gate (${offTopic[0].relevance})`);

// ─── shared helper ───────────────────────────────────────────────
assert.equal(stripMarkup('<b>a</b> &amp; <i>b</i>'), 'a & b');
assert.equal(stripMarkup(undefined), '');

console.log('parsers: all assertions passed');
