// Proves that fusion treats Exa and Tavily differently by query intent: semantic prose lifts Exa,
// time-sensitive queries lift Tavily, exact identifiers damp Exa, and dated results only gain
// from recency when the query actually asks for freshness.
// Run: node experiments/fusion-intent.test.mjs

import { tmpPath, ESBUILD } from './lib/build.mjs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// forward slashes and a real shell so the bundle also builds when spawned through cmd.exe
const MODULE = (process.env.FUSION_MODULE ?? tmpPath('fieldwork-fusion-intent.mjs')).replaceAll('\\', '/');
const WINDOWS = process.platform === 'win32';
execFileSync(
  process.execPath,
  [ESBUILD, 'src/lib/fusion.ts', '--bundle', '--format=esm', `--outfile=${MODULE}`, '--log-level=error'],
  // no shell: cmd.exe would split the node path at its spaces
  { stdio: 'inherit' },
);

// a file URL, not a bare path: Windows would read `C:/…` as the protocol `c:`
const { deadLanes, describeLaneYield, engineWeights, fuseResults, fuseResultsDetailed, laneContribution, queryIntent, recencyWeight, summarizeLaneYield } = await import(
  `${pathToFileURL(MODULE).href}?t=${Date.now()}`
);

// a fixed clock so freshness maths never depends on the day the suite runs
const NOW = Date.UTC(2026, 10, 15);
const daysAgo = (days) => new Date(NOW - days * 86_400_000).toISOString().slice(0, 10);

// ── intent detection ─────────────────────────────────────────────────────────
const freshIntent = queryIntent('latest AI regulation news 2026', NOW);
check('a recency query registers as fresh', freshIntent.fresh >= 0.7, `fresh=${freshIntent.fresh}`);
check('a recency query is not treated as evergreen', freshIntent.evergreen === 0);

const evergreenIntent = queryIntent('history of the roman republic', NOW);
check('a history query registers as evergreen', evergreenIntent.evergreen === 1);
check('a history query does not register as fresh', evergreenIntent.fresh === 0);

const semanticIntent = queryIntent('why do graph neural networks struggle to generalise to unseen graphs', NOW);
check('prose registers as semantic', semanticIntent.semantic >= 0.7, `semantic=${semanticIntent.semantic}`);
check(
  'comparative prose registers fully semantic',
  queryIntent('how does graph attention compare to message passing in practice', NOW).semantic >= 0.9,
  String(queryIntent('how does graph attention compare to message passing in practice', NOW).semantic),
);

const navigationalIntent = queryIntent('site:example.com "admin login"', NOW);
check('an exact-page query registers as navigational', navigationalIntent.navigational >= 1, `nav=${navigationalIntent.navigational}`);
check('CVE identifiers register as navigational', queryIntent('CVE-2024-3094 exploit', NOW).navigational >= 0.7);
check('a bare domain registers as navigational', queryIntent('tesla.com investor relations', NOW).navigational >= 0.7);
check('a keyword query stays neutral', (() => {
  const intent = queryIntent('postgres index bloat', NOW);
  return intent.fresh === 0 && intent.semantic < 0.4 && intent.navigational < 0.4;
})());

// ── engine character ─────────────────────────────────────────────────────────
const semanticWeights = engineWeights('why do graph neural networks struggle to generalise', NOW);
check('Exa outranks Tavily on a conceptual question', semanticWeights.exa > semanticWeights.tavily, `exa=${semanticWeights.exa.toFixed(2)} tavily=${semanticWeights.tavily.toFixed(2)}`);
check('the semantic boost is a real lift over the baseline', semanticWeights.exa > 1.2, `exa=${semanticWeights.exa.toFixed(2)}`);

const freshWeights = engineWeights('latest AI regulation news', NOW);
check('Tavily outranks Exa on a recency query', freshWeights.tavily > freshWeights.exa, `tavily=${freshWeights.tavily.toFixed(2)} exa=${freshWeights.exa.toFixed(2)}`);
check('Tavily is lifted above its baseline for recency', freshWeights.tavily > 1.1, `tavily=${freshWeights.tavily.toFixed(2)}`);
check('Exa is damped on recency queries', freshWeights.exa < 1.2, `exa=${freshWeights.exa.toFixed(2)}`);
// the crawl-engine freshness lifts were removed: the benchmark scored them at zero
check('freshness does not lift the crawl engines', !(freshWeights.brave > 1.1) && !(freshWeights.google > 1.2), `brave=${freshWeights.brave.toFixed(2)} google=${freshWeights.google.toFixed(2)}`);

