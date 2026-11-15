// Proves that fusion treats Exa and Tavily differently by query intent: semantic prose lifts Exa,
// time-sensitive queries lift Tavily, exact identifiers damp Exa, and dated results only gain
// from recency when the query actually asks for freshness.
// Run: node experiments/fusion-intent.test.mjs

import { execFileSync } from 'node:child_process';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const MODULE = '/tmp/fieldwork-fusion-intent.mjs';
execFileSync(
  'npx',
  ['--yes', 'esbuild', 'src/lib/fusion.ts', '--bundle', '--format=esm', `--outfile=${MODULE}`, '--log-level=error'],
  { stdio: 'inherit' },
);

const { engineWeights, fuseResults, queryIntent, recencyWeight } = await import(`${MODULE}?t=${Date.now()}`);

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
check('freshness also lifts the crawl engines', freshWeights.brave > 1.1 || freshWeights.google > 1.2);

const evergreenWeights = engineWeights('history of the roman republic', NOW);
check('Tavily is damped on a timeless question', evergreenWeights.tavily < 1.1, `tavily=${evergreenWeights.tavily.toFixed(2)}`);
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

// recency must never rescue an irrelevant result
const irrelevant = fuseResults(
  'latest eu ai act enforcement',
  {
    tavily: [
      { title: 'Pizza ovens of Naples', url: 'https://food.example.com/pizza', snippet: 'dough and tomatoes', source_engine: 'tavily', published: daysAgo(1) },
    ],
  },
  { now: NOW, limit: 10 },
);
check('a fresh but irrelevant result is still dropped', irrelevant.length === 0, `${irrelevant.length} kept`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) process.exit(1);
