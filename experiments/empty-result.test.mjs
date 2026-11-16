// An empty search must end in its gaps, not in prose. These assertions pin the shape of that
// terminal message: what it names, in what order, and what it must never contain.
// Run: node experiments/empty-result.test.mjs

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const OUT = (process.env.EMPTY_MODULE ?? '/tmp/fieldwork-empty-result.mjs').replaceAll('\\', '/');
const ESBUILD = `${process.cwd()}/node_modules/esbuild/bin/esbuild`.replaceAll('\\', '/');
execFileSync(
  process.execPath,
  [ESBUILD, 'src/lib/emptyResult.ts', '--bundle', '--format=esm', `--outfile=${OUT}`, '--log-level=error'],
  { stdio: 'inherit' },
);

const { buildGapReport } = await import(`${pathToFileURL(OUT).href}?t=${Date.now()}`);

const bullets = (body) => body.split('\n').filter((line) => line.startsWith('- ')).map((line) => line.slice(2));

// 1. nothing known: the report still names what was searched and refuses to answer
const bare = buildGapReport({ query: '  quarterly revenue guidance  ', engines: ['exa', 'tavily'] });
check('it states that no sources came back', bare.body.startsWith('**No sources.**'), bare.body.split('\n')[0]);
check('it repeats the query, trimmed', bare.body.includes('“quarterly revenue guidance”'));
check('it names the engines that ran', bare.body.includes('A search for “quarterly revenue guidance” across Exa, Tavily'), bare.body.split('\n')[0]);
check('the default gap names every engine', bare.gaps.length === 1 && bare.gaps[0].includes('Exa, Tavily'), JSON.stringify(bare.gaps));
check('it refuses to answer', /No answer is given because nothing collected here supports one/.test(bare.body));
check('the body ends on the refusal', bare.body.trimEnd().endsWith('then ask again.'));
check('no follow-up section', !/FOLLOW-UPS/i.test(bare.body));
check('no claim ledger', !/CLAIM LEDGER/i.test(bare.body));
check('no citation markers', !/\[\d+\]/.test(bare.body));
check('the gaps are exactly the bullets', JSON.stringify(bullets(bare.body)) === JSON.stringify(bare.gaps));

// 2. a provider failure is the most useful thing to say, and it comes first
const withFailure = buildGapReport({
  query: 'xz backdoor',
  engines: ['exa'],
  issues: [
    { engine: 'exa', name: 'Exa', status: 'missing_key', label: 'missing key', detail: 'EXA_API_KEY is not set', severity: 'warning' },
  ],
  laneYield: [
    { lane: 'exa', engine: 'exa', returned: 0, kept: 0, offTopic: 0 },
    { lane: 'tavily', engine: 'tavily', returned: 0, kept: 0, offTopic: 0 },
    { lane: 'brave', engine: 'brave', returned: 3, kept: 0, offTopic: 3 },
  ],
});
check('a missing key is named with its reason', withFailure.gaps[0] === 'Exa — missing key (EXA_API_KEY is not set)', withFailure.gaps[0]);
check('a dead lane is named as returning nothing', withFailure.gaps.includes('Tavily answered with nothing'));
check('a lane the gate emptied is named with counts', withFailure.gaps.includes('Brave returned 3 results and the relevance gate kept none of them'));
check('order is failure, then dead, then wasted', withFailure.gaps[0].startsWith('Exa —') && withFailure.gaps[1] === 'Tavily answered with nothing' && withFailure.gaps[2].startsWith('Brave'), JSON.stringify(withFailure.gaps));
check('a failed engine is not also called dead', !withFailure.gaps.some((gap) => gap === 'Exa answered with nothing'), JSON.stringify(withFailure.gaps));

// 3. an engine that answered "empty" is already in the dead-lane line; the info issue adds nothing
const infoOnly = buildGapReport({
  query: 'q',
  engines: ['hn'],
  issues: [{ engine: 'hn', name: 'Hacker News', status: 'empty', label: 'no results', detail: '', severity: 'info' }],
  laneYield: [{ lane: 'hn', engine: 'hn', returned: 0, kept: 0, offTopic: 0 }],
});
check('an info issue is not repeated as a failure', infoOnly.gaps.length === 1 && infoOnly.gaps[0] === 'Hacker News answered with nothing', JSON.stringify(infoOnly.gaps));

// 4. counts read correctly at one and many, and a lane run says so
const lane = buildGapReport({
  query: 'cve-2025-1234',
  engines: ['exa'],
  queries: 5,
  laneYield: [
    { lane: 'exa·q0', engine: 'exa', returned: 1, kept: 0, offTopic: 1 },
    { lane: 'exa·q1', engine: 'exa', returned: 1, kept: 0, offTopic: 1 },
  ],
});
check('a lane run reports its query count', lane.body.includes('5 dork queries for “cve-2025-1234” across Exa'), lane.body.split('\n')[0]);
check('a single result is singular', lane.gaps.every((gap) => gap.includes('returned 1 result ')), JSON.stringify(lane.gaps));
check('per-query lanes do not repeat the same gap', lane.gaps.length === 1, JSON.stringify(lane.gaps));

// 5. no engine selected at all is a different cause, and says so
const noEngines = buildGapReport({ query: 'anything', engines: [] });
check('no selected engine is named as the cause', noEngines.gaps[0] === 'no engine was selected, so nothing was actually searched', noEngines.gaps[0]);
check('and no engine list is claimed', noEngines.body.includes('A search for “anything” finished'), noEngines.body.split('\n')[0]);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) process.exit(1);