const evergreenWeights = engineWeights('history of the roman republic', NOW);
// the evergreen damping was removed: the ablation sweep scored it at zero
check('Tavily stays at its base weight on a timeless question', evergreenWeights.tavily === 1.1, `tavily=${evergreenWeights.tavily.toFixed(2)}`);
check('Exa keeps its edge on a timeless question', evergreenWeights.exa >= evergreenWeights.tavily);

const navWeights = engineWeights('CVE-2024-3094 exploit', NOW);
check('Exa is damped on an exact identifier', navWeights.exa < 1.2, `exa=${navWeights.exa.toFixed(2)}`);
check('keyword engines keep the lead there', navWeights.duckduckgo > navWeights.exa);

const quotedWeights = engineWeights('"reciprocal rank fusion"', NOW);
check('a quoted phrase damps the semantic engine', quotedWeights.exa < 1.2, `exa=${quotedWeights.exa.toFixed(2)}`);

check('weights never fall through the floor', Object.values(navWeights).every((w) => w >= 0.25));

// ── recency weighting ────────────────────────────────────────────────────────
check('a week-old result is fully fresh', recencyWeight(daysAgo(7), 1, NOW) === 1);
check('a year-old result is discounted', Math.abs(recencyWeight(daysAgo(365), 1, NOW) - 0.35) < 0.001);
check('a five-year-old result is heavily discounted', Math.abs(recencyWeight(daysAgo(1825), 1, NOW) - 0.12) < 0.001);
check('undated results get no bonus', recencyWeight(undefined, 1, NOW) === 0);
check('an invalid date gets no bonus', recencyWeight('not-a-date', 1, NOW) === 0);
check('a timeless query ignores dates entirely', recencyWeight(daysAgo(1), 0, NOW) === 0);

// ── ranking: the same pair of results, three different intents ────────────────
const oldExa = {
  title: 'AI regulation news from the archive',
  url: 'https://archive.example.com/ai-rules-2019',
  snippet: 'ai regulation news coverage',
  source_engine: 'exa',
  published: daysAgo(2500),
};
const freshTavily = {
  title: 'Breaking AI regulation news update',
  url: 'https://fresh.example.com/ai-rules-today',
  snippet: 'ai regulation news coverage',
  source_engine: 'tavily',
  published: daysAgo(3),
};

const freshRanked = fuseResults('latest AI regulation news', { exa: [oldExa], tavily: [freshTavily] }, { now: NOW, limit: 10 });
check('fresh query: the recent Tavily result wins', freshRanked[0]?.url === freshTavily.url, freshRanked.map((r) => r.source_engine).join(' > '));
check('fresh query: publication dates survive fusion', freshRanked[0]?.published === daysAgo(3), String(freshRanked[0]?.published));

const evergreenRanked = fuseResults(
  'history of AI regulation',
  {
    exa: [{ ...oldExa, title: 'AI regulation archive history', snippet: 'history of ai regulation' }],
    tavily: [{ ...freshTavily, title: 'AI regulation today history', snippet: 'history of ai regulation' }],
  },
  { now: NOW, limit: 10 },
);
check('timeless query: recency buys no advantage', evergreenRanked[0]?.url === oldExa.url, evergreenRanked.map((r) => r.source_engine).join(' > '));

const semanticRanked = fuseResults(
  'why do graph neural networks generalise poorly',
  {
    exa: [{ title: 'Why graph neural networks generalise poorly', url: 'https://sem.example.com/gnn', snippet: 'graph neural networks generalise', source_engine: 'exa' }],
    tavily: [{ title: 'Message passing limits in practice', url: 'https://crawl.example.com/gnn', snippet: 'graph neural networks generalise', source_engine: 'tavily' }],
  },
  { now: NOW, limit: 10 },
);
check('semantic query: the Exa result leads', semanticRanked[0]?.source_engine === 'exa', semanticRanked.map((r) => r.source_engine).join(' > '));

