// `--compare` is what turns the harness into an A/B for a weight change, so it has to be faithful:
// the named modes must reproduce the default pair exactly, identical configurations must score
// identically, and a malformed spec must fail loudly rather than quietly scoring nothing.
// Run: node experiments/ranking-compare.test.mjs

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TMP_ROOT } from './lib/build.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// one fresh folder per run inside the build cache, removed when the run ends: a suite that leaves
// its scratch folders behind makes the next person wonder which of them still matter
const WORK = mkdtempSync(join(TMP_ROOT, 'compare-'));
process.on('exit', () => {
  try {
    rmSync(WORK, { recursive: true, force: true });
  } catch {
    // a locked file on Windows is not worth failing a green run over
  }
});
const MODULE = join(WORK, 'fusion.mjs');

const run = (args) =>
  spawnSync(process.execPath, ['experiments/ranking-harness.mjs', ...args], {
    encoding: 'utf8',
    env: { ...process.env, RANKING_MODULE: MODULE },
    shell: false,
  });

/**
 * Pull the JSON block the harness prints after its tables. `--check` appends its verdict to stdout
 * after the block, so the slice has to stop at the last closing brace rather than run to the end.
 */
function parseJson(stdout) {
  const start = stdout.indexOf('{\n  "queries"');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
}

const base = run(['--json']);
check('the default run prints results', base.status === 0, base.stderr?.slice(0, 400));
const defaultReport = parseJson(base.stdout ?? '');
check('the default run is JSON-parseable', Boolean(defaultReport), (base.stdout ?? '').slice(-200));

// 1. the example spec names the same pair as the default, so it must score identically
const example = run(['--compare', 'experiments/fixtures/weight-experiment.example.json', '--json']);
check('the shipped example spec runs', example.status === 0, example.stderr?.slice(0, 400));
const exampleReport = parseJson(example.stdout ?? '');
const sameScores =
  Boolean(exampleReport) &&
  exampleReport.queries.every((row, index) => {
    const original = defaultReport.queries[index];
    return (
      row.id === original.id &&
      Math.abs(row.before.ndcg - original.before.ndcg) < 1e-9 &&
      Math.abs(row.after.ndcg - original.after.ndcg) < 1e-9
    );
  });
check('"flat" and "intent" reproduce the default weighting exactly', sameScores, JSON.stringify(exampleReport?.queries?.[0]));

// 2. identical before and after must show no movement at all — the control for the harness itself
const identicalPath = join(WORK, 'identical.json');
writeFileSync(
  identicalPath,
  JSON.stringify({
    before: { label: 'old', weights: 'flat', recency: false },
    after: { label: 'same', weights: 'flat', recency: false },
  }),
);
const identical = run(['--compare', identicalPath, '--json', '--check']);
check('an unchanged configuration passes --check', identical.status === 0, identical.stderr?.slice(0, 300));
const identicalReport = parseJson(identical.stdout ?? '');
check(
  'an unchanged configuration moves nothing',
  Boolean(identicalReport) && identicalReport.queries.every((row) => Math.abs(row.after.ndcg - row.before.ndcg) < 1e-9),
  JSON.stringify(identicalReport?.queries?.[0]),
);
check('and the report says so', /improved on 0\//.test(identical.stdout ?? ''), (identical.stdout ?? '').slice(-300));

// 3. an explicit weights map is honoured: damping every engine equally removes the intent routing,
// so the gains the intent weights bought must disappear
const explicitPath = join(WORK, 'explicit.json');
writeFileSync(
  explicitPath,
  JSON.stringify({
    before: { label: 'current', weights: 'intent' },
    after: { label: 'all engines damped', weights: { exa: 0.2, tavily: 0.2, duckduckgo: 0.2, brave: 0.2, google: 0.2, wikipedia: 0.2, stackexchange: 0.2, github: 0.2, arxiv: 0.2, openalex: 0.2, crossref: 0.2, hn: 0.2, europepmc: 0.2 } },
  }),
);
const explicit = run(['--compare', explicitPath, '--json']);
const explicitReport = parseJson(explicit.stdout ?? '');
check('an explicit weights map runs', explicit.status === 0, explicit.stderr?.slice(0, 300));
check(
  'the map reaches fusion, so it changes scores',
  Boolean(explicitReport) && explicitReport.queries.some((row) => Math.abs(row.after.ndcg - row.before.ndcg) > 1e-9),
  JSON.stringify(explicitReport?.queries?.[0]),
);
check(
  'damping every engine removes the intent gains',
  Boolean(explicitReport) && explicitReport.overall.after.ndcg < explicitReport.overall.before.ndcg,
  JSON.stringify(explicitReport?.overall),
);

// 4. the margin gate: the same order with a narrower lead must fail --check, because a lesser
// result closing in on the best one is the leading edge of the next reorder
const marginFixture = join(WORK, 'margin-queries.json');
writeFileSync(
  marginFixture,
  JSON.stringify({
    evaluated_at: '2026-11-15T00:00:00Z',
    queries: [
      {
        id: 'lead',
        class: 'control',
        query: 'alpha beta gamma',
        lists: {
          google: [{ t: 'alpha beta gamma primary', u: 'https://wide.example/one', s: 'The answer', r: 2 }],
          hn: [{ t: 'gamma alpha beta worked example with tables', u: 'https://narrow.example/two', s: 'A related note', r: 1 }],
        },
      },
    ],
  }),
);
const spec = (afterHn) => {
  const path = join(WORK, `lead-${afterHn}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      before: { label: 'wide lead', weights: { google: 1.2, hn: 0.85 }, recency: false },
      after: { label: 'narrow lead', weights: { google: 1.2, hn: afterHn }, recency: false },
    }),
  );
  return path;
};

const unchangedLead = run(['--fixture', marginFixture, '--compare', spec(0.85), '--check']);
check('the same lead passes --check', unchangedLead.status === 0, (unchangedLead.stderr ?? '').slice(0, 300));

const narrowedLead = run(['--fixture', marginFixture, '--compare', spec(1.15), '--check']);
check('a narrower lead fails --check', narrowedLead.status === 1, `status=${narrowedLead.status}`);
check('and the failure is about margin', /margin regressed/.test(`${narrowedLead.stdout}${narrowedLead.stderr}`), (narrowedLead.stderr ?? '').slice(0, 300));
check(
  'while the order stayed correct',
  !/nDCG regressed/.test(`${narrowedLead.stdout}${narrowedLead.stderr}`),
  (narrowedLead.stderr ?? '').slice(0, 300),
);

// 5. malformed specs fail loudly
const halfPath = join(WORK, 'half.json');
writeFileSync(halfPath, JSON.stringify({ before: { weights: 'flat' } }));
const half = run(['--compare', halfPath]);
check('a spec with no after side exits 2', half.status === 2, `status=${half.status}`);
check('and says what is missing', /needs a "before" and an "after"/.test(half.stderr ?? ''), half.stderr);

const badModePath = join(WORK, 'badmode.json');
writeFileSync(badModePath, JSON.stringify({ before: { weights: 'nonsense' }, after: { weights: 'intent' } }));
const badMode = run(['--compare', badModePath]);
check('an unknown weights mode exits 2', badMode.status === 2, `status=${badMode.status}`);
check('and names the accepted modes', /flat.*intent/.test(badMode.stderr ?? ''), badMode.stderr);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) process.exit(1);
