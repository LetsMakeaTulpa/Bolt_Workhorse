// The bubble, not the string: an empty search ends in a rendered gap report with its gaps as a
// list and the two ways out as buttons. The string-level suite proves the wording; this proves the
// markup that carries it, including that the buttons appear only where they can act.
// Run: npm run smoke, which bundles both modules inside the project so their external `react`
// resolves to the copy this test renders with.

import { bundle } from './lib/build.mjs';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// smoke passes absolute paths; standalone the bundles live inside the project
const absolute = (file) => (/^(?:[A-Za-z]:|[\\/])/.test(file) ? file : `${process.cwd()}/${file}`);
const load = async (file) => import(`${pathToFileURL(absolute(file)).href}?t=${Date.now()}`);

const BUBBLE = process.env.BUBBLE_MODULE ?? 'node_modules/.cache/fieldwork/message-bubble.mjs';
const EMPTY = process.env.EMPTY_MODULE ?? 'node_modules/.cache/fieldwork/empty-result.mjs';
if (!process.env.BUBBLE_MODULE) {
  mkdirSync('node_modules/.cache/fieldwork', { recursive: true });
  // react-markdown's entity decoder resolves to its DOM build for the browser, and that build calls
  // document.createElement at import time. The app wants the DOM build; node wants the table one.
  bundle('src/components/MessageBubble.tsx', BUBBLE, [
    '--jsx=automatic',
    '--external:react',
    '--external:react-dom',
    '--alias:decode-named-character-reference=./node_modules/decode-named-character-reference/index.js',
  ]);
  bundle('src/lib/emptyResult.ts', EMPTY);
}

const { MessageBubble } = await load(BUBBLE);
const { buildGapReport } = await load(EMPTY);
const React = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');

const message = (content, role = 'assistant') => ({
  id: `m-${role}`,
  conversation_id: 'c-1',
  role,
  content,
  created_at: '2026-11-16T00:00:00Z',
  search_enabled: true,
  model: 'darkc0de/XORTRON-RICO-v3',
});

const render = (props) => renderToStaticMarkup(React.createElement(MessageBubble, { isStreaming: false, ...props }));

const failed = buildGapReport({
  query: 'site:tesla.com filetype:pdf investor deck',
  engines: ['exa', 'tavily'],
  issues: [{ engine: 'tavily', name: 'Tavily', status: 'missing_key', label: 'missing key', detail: 'TAVILY_API_KEY is not set', severity: 'warning' }],
}).body;

// 1. the gap report, as it lands in a conversation
const gap = render({
  message: message(failed),
  query: 'site:tesla.com filetype:pdf investor deck',
  onRetrySearch: () => {},
  onRunLane: () => {},
});
check('render: the statement survives as bold text, not raw asterisks', /<strong>No sources\.<\/strong>/.test(gap), gap.slice(0, 90));
check('render: the gaps render as a list', /<li>/.test(gap) && /missing key/.test(gap));
check('render: no answer is given', !/Sources consulted/.test(gap));

// 2. the way out: a wider query, spelled out
check('render: the broader query is offered with its text', /Broader:/.test(gap) && /investor deck/.test(gap), 'broader button');
check('render: the operators are gone from the offered query', !/Broader:[^<]*filetype:/.test(gap));

// 3. the other way out: lane chips, collapsed until asked
check('render: the lane control is a collapsed disclosure', /<button[^>]*aria-expanded="false"[^>]*>[\s\S]{0,80}Run a lane/.test(gap), 'lane button');
check('render: lanes stay hidden until opened', !/Exposed files/.test(gap));

// 4. an ordinary answer gets no rescue buttons
const answer = render({ message: message('The sources agree on one point [1].'), query: 'anything', onRetrySearch: () => {}, onRunLane: () => {} });
check('render: a normal answer offers no buttons', !/Broader:/.test(answer) && !/Run a lane/.test(answer));

// 5. the user's own turn is never given buttons, even if it quotes the report
const echoed = render({ message: message('**No sources.** what happened?', 'user'), query: 'q', onRetrySearch: () => {}, onRunLane: () => {} });
check('render: a user message gets no buttons', !/Broader:/.test(echoed) && !/Run a lane/.test(echoed));

// 6. with no query there is nothing to broaden or run, so no buttons are offered
const orphan = render({ message: message(failed), onRetrySearch: () => {}, onRunLane: () => {} });
check('render: no query, no buttons', !/Broader:/.test(orphan) && !/Run a lane/.test(orphan));

// 7. streaming: buttons arrive with the finish, not mid-token
const streaming = render({ message: message(failed), query: 'investor deck', isStreaming: true, onRetrySearch: () => {}, onRunLane: () => {} });
check('render: still streaming, the buttons wait', !/Broader:/.test(streaming), 'gapless while streaming');

const failures = results.filter((row) => !row.ok);
console.log(`\n${results.length - failures.length}/${results.length} assertions passed`);
if (failures.length) process.exit(1);
