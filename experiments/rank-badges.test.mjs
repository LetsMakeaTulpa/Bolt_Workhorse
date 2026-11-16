// The badges tell the user why a source sits where it sits, so they must agree with the multipliers
// fusion actually applied — including the case where the date played no part at all.
import { tmpPath, ESBUILD } from './lib/build.mjs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// the local esbuild entry point under node directly: `npx` cannot be spawned from cmd.exe
const DIR = (process.env.BADGES_DIR ?? tmpPath('')).replaceAll('\\', '/');
const OUT = `${DIR}/fieldwork-rank-explain.mjs`;
const FUSION = `${DIR}/fieldwork-rank-fusion.mjs`;
const build = (entry, out) =>
  execFileSync(process.execPath, [ESBUILD, entry, '--bundle', '--format=esm', `--outfile=${out}`, '--log-level=error'], {
    stdio: 'inherit',
  });
build('src/lib/rankExplain.ts', OUT);
build('src/lib/fusion.ts', FUSION);

const { summaryForQuery, freshnessBonus, recencyBadge, intentBadge, rankSources } = await import(
  `${pathToFileURL(OUT).href}?t=${Date.now()}`
);
const { engineWeights, queryIntent } = await import(`${pathToFileURL(FUSION).href}?t=${Date.now()}`);

const NOW = Date.UTC(2026, 10, 15);
const daysAgo = (days) => new Date(NOW - days * 86_400_000).toISOString().slice(0, 10);

