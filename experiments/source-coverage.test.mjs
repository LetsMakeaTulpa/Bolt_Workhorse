// The sentence at the top of the Sources tab, and the filter under it. The failure this guards
// against is a confident summary: a list saved before the prompt verdict existed must read as
// unknown, never as "nothing reached the model", and every count must match the chips in the rows.
// Run: node experiments/source-coverage.test.mjs (standalone; smoke also bundles the modules)
import { bundle } from './lib/build.mjs';
import { mkdirSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const asUrl = (path) => (path.startsWith('file:') ? path : pathToFileURL(path).href);
const moduleUrl = (path) => asUrl(isAbsolute(path) ? path : `${process.cwd()}/${path}`.replaceAll('\\', '/'));

const OUT = process.env.SOURCE_COVERAGE_MODULE ?? 'node_modules/.cache/fieldwork/source-coverage.mjs';
const PANEL = process.env.PANEL_MODULE ?? 'node_modules/.cache/fieldwork/investigation-panel.mjs';
if (!process.env.SOURCE_COVERAGE_MODULE) {
  mkdirSync('node_modules/.cache/fieldwork', { recursive: true });
  bundle('src/lib/sourceCoverage.ts', OUT);
}
if (!process.env.PANEL_MODULE) {
  mkdirSync('node_modules/.cache/fieldwork', { recursive: true });
  bundle('src/components/InvestigationPanel.tsx', PANEL, [
    '--jsx=automatic',
    '--external:react',
    '--external:react-dom',
  ]);
}

const { coverageCount, coverageSentence, matchesCoverageFilter, summarizeCoverage } = await import(moduleUrl(OUT));

const React = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { InvestigationPanel } = await import(moduleUrl(process.env.PANEL_MODULE ?? PANEL));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const row = (prompt) => ({ prompt });

// 1. the counts, one row per verdict the card can show
{
  const summary = summarizeCoverage([
    row({ inPrompt: true, reason: 'given' }),
    row({ inPrompt: true, reason: 'trimmed' }),
    row({ inPrompt: false, reason: 'capped' }),
    row({ inPrompt: false, reason: 'no-prompt' }),
    row({ inPrompt: false, reason: null }),
    row(undefined),
  ]);
  check('every row is counted', summary.total === 6, String(summary.total));
  check('carried rows are reached', summary.reached === 2, String(summary.reached));
  check('recorded omissions are withheld', summary.withheld === 3, String(summary.withheld));
  check('unrecorded rows are neither', summary.unrecorded === 1, String(summary.unrecorded));
  check('only a trimmed row counts as cut text', summary.trimmed === 1, String(summary.trimmed));
  check('only a capped row counts as over the cap', summary.capped === 1, String(summary.capped));
  check('only a no-prompt row counts as such', summary.noPrompt === 1, String(summary.noPrompt));
  check('the reach plus the rest is the total', summary.reached + summary.withheld + summary.unrecorded === summary.total);
  check('the causes do not sum to the whole withheld count on their own', summary.capped + summary.noPrompt === 2 && summary.withheld === 3);
}

// 2. a list saved before the verdict reads as unknown, not as "nothing got through"
{
  const summary = summarizeCoverage([row(undefined), row(undefined), row(undefined)]);
  const sentence = coverageSentence(summary);
  check('no verdict is said to be unknown', /unknown how many reached the model/.test(sentence), sentence);
  check('no verdict is not reported as zero reached', !/none of the/i.test(sentence), sentence);
  check('the unknown row count is named', /these 3 results/.test(sentence), sentence);
}

// 3. a half-recorded list names the unknown part instead of dropping it
{
  const sentence = coverageSentence(
    summarizeCoverage([row({ inPrompt: true, reason: 'given' }), row({ inPrompt: false, reason: 'capped' }), row(undefined), row(undefined)]),
  );
  check('a partial record counts what reached', /^1 of 4 results reached the model/.test(sentence), sentence);
  check('a partial record names the overflow', /1 over the cap/.test(sentence), sentence);
  check('a partial record names the unrecorded rows', /2 with no recorded verdict/.test(sentence), sentence);
}

// 4. the all-in case does not invent exclusions
{
  const sentence = coverageSentence(summarizeCoverage([row({ inPrompt: true, reason: 'given' }), row({ inPrompt: true, reason: 'given' })]));
  check('all reached is said plainly', sentence === 'All 2 results reached the model.', sentence);
  const trimmed = coverageSentence(
    summarizeCoverage([row({ inPrompt: true, reason: 'given' }), row({ inPrompt: true, reason: 'trimmed' })]),
  );
  check('all reached still admits cut text', trimmed === 'All 2 results reached the model · 1 had page text cut at the cap.', trimmed);
}

// 5. the none-reached case, when the record actually says so
{
  const sentence = coverageSentence(
    summarizeCoverage([row({ inPrompt: false, reason: 'capped' }), row({ inPrompt: false, reason: 'capped' })]),
  );
  check('none reached is said only with a full record', sentence === 'None of the 2 results reached the model · 2 over the cap.', sentence);
  const noPrompt = coverageSentence(summarizeCoverage([row({ inPrompt: false, reason: 'no-prompt' })]));
  check('a promptless turn says so', /from a turn with no prompt/.test(noPrompt), noPrompt);
  check('a single left-out row reads as singular', /^The only result did not reach the model/.test(noPrompt), noPrompt);
}

// 6. one row, and none at all
{
  check('a single carried row reads as singular', coverageSentence(summarizeCoverage([row({ inPrompt: true, reason: 'given' })])) === 'The only result reached the model.');
  check('an empty list has no sentence', coverageSentence(summarizeCoverage([])) === '');
  check('an empty list counts zero', coverageCount(summarizeCoverage([]), 'all') === 0);
}

// 7. the filter counts and matches the same rows the sentence counts
{
  const summary = summarizeCoverage([
    row({ inPrompt: true, reason: 'given' }),
    row({ inPrompt: false, reason: 'capped' }),
    row(undefined),
  ]);
  check('the all filter counts every row', coverageCount(summary, 'all') === 3);
  check('the reached filter counts carried rows', coverageCount(summary, 'reached') === 1);
  check('the left-out filter counts recorded omissions', coverageCount(summary, 'left-out') === 1);
  check('the unrecorded filter counts unmarked rows', coverageCount(summary, 'unrecorded') === 1);

  check('all matches every row', matchesCoverageFilter(row(undefined), 'all') && matchesCoverageFilter(row({ inPrompt: false, reason: 'capped' }), 'all'));
  check('reached matches only carried rows', matchesCoverageFilter(row({ inPrompt: true, reason: 'trimmed' }), 'reached') && !matchesCoverageFilter(row({ inPrompt: false, reason: 'capped' }), 'reached'));
  check('left out matches only recorded omissions', matchesCoverageFilter(row({ inPrompt: false, reason: null }), 'left-out') && !matchesCoverageFilter(row(undefined), 'left-out'));
  check('unrecorded matches only rows with no verdict', matchesCoverageFilter(row(undefined), 'unrecorded') && !matchesCoverageFilter(row({ inPrompt: true, reason: 'given' }), 'unrecorded'));
}

// 8. the panel itself: the sentence and the filter sit above the rows
{
  const searchResults = [
    {
      title: 'Carried page',
      url: 'https://example.org/a',
      snippet: 'Read by the model.',
      source_engine: 'exa',
      citation_id: '[1]',
      relevance_score: 0.03,
    },
    {
      title: 'Trimmed page',
      url: 'https://example.org/b',
      snippet: 'Cut at the cap.',
      source_engine: 'exa',
      citation_id: '[2]',
      relevance_score: 0.02,
    },
    {
      title: 'Overflow page',
      url: 'https://example.org/c',
      snippet: 'Never offered to the model.',
      source_engine: 'tavily',
      citation_id: '[3]',
      relevance_score: 0.01,
    },
  ];
  const promptCoverage = new Map([
    ['https://example.org/a', { inPrompt: true, reason: 'given' }],
    ['https://example.org/b', { inPrompt: true, reason: 'trimmed' }],
    ['https://example.org/c', { inPrompt: false, reason: 'capped' }],
  ]);

  const html = renderToStaticMarkup(
    React.createElement(InvestigationPanel, {
      searchResults,
      promptCoverage,
      isSearching: false,
      findings: [],
      onUpdateFindingStatus: () => {},
      onRetrySearch: () => {},
      activityLogs: [],
      sources: [],
      query: 'coverage test',
      tab: 'sources',
      onTabChange: () => {},
      onCollapse: () => {},
    }),
  );

  check(
    'the panel states how many rows reached the model',
    /2 of 3 results reached the model · 1 had page text cut at the cap · 1 over the cap\./.test(html),
    html.match(/\d+ of \d+ results[^<]*/)?.[0],
  );
  check('the coverage block is above the rows', html.indexOf('Prompt coverage') < html.indexOf('Carried page'));
  check('the filter offers the reached rows', /In prompt/.test(html));
  check('the filter offers the left-out rows', /Left out/.test(html));
  check('the filter does not offer an empty unrecorded bucket', !/Unrecorded/.test(html));
  check('all three rows still render', ['Carried page', 'Trimmed page', 'Overflow page'].every((title) => html.includes(title)));
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  for (const result of failed) console.log(`  failed: ${result.name}`);
  process.exitCode = 1;
}
