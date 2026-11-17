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
const TURN = process.env.TURN_DECISION_MODULE ?? 'node_modules/.cache/fieldwork/turn-decision.mjs';
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
  bundle('src/lib/turnDecision.ts', TURN);
}

const { MessageBubble } = await load(BUBBLE);
const { buildGapReport } = await load(EMPTY);
const { STOPPED_SEARCH_NOTE, SUPERSEDED_SEARCH_NOTE } = await load(TURN);
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

// 5. an answer with nothing behind it carries a badge, not only a log line
const unverified = render({ message: { ...message('The model answered on its own.'), search_results: [] } });
check('render: an unsourced answer is badged', /Unverified — no sources retrieved/.test(unverified), 'badge text');
check('render: the badge explains itself on hover', /The search ran and collected nothing/.test(unverified), 'tooltip');
check('render: the answer is still shown under the badge', /The model answered on its own/.test(unverified));

const sourced = render({
  message: {
    ...message('Grounded answer [1].'),
    search_results: [{ title: 'A paper', url: 'https://example.org/a', snippet: 's', source_engine: 'exa', citation_id: '[1]' }],
  },
});
check('render: an answer with a source is not badged', !/Unverified/.test(sourced));

const searchOff = render({ message: { ...message('Plain answer, no search run.'), search_enabled: false, search_results: [] } });
check('render: search off is not unverified', !/Unverified/.test(searchOff));

const userTurn = render({ message: { ...message('my question', 'user'), search_results: [] } });
check('render: a question is never badged', !/Unverified/.test(userTurn));

// a gap report already states that nothing was found, so the badge would only repeat it
const gapBadge = render({ message: { ...message(failed), search_results: [] }, query: 'site:tesla.com filetype:pdf investor deck' });
check('render: the gap report is not double-labelled', /<strong>No sources\.<\/strong>/.test(gapBadge) && !/Unverified/.test(gapBadge));

// 5. the user's own turn is never given buttons, even if it quotes the report
const echoed = render({ message: message('**No sources.** what happened?', 'user'), query: 'q', onRetrySearch: () => {}, onRunLane: () => {} });
check('render: a user message gets no buttons', !/Broader:/.test(echoed) && !/Run a lane/.test(echoed));

// 6. with no query there is nothing to broaden or run, so no buttons are offered
const orphan = render({ message: message(failed), onRetrySearch: () => {}, onRunLane: () => {} });
check('render: no query, no buttons', !/Broader:/.test(orphan) && !/Run a lane/.test(orphan));

// 7. streaming: buttons arrive with the finish, not mid-token
const streaming = render({ message: message(failed), query: 'investor deck', isStreaming: true, onRetrySearch: () => {}, onRunLane: () => {} });
check('render: still streaming, the buttons wait', !/Broader:/.test(streaming), 'gapless while streaming');

// 8. a turn that ended with no answer still offers the button that was missing: every one of
//    these used to leave the question on screen with no source block, and the source block was the
//    only place Retry lived, so the reader had to retype the question
const asked = [];
const retryTurn = (q) => asked.push(q);
// the retry button is the one carrying a retry title, so an unrelated disabled control cannot
// make an enabled retry look disabled
const retryControl = (html) => html.match(/<button[^>]*title="(?:Retry|Ask this again)[^"]*"[^>]*>/)?.[0] ?? '';
// the attribute, not Tailwind's `disabled:` class on the same tag
const isDisabled = (tag) => / disabled(?:=""|[\s>])/.test(tag);

const stopped = render({ message: message(STOPPED_SEARCH_NOTE), query: 'investor deck', onRetryTurn: retryTurn });
check('render: a stopped search offers Retry', retryControl(stopped) !== '', stopped.slice(0, 120));
check('render: the stopped retry is enabled when it can act', retryControl(stopped) !== '' && !isDisabled(retryControl(stopped)), retryControl(stopped));
check('render: the stopped retry says what it will do', /Runs the question again, search and answer, as a fresh turn/.test(stopped));
check('render: the stopped retry names the question it re-runs', /Retry — search and answer “investor deck” again/.test(stopped));

const replaced = render({ message: message(SUPERSEDED_SEARCH_NOTE), query: 'graph neural network survey', onRetryTurn: retryTurn });
check('render: a superseded turn offers Retry', retryControl(replaced) !== '');
check('render: the superseded retry says why it is there', /Ask this again — a newer question replaced it/.test(replaced));

const errored = render({ message: message('Error: the request failed'), query: 'anything', onRetryTurn: retryTurn });
check('render: a failed turn offers Retry', retryControl(errored) !== '');

check('render: an ordinary answer gets no turn retry', retryControl(answer) === '');
check('render: a source-backed answer keeps its own Retry, not a second one', retryControl(sourced) === '');
check('render: no query means nothing to re-run', retryControl(render({ message: message(STOPPED_SEARCH_NOTE), onRetryTurn: retryTurn })) === '');
check(
  'render: still streaming, no retry under a half-written answer',
  retryControl(render({ message: message(STOPPED_SEARCH_NOTE), query: 'investor deck', isStreaming: true, onRetryTurn: retryTurn })) === '',
);
check(
  'render: without a handler the retry is shown disabled, not hidden',
  isDisabled(retryControl(render({ message: message(STOPPED_SEARCH_NOTE), query: 'investor deck' }))),
);

// 9. every real answer ends in something to press: its bottom line as a query, and follow-up
//    questions even when the model left its FOLLOW-UPS section out
const blufAnswer = 'Surface code thresholds above 1% error rates are the binding constraint [1].';
const withBluf = render({
  message: message(blufAnswer),
  query: 'how do surface codes scale?',
  onRetrySearch: () => {},
  onFollowUp: () => {},
});
check('render: the bottom line becomes a query chip', /surface code thresholds/.test(withBluf));
check('render: the chip says the query came from the bottom line', /The bottom line of this answer as a query/.test(withBluf));
check('render: the query chip is unquoted, so it is a query and not prose', /<span class="truncate">surface code thresholds/.test(withBluf));
check(
  'render: follow-up questions appear even without a FOLLOW-UPS section',
  /What is the strongest primary source on surface code/.test(withBluf) && /What evidence contradicts/.test(withBluf),
);
check('render: the derived chips are questions, not statements', /What changed about surface code[^<]*\?/.test(withBluf));
check('render: the post is still labelled as a place to keep digging', /Keep digging/.test(withBluf));

const ownQuestions = render({
  message: message(`${blufAnswer}\n\nFOLLOW-UPS\n- Who funds the error-correction roadmap?\n- Which vendor ships logical qubits?`),
  query: 'how do surface codes scale?',
  onRetrySearch: () => {},
  onFollowUp: () => {},
});
check(
  'render: the model’s own questions win over derived ones',
  /Who funds the error-correction roadmap\?/.test(ownQuestions) && !/strongest primary source/.test(ownQuestions),
);
check(
  'render: a gap report keeps its own next moves',
  !/strongest primary source/.test(gap) && !/The bottom line of this answer/.test(gap),
);
check(
  'render: an unanswered turn gets Retry, not derived questions',
  !/strongest primary source/.test(stopped) && !/The bottom line of this answer/.test(stopped),
);
check(
  'render: mid-stream there is no bottom line to search yet',
  !/The bottom line of this answer/.test(
    render({ message: message(blufAnswer), query: 'q', isStreaming: true, onRetrySearch: () => {}, onFollowUp: () => {} }),
  ),
);

const failures = results.filter((row) => !row.ok);
console.log(`\n${results.length - failures.length}/${results.length} assertions passed`);
if (failures.length) process.exit(1);
