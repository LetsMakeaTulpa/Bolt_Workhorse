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

// the badge names the outcome; the gaps name the cause, in the transcript rather than only in a
// panel the reader may have collapsed
const unsourced = {
  ...message('The model answered on its own.'),
  search_results: [],
  gaps: ['Tavily — missing key (TAVILY_API_KEY is not set)', 'Exa answered with nothing'],
};
const withGaps = render({ message: unsourced, query: 'investor deck' });
check('render: the gaps are listed under the unsourced answer', /missing key/.test(withGaps) && /Exa answered with nothing/.test(withGaps));
check('render: the gap list is labelled as the reason there is no sources', /No sources[^<]*gaps/i.test(withGaps), 'gap heading');
check('render: the badge and the gap list appear together', /Unverified — no sources retrieved/.test(withGaps));
check('render: the answer is still above its gaps', /The model answered on its own/.test(withGaps));
check('render: no gaps recorded means no empty gap block', !/No sources[^<]*gaps/i.test(unverified));
check('render: the gaps wait for the answer to finish', !/No sources[^<]*gaps/i.test(render({ message: unsourced, isStreaming: true })));

const sourced = render({
  message: {
    ...message('Grounded answer [1].'),
    search_results: [{ title: 'A paper', url: 'https://example.org/a', snippet: 's', source_engine: 'exa', citation_id: '[1]' }],
  },
});
check('render: an answer with a source is not badged', !/Unverified/.test(sourced));
check('render: an answer with a source lists no gaps', !/No sources[^<]*gaps/i.test(sourced));
check('render: the source control is named for searching, not answering', /Search only/.test(sourced) && !/Retry/.test(sourced));

// 4b. a search-only run never rewrote the post, so the post says what the run changed and offers
//     the one control that would rewrite it
const firstSource = { title: 'A paper', url: 'https://example.org/a', snippet: 's', source_engine: 'exa', citation_id: '[1]' };
const ranAgain = render({
  message: { ...message('Grounded answer [1].'), search_results: [firstSource] },
  query: 'investor deck',
  rerun: {
    query: 'investor deck',
    results: [firstSource, { title: 'B paper', url: 'https://example.org/b', snippet: 's', source_engine: 'exa', citation_id: '[2]' }],
  },
  onRetrySearch: () => {},
  onAnswerWithSources: () => {},
});
check('render: the re-run report says the answer was not rewritten', /this answer is unchanged/.test(ranAgain));
check(
  'render: it reports what the run returned and what was new',
  /returned 2 sources/.test(ranAgain) && /1 not in this answer/.test(ranAgain),
  'report counts',
);
check('render: it offers to answer from those sources', /Answer with these/.test(ranAgain));
check('render: the post itself is still the old answer', /Grounded answer/.test(ranAgain) && /data-citation="1"/.test(ranAgain));

const nothingNew = render({
  message: { ...message('Grounded answer [1].'), search_results: [firstSource] },
  query: 'investor deck',
  rerun: { query: 'investor deck', results: [{ ...firstSource }] },
  onRetrySearch: () => {},
  onAnswerWithSources: () => {},
});
check('render: a run that found only known sources says so', /nothing new/.test(nothingNew));

// the report is read at a ~130px column: the query may truncate, the count and the separator
// may not disappear with it, and no phrase may begin with the separator
const flat = nothingNew.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ');
check(
  'render: the query truncates and the count sits outside it',
  /class="min-w-0 truncate"[^>]*>“investor deck”<\/span> ?<span class="flex-shrink-0">returned 1 source ?·<\/span>/.test(flat),
  'count outside the truncated span',
);
check('render: the separator ends a phrase instead of starting one', !/> ?·/.test(flat), 'leading separator');

const foundNothing = render({
  message: { ...message('Grounded answer [1].'), search_results: [firstSource] },
  query: 'investor deck',
  rerun: { query: 'investor deck', results: [] },
  onRetrySearch: () => {},
  onAnswerWithSources: () => {},
});
check(
  'render: a run that found nothing still reports, with no answer button',
  /returned 0 sources/.test(foundNothing) && !/Answer with these/.test(foundNothing),
);
check('render: no re-run means no report', !/this answer is unchanged/.test(sourced));

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
const retryControl = (html) => html.match(/<button[^>]*title="Ask again[^"]*"[^>]*>/)?.[0] ?? '';
// the attribute, not Tailwind's `disabled:` class on the same tag
const isDisabled = (tag) => / disabled(?:=""|[\s>])/.test(tag);