// recency must never rescue an irrelevant result — but an empty page is worse than a loose one, so
// the result is returned flagged instead of dropped
const irrelevant = fuseResultsDetailed(
  'latest eu ai act enforcement',
  {
    tavily: [
      { title: 'Pizza ovens of Naples', url: 'https://food.example.com/pizza', snippet: 'dough and tomatoes', source_engine: 'tavily', published: daysAgo(1) },
    ],
  },
  { now: NOW, limit: 10 },
);
check('a fresh but irrelevant result is flagged, not silently dropped', irrelevant.results.length === 1 && irrelevant.relaxed === true, `${irrelevant.results.length} kept, relaxed=${irrelevant.relaxed}`);
check('and it is not scored as a confident match', irrelevant.results[0].relevance < 0.1, String(irrelevant.results[0].relevance));

// per-lane yield: an engine that answers with off-topic filler is visible after the gate
const laneDetail = fuseResultsDetailed(
  'latest eu ai act enforcement',
  {
    exa: [
      { title: 'EU AI Act enforcement begins', url: 'https://act.example.com/eu-ai-act', snippet: 'eu ai act enforcement', source_engine: 'exa' },
      { title: 'Pizza ovens of Naples', url: 'https://food.example.com/pizza', snippet: 'dough and tomatoes', source_engine: 'exa' },
    ],
    tavily: [
      { title: 'Dough hydration guide', url: 'https://food.example.com/dough', snippet: 'flour water salt', source_engine: 'tavily' },
    ],
  },
  { now: NOW, limit: 10 },
);
const laneRows = Object.fromEntries(laneDetail.laneYield.map((row) => [row.lane, row]));
check('a lane reports what it returned', laneRows.exa?.returned === 2, JSON.stringify(laneRows.exa));
check('a lane reports what the gate kept', laneRows.exa?.kept === 1, JSON.stringify(laneRows.exa));
check('off-topic yield is returned minus kept', laneRows.exa?.offTopic === 1, JSON.stringify(laneRows.exa));
check(
  'a lane whose results were all off-topic shows a zero yield',
  laneRows.tavily?.returned === 1 && laneRows.tavily?.kept === 0 && laneRows.tavily?.offTopic === 1,
  JSON.stringify(laneRows.tavily),
);
check('the yield arrives alongside the results', laneDetail.results.length === 1, `${laneDetail.results.length} results`);
check('the yield is not attached to the sources', !('lane' in (laneDetail.results[0] ?? {})), JSON.stringify(Object.keys(laneDetail.results[0] ?? {})));

const emptyLane = fuseResultsDetailed(
  'graph neural networks',
  { exa: [], tavily: [{ title: 'Graph neural networks survey', url: 'https://gnn.example.com/s', snippet: 'graph neural networks', source_engine: 'tavily' }] },
  { now: NOW },
);
const emptyRows = Object.fromEntries(emptyLane.laneYield.map((row) => [row.lane, row]));
check('a lane that returned nothing is still listed', emptyRows.exa?.returned === 0 && emptyRows.exa?.kept === 0, JSON.stringify(emptyRows.exa));

const dorkRows = summarizeLaneYield([
  { lane: 'exa·q1', engine: 'exa', returned: 4, kept: 2, offTopic: 2 },
  { lane: 'exa·q2', engine: 'exa', returned: 2, kept: 2, offTopic: 0 },
  { lane: 'tavily', engine: 'tavily', returned: 1, kept: 1, offTopic: 0 },
]);
check(
  'dork lanes sum back to one engine',
  dorkRows.length === 2 && dorkRows[0].engine === 'exa' && dorkRows[0].returned === 6 && dorkRows[0].kept === 4 && dorkRows[0].offTopic === 2,
  JSON.stringify(dorkRows),
);
check('summarising keeps the order lanes appeared in', dorkRows[1].engine === 'tavily');

// dead lanes: an engine that answered with nothing must be named, not silently absent
const split = laneContribution(
  [
    { lane: 'exa', engine: 'exa', returned: 4, kept: 2, offTopic: 2 },
    { lane: 'tavily', engine: 'tavily', returned: 0, kept: 0, offTopic: 0 },
    { lane: 'arxiv', engine: 'arxiv', returned: 3, kept: 3, offTopic: 0 },
    { lane: 'hn', engine: 'hn', returned: 0, kept: 0, offTopic: 0 },
  ],
  ['hn'],
);
check('a dead lane is classified, not dropped', split.dead.length === 1 && split.dead[0].engine === 'tavily', JSON.stringify(split.dead));
check('a lane already reported as failed is not repeated as dead', !split.dead.some((row) => row.engine === 'hn'), JSON.stringify(split.dead));
check('wasted excludes dead and clean lanes', split.wasted.length === 1 && split.wasted[0].engine === 'exa', JSON.stringify(split.wasted));
check(
  'a lane that kept everything appears in neither',
  !split.dead.concat(split.wasted).some((row) => row.engine === 'arxiv'),
  JSON.stringify([...split.dead, ...split.wasted].map((row) => row.engine)),
);
check(
  'a lane that returned only off-topic results is wasted, not dead',
  laneContribution([{ lane: 'exa', engine: 'exa', returned: 2, kept: 0, offTopic: 2 }]).dead.length === 0,
);

