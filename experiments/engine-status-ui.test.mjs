// Proves the status strip's logic: which engine reports become chips, how they are worded,
// and that lane runs do not pile up duplicates.
// Run: node experiments/engine-status-ui.test.mjs

import { asUrl, tmpPath, ESBUILD } from './lib/build.mjs';
import { execFileSync } from 'node:child_process';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const MODULE = tmpPath('fieldwork-engines.mjs');
execFileSync(
  process.execPath,
  [ESBUILD, 'src/lib/engines.ts', '--bundle', '--format=esm', `--outfile=${MODULE}`, '--log-level=error'],
  { stdio: 'inherit' },
);

const { engineIssueLabel, mergeEngineIssues, summarizeEngineStatus } = await import(`${asUrl(MODULE)}?t=${Date.now()}`);

// ── wording ──────────────────────────────────────────────────────────────────
check('missing_key reads as a setup problem', engineIssueLabel('missing_key') === 'missing key');
check('error reads as a failure', engineIssueLabel('error') === 'failed');
check('unknown_engine reads as not available', engineIssueLabel('unknown_engine') === 'not available');
check('empty reads as no results', engineIssueLabel('empty') === 'no results');
check('an unrecognised status passes through instead of vanishing', engineIssueLabel('throttled') === 'throttled');

// ── summarising a function response ──────────────────────────────────────────
check('no engine_status (old deployment) yields no chips', summarizeEngineStatus(undefined).length === 0);
check('an empty array yields no chips', summarizeEngineStatus([]).length === 0);

const issues = summarizeEngineStatus([
  { engine: 'exa', status: 'ok', results: 8 },
  { engine: 'tavily', status: 'missing_key', results: 0, detail: 'TAVILY_API_KEY is not set' },
  { engine: 'google', status: 'error', results: 0, detail: 'google http 403' },
  { engine: 'ahmia', status: 'empty', results: 0 },
  { engine: 'searxng', status: 'unknown_engine', results: 0, detail: 'no engine registered under this name' },
]);

check('working engines are not reported', !issues.some((issue) => issue.engine === 'exa'), JSON.stringify(issues.map((i) => i.engine)));
check('every non-ok engine is reported', issues.length === 4);

const tavily = issues.find((issue) => issue.engine === 'tavily');
check('a missing key is a warning', tavily?.severity === 'warning');
check('the missing-key chip says which var', tavily?.detail === 'TAVILY_API_KEY is not set', tavily?.detail);
check('the chip uses the catalogue label', issues.find((i) => i.engine === 'ahmia')?.name === 'Ahmia (onion index)');

const google = issues.find((issue) => issue.engine === 'google');
check('an upstream failure keeps its HTTP status as detail', google?.detail === 'google http 403' && google.label === 'failed');

const ahmia = issues.find((issue) => issue.engine === 'ahmia');
check('an empty result is information, not a warning', ahmia?.severity === 'info' && ahmia.label === 'no results');
check('an empty chip summarises the count', ahmia?.detail === '0 results', ahmia?.detail);

check('an unknown engine id falls back to the raw id for its name', (() => {
  const [only] = summarizeEngineStatus([{ engine: 'some-new-engine', status: 'missing_key', results: 0 }]);
  return only?.name === 'some-new-engine' && only.severity === 'warning';
})());

check('order follows the function response', issues.map((i) => i.engine).join(',') === 'tavily,google,ahmia,searxng');

// ── lane runs: several queries, one chip per reason ──────────────────────────
const first = summarizeEngineStatus([{ engine: 'exa', status: 'error', results: 0, detail: 'exa http 429' }]);
const merged = mergeEngineIssues(first, summarizeEngineStatus([{ engine: 'exa', status: 'error', results: 0, detail: 'exa http 429' }]));
check('repeating the same failure does not duplicate the chip', merged.length === 1, `${merged.length} chips`);

const both = mergeEngineIssues(first, summarizeEngineStatus([{ engine: 'exa', status: 'empty', results: 0 }]));
check('a different reason for the same engine is kept', both.length === 2 && both[1].status === 'empty');

const newEngine = mergeEngineIssues(first, summarizeEngineStatus([{ engine: 'tavily', status: 'missing_key', results: 0 }]));
check('a new engine is appended', newEngine.length === 2 && newEngine[1].engine === 'tavily');

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) process.exit(1);