const stopped = render({ message: message(STOPPED_SEARCH_NOTE), query: 'investor deck', onRetryTurn: retryTurn });
check('render: a stopped search offers Retry', retryControl(stopped) !== '', stopped.slice(0, 120));
check('render: the stopped retry is enabled when it can act', retryControl(stopped) !== '' && !isDisabled(retryControl(stopped)), retryControl(stopped));
check('render: the stopped retry says what it will do', /Runs the question again, search and answer, as a fresh turn/.test(stopped));
check('render: the stopped retry names the question it re-runs', /Ask again — search and answer “investor deck” again/.test(stopped));
check('render: the whole-turn control is named for asking again', />Ask again<\/button>/.test(stopped), 'turn control');

const replaced = render({ message: message(SUPERSEDED_SEARCH_NOTE), query: 'graph neural network survey', onRetryTurn: retryTurn });
check('render: a superseded turn offers Retry', retryControl(replaced) !== '');

// the note is not an answer, so nothing may judge it as one
check('render: a stopped turn is not badged as unverified', !/Unverified/.test(stopped));
check('render: no grounding verdict is passed on a turn with no answer', !/Grounding:/.test(stopped), 'grounding strip on a note');
check('render: the superseded retry says why it is there', /Ask again — a newer question replaced it/.test(replaced));

const errored = render({ message: message('Error: the request failed'), query: 'anything', onRetryTurn: retryTurn });
check('render: a failed turn offers Retry', retryControl(errored) !== '');

// a retry is a second attempt at one question, not a new question that happens to follow it
const retriedQuestion = render({
  message: { ...message('investor deck'), role: 'user', retry_of: 'attempt-1' },
  query: 'investor deck',
  onRetryTurn: retryTurn,
});
check('render: a retried question says it replaces an attempt', /Retry of the earlier attempt/.test(retriedQuestion));
check(
  'render: and links to the turn it replaces',
  /href="#msg-attempt-1"/.test(retriedQuestion) && /id="msg-/.test(retriedQuestion),
  retriedQuestion.slice(0, 220),
);
check('render: a first attempt carries no retry link', !/Retry of the earlier attempt/.test(stopped));

const replacedAttempt = render({
  message: message(STOPPED_SEARCH_NOTE),
  query: 'investor deck',
  onRetryTurn: retryTurn,
  retriedBy: 'attempt-2',
});
check(
  'render: the replaced attempt points forward to the retry',
  /href="#msg-attempt-2"/.test(replacedAttempt) && /Retried below/.test(replacedAttempt),
  replacedAttempt.slice(0, 220),
);
check('render: a turn nobody retried carries no link forward', !/Retried below/.test(stopped));

// the same words that found nothing usually find nothing again, so the wider search is offered too
const emptyRetry = render({
  message: message('Error: the request failed'),
  query: 'investor deck benchmarks 2026',
  onRetryTurn: retryTurn,
});
check('render: a zero-source turn offers a broader retry', /Ask broader/.test(emptyRetry), emptyRetry.slice(0, 300));
check(
  'render: the broader retry names the wider question, not the same one',
  /title="Ask again for a wider search: “investor deck benchmarks”/.test(emptyRetry),
  emptyRetry.match(/title="Ask again for a wider search[^"]*"/)?.[0],
);

// nothing to remove means nothing wider to offer: repeating the same words under a new label is the
// problem this control exists to fix
const unbroadeanable = render({
  message: message('Error: the request failed'),
  query: 'investor deck',
  onRetryTurn: retryTurn,
});
check('render: a question with nothing to widen offers no broader retry', !/Ask broader/.test(unbroadeanable));
check(
  'render: it sits beside the verbatim retry rather than replacing it',
  /Ask again<\/button>/.test(emptyRetry) && /Ask broader/.test(emptyRetry),
);
check('render: the hint says the same words may find the same nothing', /same words again/.test(emptyRetry));