// An empty page must not be the outcome of engines that did answer. When no result clears the
// relevance gate, fusion keeps the pool and says the gate was relaxed.
const offTopic = fuseResultsDetailed(
  'postgres index bloat',
  {
    exa: [{ title: 'Roman Republic', url: 'https://en.wikipedia.example/rome', snippet: 'Classical civilisation', source_engine: 'exa' }],
    tavily: [{ title: 'Solar inverter recall', url: 'https://energy.example/recall', snippet: 'Firmware bulletin', source_engine: 'tavily' }],
  },
  { now: NOW },
);
check('engines that answered nothing relevant still produce a list', offTopic.results.length === 2, `results=${offTopic.results.length}`);
check('and the relaxed gate is reported', offTopic.relaxed === true);
check('the relaxed list keeps the engine names', offTopic.results.every((item) => item.source_engine && item.citation_id));

const gated = fuseResultsDetailed(
  'graph neural networks',
  { exa: [{ title: 'Graph neural networks survey', url: 'https://gnn.example.com/s', snippet: 'graph neural networks', source_engine: 'exa' }] },
  { now: NOW },
);
check('a normal run is not marked relaxed', gated.relaxed === false);
check('no candidates is not a relaxed page', fuseResultsDetailed('q', { exa: [] }, { now: NOW }).relaxed === false);