let passed = 0;
const failures = [];
const check = (name, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

// 1. the label says what the ranking did
check('a news query reads as recency-seeking', summaryForQuery('latest AI regulation news 2026', NOW).label === 'recency-seeking');
check('a conceptual query reads as conceptual', summaryForQuery('why do graph neural networks overfit on small graphs', NOW).label === 'conceptual');
check('a history query reads as timeless', summaryForQuery('history of the roman republic', NOW).label === 'timeless');
check('an identifier query reads as exact match', summaryForQuery('CVE-2024-3094 exploitation', NOW).label === 'exact match');
check('an ordinary query reads as mixed', summaryForQuery('postgres index bloat', NOW).label === 'mixed');

// 2. the multiplier matches the ranking rule (1 + 0.6 × recencyWeight)
const fresh = queryIntent('latest AI regulation news 2026', NOW);
check('a three-day-old result earns the full boost', Math.abs(freshnessBonus(daysAgo(3), fresh, NOW) - 1.6) < 1e-9, String(freshnessBonus(daysAgo(3), fresh, NOW)));
check('a year-old result earns a small boost', Math.abs(freshnessBonus(daysAgo(365), fresh, NOW) - 1.21) < 1e-9, String(freshnessBonus(daysAgo(365), fresh, NOW)));
check('a five-year-old result is barely lifted', freshnessBonus(daysAgo(1900), fresh, NOW) < 1.08, String(freshnessBonus(daysAgo(1900), fresh, NOW)));

// 3. no date, no story to tell
check('an undated result is neutral', freshnessBonus(undefined, fresh, NOW) === 1);
check('an unparseable date is neutral', freshnessBonus('not-a-date', fresh, NOW) === 1);

// 4. a timeless query never claims a freshness boost, even on a fresh source
const timeless = queryIntent('history of the roman republic', NOW);
check('a timeless query ignores the date', freshnessBonus(daysAgo(1), timeless, NOW) === 1);

// 5. navigational queries damp books, so recency must stay neutral too
const exact = queryIntent('CVE-2024-3094 exploitation', NOW);
check('an exact-match query ignores the date', freshnessBonus(daysAgo(1), exact, NOW) === 1);

// 6. the recency badge: same multiplier as the score, and an honest tier
const freshBadge = recencyBadge(daysAgo(3), fresh, NOW);
check('a three-day-old result is a fresh badge', freshBadge.tier === 'fresh', freshBadge.tier);
check('the badge multiplier is the score multiplier', Math.abs(freshBadge.multiplier - freshnessBonus(daysAgo(3), fresh, NOW)) < 1e-9);
check('the badge carries the date it used', freshBadge.published === daysAgo(3));
check('the badge detail names the boost', /freshness ×1\.60/.test(freshBadge.detail), freshBadge.detail);
check('a half-year-old result is a recent badge', recencyBadge(daysAgo(120), fresh, NOW).tier === 'recent');
check('a year-old result is an aging badge', recencyBadge(daysAgo(400), fresh, NOW).tier === 'aging');
check('an old result is an old badge with a small boost', recencyBadge(daysAgo(1900), fresh, NOW).tier === 'old' && recencyBadge(daysAgo(1900), fresh, NOW).multiplier < 1.08);
check('undated is its own state', recencyBadge(undefined, fresh, NOW).tier === 'undated');
check('an unparseable date is undated', recencyBadge('nope', fresh, NOW).tier === 'undated');
check('undated explains itself', /No publication date/.test(recencyBadge(undefined, fresh, NOW).detail));

const ignoredBadge = recencyBadge(daysAgo(1), timeless, NOW);
check('a timeless query marks the date ignored', ignoredBadge.tier === 'ignored' && ignoredBadge.multiplier === 1, ignoredBadge.tier);
check('the ignored badge says why', /not recency-seeking/.test(ignoredBadge.detail), ignoredBadge.detail);
check('an exact-match query ignores the date too', recencyBadge(daysAgo(1), exact, NOW).tier === 'ignored');

// 7. the intent badge: engine trust against its own base weight
const SEMANTIC = 'why do graph neural networks overfit on small graphs';
// expected deltas come from the intent vector, not from hardcoded numbers: the badge must agree with
// whatever the intent model says, not with today's coefficients
const semIntent = queryIntent(SEMANTIC, NOW);
const exaSemantic = intentBadge('exa', SEMANTIC, NOW);
check('semantic intent raises Exa by the intent weight', Math.abs(exaSemantic.delta - 0.45 * semIntent.semantic) < 1e-9, JSON.stringify(exaSemantic));
check('the intent badge names the class', exaSemantic.intent === 'conceptual');
check('the weight matches the ranking', Math.abs(exaSemantic.weight - engineWeights(SEMANTIC, NOW)['exa']) < 1e-9);
check('the base weight is the unrouted one', exaSemantic.base === engineWeights('', NOW, { character: false })['exa']);
check(
  'the detail states both weights',
  exaSemantic.detail.includes(`×${exaSemantic.weight.toFixed(2)} against a flat base of ×${exaSemantic.base.toFixed(2)}`),
  exaSemantic.detail,
);
check('the delta is the difference the user sees', Math.abs(exaSemantic.delta - (exaSemantic.weight - exaSemantic.base)) < 1e-9);

const tavilySemantic = intentBadge('tavily', SEMANTIC, NOW);
// Tavily's semantic nudge was removed: the ablation sweep scored it at zero
check('semantic intent leaves Tavily at its base weight', Math.abs(tavilySemantic.delta) < 1e-9, JSON.stringify(tavilySemantic));
const navIntent = queryIntent('CVE-2024-3094 xz backdoor exploitation', NOW);
const exaNavigational = intentBadge('exa', 'CVE-2024-3094 xz backdoor exploitation', NOW);
check('exact-match intent damps Exa by the navigational weight', Math.abs(exaNavigational.delta + 0.5 * navIntent.navigational) < 1e-9, JSON.stringify(exaNavigational));
const freshIntent = queryIntent('latest AI regulation news 2026', NOW);
const exaFresh = intentBadge('exa', 'latest AI regulation news 2026', NOW);
check('recency-seeking intent damps Exa', Math.abs(exaFresh.delta + 0.2 * freshIntent.fresh) < 1e-9 && exaFresh.intent === 'recency-seeking', JSON.stringify(exaFresh));
const tavilyFresh = intentBadge('tavily', 'latest AI regulation news 2026', NOW);
check('recency-seeking intent raises Tavily', Math.abs(tavilyFresh.delta - 0.45 * freshIntent.fresh) < 1e-9, JSON.stringify(tavilyFresh));
const wikipediaEvergreen = intentBadge('wikipedia', 'history of the roman republic', NOW);
check('timeless intent raises Wikipedia', wikipediaEvergreen.delta > 0 && wikipediaEvergreen.intent === 'timeless', JSON.stringify(wikipediaEvergreen));

// 8. merged engines badge their primary, unknown engines get nothing
check('a merged engine badges its primary', intentBadge('exa+tavily', SEMANTIC, NOW).engine === 'exa');
check('an unknown engine has no badge', intentBadge('nope', 'q', NOW) === null);
check('a missing engine has no badge', intentBadge('', 'q', NOW) === null);

// 9. the panel's order. The rank on a card is only worth showing if it matches the row the reader
// sees, so the sort and the number have to come from one place.
{
  const rows = [
    { id: 'b', relevance_score: 0.011 },
    { id: 'a', relevance_score: 0.041 },
    { id: 'c', relevance_score: 0.041 },
    { id: 'no-score' },
    { id: 'zero', relevance_score: 0 },
  ];
  const rankedRows = rankSources(rows);

  check('sources are ordered by fusion score, highest first', rankedRows.slice(0, 3).map((row) => row.id).join(',') === 'a,c,b', rankedRows.map((row) => row.id).join(','));
  check('equal scores keep the order fusion returned', rankedRows[0].id === 'a' && rankedRows[1].id === 'c', rankedRows.map((row) => row.id).join(','));
  check('ranks count from one down the list', rankedRows.map((row) => row.rank).join(',') === '1,2,3,4,5', rankedRows.map((row) => row.rank).join(','));
  check('a real zero outranks a missing score', rankedRows.find((row) => row.id === 'zero').rank < rankedRows.find((row) => row.id === 'no-score').rank);
  check('a missing score sinks below every scored row', rankedRows[rankedRows.length - 1].id === 'no-score');
  check('sorting leaves the input order alone', rows.map((row) => row.id).join(',') === 'b,a,c,no-score,zero', rows.map((row) => row.id).join(','));
  check('each row keeps its own fields', rankedRows[0].id === 'a' && rankedRows[0].relevance_score === 0.041);
  check('an empty list ranks to nothing', rankSources([]).length === 0);
}

console.log(`\n${passed}/${passed + failures.length} assertions passed`);
if (failures.length > 0) process.exit(1);