const retryWithSources = render({
  message: { ...message('Error: the request failed'), search_results: [firstSource] },
  query: 'investor deck',
  onRetryTurn: retryTurn,
});
check('render: a turn that already has its sources gets no wider retry', !/Ask broader/.test(retryWithSources));

check('render: an ordinary answer gets no turn retry', retryControl(answer) === '');
check('render: a source-backed answer keeps its own Retry, not a second one', retryControl(sourced) === '');
check('render: no query means nothing to re-run', retryControl(render({ message: message(STOPPED_SEARCH_NOTE), onRetryTurn: retryTurn })) === '');
// "nothing to re-ask" is not "an answer to audit": the grounding verdict stays off the note either way
check(
  'render: a note without a question to re-ask is still not audited',
  !/Grounding:/.test(render({ message: message(STOPPED_SEARCH_NOTE), onRetryTurn: retryTurn })),
);
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
check('render: the chip says the query came from the bottom line', /bottom line of this answer as a query/i.test(withBluf));
check('render: the query chip is unquoted, so it is a query and not prose', /<span class="truncate">surface code thresholds/.test(withBluf));
check(
  'render: follow-up questions appear even without a FOLLOW-UPS section',
  /What is the strongest primary source on surface code/.test(withBluf) && /What evidence contradicts/.test(withBluf),
);
check('render: the derived chips are questions, not statements', /What changed about surface code[^<]*\?/.test(withBluf));

// the row and the receipt must not argue: an old window cannot be asked about the past year
const oldWindow = render({
  message: {
    ...message(blufAnswer),
    search_results: [
      {
        title: 'Old page',
        url: 'https://example.org/old',
        snippet: 's',
        source_engine: 'exa',
        citation_id: '[1]',
        published: '2019-05-01',
      },
    ],
  },
  query: 'latest surface code results',
  onRetrySearch: () => {},
  onFollowUp: () => {},
});
check('render: the receipt flags the old window', /Sources dated/.test(oldWindow) && /newest is \d+mo old/.test(oldWindow), oldWindow.slice(0, 300));
check('render: the derived question names the date the receipt shows', /since 2019-05-01/.test(oldWindow), oldWindow.slice(0, 400));
check('render: and the row no longer asks about the past year', !/past year/.test(oldWindow));

// the diagnosis now carries its own next move: search the same question for recent pages
check('render: a diagnosis without a handler offers no control', !/Search recent/.test(oldWindow));
const recentRuns = [];
const actionable = render({
  message: {
    ...message(blufAnswer),
    search_results: [
      { title: 'Old page', url: 'https://example.org/old', snippet: 's', source_engine: 'exa', citation_id: '[1]', published: '2019-05-01' },
    ],
  },
  query: 'latest surface code results',
  onRetrySearch: () => {},
  onSearchRecent: (q) => recentRuns.push(q),
});
check('render: a stale window offers the recent search', /Search recent/.test(actionable), actionable.slice(0, 300));
check(
  'render: the control says what it will change',
  /publication dates weighted/.test(actionable) && /Recent scope/i.test(actionable),
  actionable.match(/title="Search this question again[^"]*"/)?.[0],
);
check('render: it sits beside the diagnosis, not in place of it', /Sources dated/.test(actionable) && /Search recent/.test(actionable));

const freshWindow = render({
  message: {
    ...message(blufAnswer),
    search_results: [
      {
        title: 'New page',
        url: 'https://example.org/new',
        snippet: 's',
        source_engine: 'exa',
        citation_id: '[1]',
        published: new Date().toISOString().slice(0, 10),
      },
    ],
  },
  query: 'latest surface code results',
  onRetrySearch: () => {},
  onSearchRecent: (q) => recentRuns.push(q),
});
check('render: a fresh window has nothing to fix, so no control', !/Search recent/.test(freshWindow), freshWindow.slice(0, 300));
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
// the same search must not be offered twice under two labels: the model's own extra searches are
// already buttons under "Searched again"
const alreadySearched = render({
  message: { ...message(blufAnswer), tool_searches: ['Surface Code Thresholds'] },
  query: 'how do surface codes scale?',
  onRetrySearch: () => {},
  onFollowUp: () => {},
});
check(
  'render: a bottom line the model already searched is not offered again',
  !/bottom line of this answer as a query/i.test(alreadySearched),
);
check(
  'render: that search still appears under “Searched again”',
  /Searched again/.test(alreadySearched) && /Surface Code Thresholds/.test(alreadySearched),
);
check('render: its derived questions are unaffected', /strongest primary source on surface code/.test(alreadySearched));