// A gate that only reports counts cannot be judged. It must name the result it threw away, or the
// user has no way to tell an over-eager gate from a correct one.
const mixed = fuseResultsDetailed(
  'graph neural networks',
  {
    exa: [
      { title: 'Graph neural networks survey', url: 'https://gnn.example.com/s', snippet: 'graph neural networks', source_engine: 'exa' },
      { title: 'Roman Republic', url: 'https://rome.example/r', snippet: 'Classical civilisation', source_engine: 'exa' },
    ],
  },
  { now: NOW },
);
const mixedRow = mixed.laneYield.find((row) => row.lane === 'exa');
check('the gate names the result it dropped', mixedRow?.dropped?.[0]?.title === 'Roman Republic', JSON.stringify(mixedRow?.dropped));
check(
  'a dropped entry carries the coverage the gate judged',
  typeof mixedRow?.dropped?.[0]?.rel === 'number' && mixedRow.dropped[0].rel < 0.35,
  String(mixedRow?.dropped?.[0]?.rel),
);
check('the kept result is not listed as dropped', !(mixedRow?.dropped ?? []).some((item) => /survey/i.test(item.title)), JSON.stringify(mixedRow?.dropped));
check('a dropped item still counts towards the off-topic total', mixedRow?.offTopic === (mixedRow?.dropped ?? []).length, `${mixedRow?.offTopic} vs ${mixedRow?.dropped?.length}`);
check(
  'a relaxed gate drops nothing, because it kept everything',
  offTopic.laneYield.every((row) => (row.dropped ?? []).length === 0),
  JSON.stringify(offTopic.laneYield),
);
// The trail outlives the composer strip, so it has to say who wasted what, not only how much.
check(
  'the trail line names the engine that lost results',
  describeLaneYield([{ lane: 'exa', engine: 'exa', returned: 5, kept: 3, offTopic: 2, dropped: [] }]) ===
    'Lane yield: 1 engine lost results to the gate — exa 3/5',
  describeLaneYield([{ lane: 'exa', engine: 'exa', returned: 5, kept: 3, offTopic: 2, dropped: [] }]),
);
check(
  'a clean run says so instead of inventing waste',
  describeLaneYield([{ lane: 'exa', engine: 'exa', returned: 4, kept: 4, offTopic: 0, dropped: [] }]) ===
    'Lane yield: all 4 results across 1 lane survived the gate',
  describeLaneYield([{ lane: 'exa', engine: 'exa', returned: 4, kept: 4, offTopic: 0, dropped: [] }]),
);
check(
  'a relaxed gate is recorded as relaxed, not as a loss',
  /nothing cleared the gate/.test(describeLaneYield([{ lane: 'exa', engine: 'exa', returned: 2, kept: 2, offTopic: 0, dropped: [] }], true)),
);
check(
  'several wasted engines are all named',
  describeLaneYield([
    { lane: 'exa', engine: 'exa', returned: 5, kept: 3, offTopic: 2, dropped: [] },
    { lane: 'tavily', engine: 'tavily', returned: 2, kept: 0, offTopic: 2, dropped: [] },
  ]).includes('exa 3/5, tavily 0/2'),
);
// A thin page has to explain itself later, and the usual explanation is an engine that answered
// with nothing — so the trail names it rather than only counting survivors.
const deadAndAlive = [
  { lane: 'exa', engine: 'exa', returned: 4, kept: 4, offTopic: 0, dropped: [] },
  { lane: 'tavily', engine: 'tavily', returned: 0, kept: 0, offTopic: 0, dropped: [] },
];
check('dead lanes are listed by name', deadLanes(deadAndAlive).join(',') === 'tavily', deadLanes(deadAndAlive).join(','));
check('an engine that produced nothing is not counted as working', deadLanes([{ lane: 'exa', engine: 'exa', returned: 3, kept: 1, offTopic: 2, dropped: [] }]).length === 0);
check(
  'a thin run names the lane that answered with nothing',
  describeLaneYield(deadAndAlive) ===
    'Lane yield: all 4 results across 1 lane survived the gate; 1 lane answered with nothing (tavily)',
  describeLaneYield(deadAndAlive),
);
check(
  'gate waste and a dead lane are reported together',
  describeLaneYield([
    { lane: 'exa', engine: 'exa', returned: 5, kept: 3, offTopic: 2, dropped: [] },
    { lane: 'tavily', engine: 'tavily', returned: 0, kept: 0, offTopic: 0, dropped: [] },
  ]) === 'Lane yield: 1 engine lost results to the gate — exa 3/5; 1 lane answered with nothing (tavily)',
);
check(
  'an empty page says no lane produced anything, naming them all',
  describeLaneYield([
    { lane: 'exa', engine: 'exa', returned: 0, kept: 0, offTopic: 0, dropped: [] },
    { lane: 'tavily', engine: 'tavily', returned: 0, kept: 0, offTopic: 0, dropped: [] },
  ]) === 'Lane yield: no lane produced anything (exa, tavily)',
);
check(
  'a relaxed gate still names the dead lane',
  /kept anyway; 1 lane answered with nothing \(tavily\)/.test(describeLaneYield(deadAndAlive, true)),
  describeLaneYield(deadAndAlive, true),
);
check(
  'summarising keeps the dropped titles from every lane',
  (() => {
    const merged = summarizeLaneYield([
      { lane: 'exa·q1', engine: 'exa', returned: 2, kept: 1, offTopic: 1, dropped: [{ title: 'A', rel: 0.1 }] },
      { lane: 'exa·q2', engine: 'exa', returned: 1, kept: 1, offTopic: 0, dropped: [] },
    ]);
    return merged.length === 1 && merged[0].dropped.length === 1 && merged[0].dropped[0].title === 'A';
  })(),
);

// ── forced recency: the freshness receipt's control ──────────────────────────
// A timeless question gets no recency weighting by default; the control asks for it anyway, so the
// reader's judgement beats the intent classifier without touching how the engines were weighted.
const romanLists = {
  exa: [
    {
      title: 'Roman republic constitution',
      url: 'https://rome.example/old',
      snippet: 'roman republic constitution',
      source_engine: 'exa',
      published: '2010-01-01',
    },
    {
      title: 'Roman republic senate',
      url: 'https://rome.example/new',
      snippet: 'roman republic senate',
      source_engine: 'exa',
      published: '2026-09-01',
    },
  ],
};
const plainOrder = fuseResults('history of the roman republic', romanLists, { now: NOW });
const forcedOrder = fuseResults('history of the roman republic', romanLists, { now: NOW, forceFresh: true });
check('a timeless query ignores dates by default', plainOrder[0].url.endsWith('/old'), plainOrder[0].url);
check('forcing recency lifts the newer page', forcedOrder[0].url.endsWith('/new'), forcedOrder[0].url);
check(
  'forcing recency keeps every source and its engine',
  forcedOrder.length === plainOrder.length && forcedOrder.every((item) => item.source_engine),
  `${forcedOrder.length} vs ${plainOrder.length}`,
);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) process.exit(1);
