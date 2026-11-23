// The per-lane lists behind a run, and the fingerprint that says two runs saw the same surface.
//
// Fusion collapses rows, so after it runs there is no way back to what each engine offered: the
// agreement matrix and a benchmark of real queries both need the lanes. These checks pin what is
// kept — the engine's own order, canonical urls, dead lanes as empty — and that the fingerprint
// changes when a list changes and not when the lanes merely answer in a different order.
// Run: node experiments/run-record.test.mjs (builds the module itself)
import { asUrl, bundle, tmpPath } from './lib/build.mjs';

const LIB = process.env.RUN_RECORD_MODULE ?? tmpPath('run-record.mjs');
if (!process.env.RUN_RECORD_MODULE) bundle('src/lib/runRecord.ts', LIB);
const { recordLanes, lanesHash } = await import(asUrl(LIB));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const source = (url, title = url) => ({ title, url, snippet: '', source_engine: 'exa' });

// ── 1. what a lane keeps ───────────────────────────────────────────────────
{
  const record = recordLanes(
    {
      exa: [
        source('https://www.example.test/a/?utm_source=newsletter'),
        source('https://example.test/b/'),
        source('https://arxiv.org/abs/2401.00001'),
      ],
      wikipedia: [],
    },
    { query: 'index bloat', kind: 'search', engines: ['exa', 'wikipedia'], queries: ['index bloat', 'postgres index bloat'] },
  );

  const exa = record.lanes.find((lane) => lane.lane === 'exa');
  const wikipedia = record.lanes.find((lane) => lane.lane === 'wikipedia');
  check('a lane keeps its engine’s order', exa.urls[0] === 'example.test/a' && exa.urls[1] === 'example.test/b', JSON.stringify(exa.urls));
  check('tracking parameters do not survive', !exa.urls.some((url) => url.includes('utm_')), JSON.stringify(exa.urls));
  check('the arxiv abs link is stored as the page that was read', exa.urls.includes('arxiv.org/pdf/2401.00001'), JSON.stringify(exa.urls));
  check('an engine that returned nothing is still a lane', wikipedia && wikipedia.urls.length === 0, JSON.stringify(wikipedia));
  check('a plain search lane names the run’s query', exa.query === 'index bloat', String(exa.query));
  check('the compiled queries ride with the run', record.queries.length === 2 && record.queries[1] === 'postgres index bloat');
  check('the lane names its engine', exa.engine === 'exa' && exa.lane === 'exa');
}

// ── 2. a dork batch's lanes carry their own query ──────────────────────────
{
  const record = recordLanes(
    {
      'exa·q0': [source('https://example.test/one')],
      'exa·q1': [],
      'exa·q2': [source('https://example.test/three')],
    },
    { query: 'acme corp', kind: 'dork', engines: ['exa'], queries: ['site:acme.com filetype:pdf', 'inurl:acme.com', 'intitle:acme'] },
  );

  check('a batch lane is split from its engine', record.lanes[0].engine === 'exa', record.lanes[0].engine);
  check('a batch lane keeps its index in the key', record.lanes[0].lane === 'exa·q0');
  check('a batch lane names the query it ran', record.lanes[2].query === 'intitle:acme', String(record.lanes[2].query));
  check('a dead batch lane is kept as empty', record.lanes[1].urls.length === 0);
  check('the kind travels with the record', record.kind === 'dork');
}

// ── 3. the fingerprint ─────────────────────────────────────────────────────
{
  const run = (lanes) => recordLanes(lanes, { query: 'q', kind: 'search', engines: Object.keys(lanes), queries: ['q'] });

  const first = run({
    exa: [source('https://example.test/a'), source('https://example.test/b')],
    hn: [source('https://example.test/c')],
  });
  const sameContentOtherOrder = run({
    hn: [source('https://example.test/c')],
    exa: [source('https://example.test/a'), source('https://example.test/b')],
  });
  const reorderedUrls = run({
    exa: [source('https://example.test/b'), source('https://example.test/a')],
    hn: [source('https://example.test/c')],
  });
  const oneMore = run({
    exa: [source('https://example.test/a'), source('https://example.test/b')],
    hn: [source('https://example.test/c'), source('https://example.test/d')],
  });
  const oneFewerLane = run({
    exa: [source('https://example.test/a'), source('https://example.test/b')],
  });
  const oneDead = run({
    exa: [source('https://example.test/a'), source('https://example.test/b')],
    hn: [source('https://example.test/c')],
    wikipedia: [],
  });

  check('the fingerprint is a fixed-width hex string', /^[0-9a-f]{16}$/.test(first.lanesHash), first.lanesHash);
  check('the same lanes in a different arrival order fingerprint the same', first.lanesHash === sameContentOtherOrder.lanesHash);
  check('a reordered lane is a different surface', first.lanesHash !== reorderedUrls.lanesHash);
  check('one more result is a different surface', first.lanesHash !== oneMore.lanesHash);
  check('a lane that vanished is a different surface', first.lanesHash !== oneFewerLane.lanesHash);
  check('a dead lane is part of the surface', first.lanesHash !== oneDead.lanesHash);
  check('two identical runs fingerprint the same', first.lanesHash === run({
    exa: [source('https://example.test/a'), source('https://example.test/b')],
    hn: [source('https://example.test/c')],
  }).lanesHash);
}

// ── 4. tracking parameters do not make two runs look different ─────────────
{
  const clean = recordLanes({ exa: [source('https://example.test/a')] }, { query: 'q', kind: 'search', engines: ['exa'], queries: ['q'] });
  const tracked = recordLanes(
    { exa: [source('https://www.example.test/a/?utm_campaign=x&ref=hn')] },
    { query: 'q', kind: 'search', engines: ['exa'], queries: ['q'] },
  );
  check('a campaign link and the clean link are the same surface', clean.lanesHash === tracked.lanesHash);
  check('the empty lane list still has a fingerprint', /^[0-9a-f]{16}$/.test(lanesHash([])), lanesHash([]));
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
