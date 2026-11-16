// The Sources panel when a search collected nothing: it must explain the run and offer a next move,
// never be a blank pane. Dates and scores are irrelevant here; the gaps and the query are the input.
// Run: node experiments/no-sources-card.test.mjs (standalone; smoke also bundles the module)
import { bundle } from './lib/build.mjs';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const asUrl = (path) => (path.startsWith('file:') ? path : pathToFileURL(path).href);

const out = process.env.NO_SOURCES_MODULE ?? 'node_modules/.cache/fieldwork/no-sources-card.mjs';
if (!process.env.NO_SOURCES_MODULE) {
  mkdirSync('node_modules/.cache/fieldwork', { recursive: true });
  // colon, not `=`: esbuild rejects `--external=x` for repeatable flags
  bundle('src/components/NoSourcesCard.tsx', out, ['--jsx=automatic', '--external:react', '--external:react-dom']);
}

const React = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { NoSourcesCard } = await import(asUrl(process.env.NO_SOURCES_MODULE ? out : `${process.cwd()}/${out}`.replaceAll('\\', '/')));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const render = (props) => renderToStaticMarkup(React.createElement(NoSourcesCard, props));
const calls = [];
const retry = (query) => calls.push(query);
const buttons = (html) => (html.match(/<button[\s\S]*?<\/button>/g) ?? []);

// 1. nothing has run yet: the passive hint stays, and it offers nothing to press
{
  const html = render({});
  check('no query keeps the standing hint', /No sources retrieved yet/.test(html) && /Send a question with search enabled/.test(html));
  check('no query offers no action', buttons(html).length === 0);
}

// 2. a run that found nothing: heading, query and every gap line are shown
{
  const gaps = ['Exa — missing key (EXA_API_KEY is not set)', 'Tavily answered with nothing'];
  const html = render({ query: 'graph neural network survey', gaps, onRetrySearch: retry });
  check('an empty run says nothing usable was found', /No usable sources this run/.test(html));
  check('the query is repeated back', html.includes('for “graph neural network survey”'));
  check('every gap is listed', gaps.every((gap) => html.includes(gap)), gaps.find((gap) => !html.includes(gap)) ?? 'all present');
  check('the gaps read as a list', /<ul[\s\S]*<li/.test(html) && (html.match(/<li/g) ?? []).length === 2);
}

// 3. both next steps exist, and the wider one is the broadened query, not the original
{
  calls.length = 0;
  const html = render({ query: 'site:example.org "exact phrase"', gaps: ['x'], onRetrySearch: retry });
  check('two actions are offered', buttons(html).length === 2, String(buttons(html).length));
  check('the wider action quotes the broadened query', html.includes('Search wider: “exact phrase”') && !html.includes('site:example.org&quot; &quot;exact'), html.match(/Search wider: “[^”]*”/)?.[0]);
  check('the wider action explains what was removed', /operators and the most specific words removed/.test(html));
  check('the retry action offers the same query', /Run “site:example.org &quot;exact phrase&quot;” again/.test(html), html.match(/title="Run [^"]*"/)?.[0]);
}

// 4. without a handler both actions are present but disabled, not silently missing
{
  const html = render({ query: 'q', gaps: [] });
  check('no handler still renders the actions', buttons(html).length === 2);
  check('no handler disables them', (html.match(/disabled=""/g) ?? []).length === 2, String((html.match(/disabled=""/g) ?? []).length));
  check('a gap-free run still renders a heading', /No usable sources this run/.test(html) && !/<ul/.test(html));
}

// 5. a long query is truncated visually, not in the tooltip, and quotes stay escaped
{
  const long = 'a'.repeat(160);
  const html = render({ query: long, gaps: ['g'], onRetrySearch: retry });
  check('the long query is clipped by CSS', /truncate/.test(html) && html.includes(`title="${long}"`));
  const quoted = render({ query: 'the "RRF" paper', gaps: ['g'], onRetrySearch: retry });
  check('a quoted query is escaped in the label', quoted.includes('&quot;RRF&quot;') && !quoted.includes('"RRF" paper</p>'));
}

const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) process.exit(1);