const otherSearched = render({
  message: { ...message(blufAnswer), tool_searches: ['logical qubit benchmarks'] },
  query: 'how do surface codes scale?',
  onRetrySearch: () => {},
  onFollowUp: () => {},
});
check(
  'render: a different extra search leaves the bottom-line chip in place',
  /bottom line of this answer as a query/i.test(otherSearched),
);

// containment is not equality: a wider model search has not answered the bottom line
const widerSearched = render({
  message: { ...message(blufAnswer), tool_searches: ['surface code thresholds 2025'] },
  query: 'how do surface codes scale?',
  onRetrySearch: () => {},
  onFollowUp: () => {},
});
check(
  'render: a wider extra search does not stand in for the bottom line',
  /bottom line of this answer as a query/i.test(widerSearched),
);

// a thin phrase is a query, not a subject worth three questions
const thinSubject = render({ message: message('Costs fell [1].'), query: 'q', onRetrySearch: () => {}, onFollowUp: () => {} });
check('render: a thin bottom line still gets its search chip', /bottom line of this answer as a query/i.test(thinSubject));
check('render: a thin bottom line gets no derived questions', !/strongest primary source/.test(thinSubject));

check(
  'render: mid-stream there is no bottom line to search yet',
  !/The bottom line of this answer/.test(
    render({ message: message(blufAnswer), query: 'q', isStreaming: true, onRetrySearch: () => {}, onFollowUp: () => {} }),
  ),
);

// a productive extra search and a redundant one must not read alike
const productives = render({
  message: {
    ...message('Grounded answer [1].'),
    search_results: [firstSource],
    tool_searches: [
      'surface code thresholds',
      'reciprocal rank fusion',
      'surface code decoherence budgets',
      'site:arxiv.org filetype:pdf surface codes',
    ],
    tool_search_yields: [
      { query: 'surface code thresholds', found: 4, added: 2 },
      { query: 'reciprocal rank fusion', found: 3, added: 0 },
      { query: 'surface code decoherence budgets', found: 0, added: 0 },
      { query: 'site:arxiv.org filetype:pdf surface codes', found: 3, added: 1, dork: true },
    ],
  },
  query: 'investor deck',
  onRetrySearch: () => {},
});
check('render: a productive extra search shows what it added', /\+2/.test(productives), productives.slice(0, 300));
check(
  'render: a redundant one says nothing new',
  /nothing new/.test(productives),
  productives.match(/[^>]*nothing new/)?.[0],
);
// an empty search is not a redundant one: saying "nothing new" about a run that never returned a
// source reads as "you already had these" when there was nothing to have
check(
  'render: a search that found nothing says so instead of nothing new',
  /no results/.test(productives) && (productives.match(/nothing new/g) ?? []).length === 1,
  productives.match(/[^>]*no results/)?.[0],
);
// a dork is not a plain extra search: the operator was the request, and the chip has to say so
check(
  'render: the dork chip is marked, and only the dork chip',
  (productives.match(/>dork<\/span>/g) ?? []).length === 1,
  String((productives.match(/>dork<\/span>/g) ?? []).length),
);
check(
  'render: the dork chip names search_dorks and what it returned',
  /Dork \(search_dorks\)[^"]*site:arxiv\.org filetype:pdf surface codes[^"]*3 sources, 1 new/.test(productives),
  productives.match(/title="Dork[^"]*"/)?.[0],
);
check(
  'render: the chip still offers the query back',
  /title="Search only[^"]*surface code thresholds[^"]*not rewritten"/.test(productives),
);
check('render: rows without recorded yields show no invented count', !/\+2|nothing new/.test(sourced));

const failures = results.filter((row) => !row.ok);
console.log(`\n${results.length - failures.length}/${results.length} assertions passed`);
if (failures.length) process.exit(1);
