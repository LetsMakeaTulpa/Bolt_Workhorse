// The model may search again mid-answer. Two things have to hold: the stream's tool-call deltas are
// reassembled into a call the loop can act on, and the loop actually runs the search, feeds the
// result back and stops at its budget instead of searching forever.
// Run: node experiments/search-tool.test.mjs (standalone it builds both modules itself)
import { asUrl, bundle, installWebSocketStub, tmpPath } from './lib/build.mjs';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
installWebSocketStub();

const API_PATH = process.env.API_MODULE ?? tmpPath('api-search-tool.mjs');
const LOOP_PATH = process.env.SEARCH_TOOL_MODULE ?? tmpPath('search-tool.mjs');
if (!process.env.API_MODULE) {
  bundle('src/lib/api.ts', API_PATH, [
    '--define:import.meta.env.VITE_SUPABASE_URL="https://proxy.test"',
    '--define:import.meta.env.VITE_SUPABASE_ANON_KEY="anon"',
  ]);
}
if (!process.env.SEARCH_TOOL_MODULE) bundle('src/lib/searchTool.ts', LOOP_PATH);

const { streamTurn, SEARCH_TOOL, DORK_TOOL } = await import(asUrl(API_PATH));
const { queryFromToolCall, runSearchToolLoop } = await import(asUrl(LOOP_PATH));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// ── 1. the stream reassembles tool-call deltas ──────────────────────────────
// OpenAI-shaped providers stream a call as: id+name once, then arguments in pieces.
const toolStream = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const send = (obj) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        send({ model: 'x', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'search_web' } }] } }] });
        send({ model: 'x', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":"' } }] } }] });
        send({ model: 'x', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'rrf benchmark"}' } }] } }] });
        send({ model: 'x', choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );

{
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return toolStream();
  };
  const turn = await streamTurn('m-1', [{ role: 'user', content: 'q' }], { onToken: () => {} }, { tools: [SEARCH_TOOL] });
  check('a tool call is reassembled from its deltas', turn.toolCalls.length === 1 && turn.toolCalls[0].name === 'search_web', JSON.stringify(turn.toolCalls));
  check('the arguments survive being split mid-string', turn.toolCalls[0].arguments === '{"query":"rrf benchmark"}', turn.toolCalls[0].arguments);
  check('the call keeps the provider id', turn.toolCalls[0].id === 'call_1', turn.toolCalls[0].id);
  check('the tools are sent to the provider', Array.isArray(bodies[0]?.tools) && bodies[0].tools[0].function.name === 'search_web');
  check('a tool-only turn is not an empty response', turn.ok === true, turn.error);
  check('the query is read back out of the arguments', queryFromToolCall(turn.toolCalls[0].arguments) === 'rrf benchmark');
}

// ── 2. the loop: one turn, no tool call, nothing searched ───────────────────
{
  const run = await runSearchToolLoop({
    messages: [{ role: 'user', content: 'what is rrf' }],
    tools: [SEARCH_TOOL],
    stream: async () => ({ ok: true, content: 'RRF is rank fusion.', toolCalls: [] }),
    runSearch: async () => { throw new Error('should not search'); },
  });
  check('an answer without a tool call finishes on the first turn', run.stoppedBy === 'done' && run.content === 'RRF is rank fusion.');
  check('and runs no search', run.searches.length === 0, JSON.stringify(run.searches));
}

// ── 3. a thin first pass: the model searches, then answers ──────────────────
{
  const turns = [];
  const searched = [];
  const run = await runSearchToolLoop({
    messages: [{ role: 'system', content: 'ctx' }, { role: 'user', content: 'benchmark numbers?' }],
    tools: [SEARCH_TOOL],
    onSearch: (query) => searched.push(query),
    stream: async (messages, tools) => {
      turns.push({ count: messages.length, tools: tools.length });
      if (turns.length === 1) {
        return { ok: true, content: '', toolCalls: [{ id: 'c1', name: 'search_web', arguments: '{"query":"rrf benchmark numbers"}' }] };
      }
      return { ok: true, content: 'The paper reports nDCG 0.9 [1].', toolCalls: [] };
    },
    runSearch: async (query) => ({ count: 2, text: `results for ${query}` }),
  });
  check('the model can search again', run.searches.length === 1 && run.searches[0] === 'rrf benchmark numbers', JSON.stringify(run.searches));
  check('the search is announced to the caller', searched.length === 1 && searched[0] === 'rrf benchmark numbers');
  check('the answer that follows the search is the one returned', run.content === 'The paper reports nDCG 0.9 [1].', run.content);
  check('the tool result is fed back before the next turn', run.transcript.some((m) => m.role === 'tool' && m.content === 'results for rrf benchmark numbers'));
  check('the assistant turn that asked carries its calls', run.transcript.some((m) => m.role === 'assistant' && m.tool_calls?.[0]?.function.name === 'search_web'));

  const toolMessages = run.transcript.filter((m) => m.role === 'tool');
  check('the tool message answers the call it belongs to', toolMessages[0].tool_call_id === 'c1', toolMessages[0].tool_call_id);
}

// ── 3b. a call the model sent without an id still gets a matching answer ───
{
  let first = true;
  const run = await runSearchToolLoop({
    messages: [{ role: 'user', content: 'q' }],
    tools: [SEARCH_TOOL],
    stream: async () => {
      if (first) {
        first = false;
        return { ok: true, content: '', toolCalls: [{ name: 'search_web', arguments: '{"query":"no id"}' }] };
      }
      return { ok: true, content: 'answered', toolCalls: [] };
    },
    runSearch: async () => ({ count: 1, text: 'found' }),
  });
  const assistant = run.transcript.find((message) => message.tool_calls?.length);
  const tool = run.transcript.find((message) => message.role === 'tool');
  check(
    'an id invented for a call is the id its tool message answers',
    Boolean(assistant?.tool_calls?.[0]?.id) && assistant?.tool_calls?.[0]?.id === tool?.tool_call_id,
    `${assistant?.tool_calls?.[0]?.id} vs ${tool?.tool_call_id}`,
  );
}

// ── 3c. the dork tool: one operator, its own executor, the same budget ──────
{
  const dorked = [];
  let first = true;
  const run = await runSearchToolLoop({
    messages: [{ role: 'user', content: 'find config files on that host' }],
    tools: [SEARCH_TOOL, DORK_TOOL],
    stream: async () => {
      if (first) {
        first = false;
        return {
          ok: true,
          content: '',
          toolCalls: [{ id: 'd1', name: 'search_dorks', arguments: '{"query":"site:example.com ext:env"}' }],
        };
      }
      return { ok: true, content: 'answered', toolCalls: [] };
    },
    runSearch: async () => {
      throw new Error('a dork must not run the plain search executor');
    },
    runDorks: async (query) => {
      dorked.push(query);
      return { count: 2, text: 'dork results' };
    },
  });
  check('a dork call reaches the dork executor', dorked[0] === 'site:example.com ext:env', String(dorked[0]));
  check('and not the plain one', dorked.length === 1);
  check('the dork is recorded as a search the model ran', run.searches[0] === 'site:example.com ext:env');
  check('the loop still finishes with an answer', run.stoppedBy === 'done' && run.content === 'answered');
  check(
    'its results are handed back as a tool message',
    run.transcript.some((message) => message.role === 'tool' && message.content === 'dork results'),
  );

  // a build without the executor must refuse the tool rather than crash on it
  let turns = 0;
  const unavailable = await runSearchToolLoop({
    messages: [{ role: 'user', content: 'q' }],
    tools: [DORK_TOOL],
    stream: async (messages) => {
      turns += 1;
      return messages.some((message) => message.role === 'tool')
        ? { ok: true, content: 'answered', toolCalls: [] }
        : { ok: true, content: '', toolCalls: [{ id: 'd2', name: 'search_dorks', arguments: '{"query":"site:a.com"}' }] };
    },
    runSearch: async () => ({ count: 0, text: '' }),
  });
  check('a dork tool with no executor is refused, not run', unavailable.searches.length === 0 && turns === 2);
  check(
    'and the refusal says why',
    unavailable.transcript.some((message) => message.role === 'tool' && /not available/.test(message.content)),
  );

  // an operatorless dork is a plain search wearing the wrong name: refuse it, do not spend the slot
  const noOperator = await runSearchToolLoop({
    messages: [{ role: 'user', content: 'q' }],
    tools: [DORK_TOOL],
    stream: async (messages) =>
      messages.some((message) => message.role === 'tool')
        ? { ok: true, content: 'answered', toolCalls: [] }
        : { ok: true, content: '', toolCalls: [{ id: 'd3', name: 'search_dorks', arguments: '{"query":"just some words"}' }] },
    runSearch: async () => ({ count: 0, text: '' }),
    runDorks: async () => {
      throw new Error('a query with no operator is not a dork');
    },
  });
  check('a dork with no operator is refused before it runs', noOperator.searches.length === 0);
  check(
    'and the model is told to use the other tool',
    noOperator.transcript.some((message) => message.role === 'tool' && /search_web/.test(message.content)),
  );
}

// ── 4. the budget: it cannot search forever ─────────────────────────────────
{
  let searches = 0;
  let turnsWithTools = 0;
  const run = await runSearchToolLoop({
    messages: [{ role: 'user', content: 'q' }],
    tools: [SEARCH_TOOL],
    maxSearches: 2,
    stream: async (_messages, tools) => {
      if (tools.length > 0) turnsWithTools += 1;
      // always asks, so only the budget can stop it
      return { ok: true, content: '', toolCalls: [{ id: `c${searches}`, name: 'search_web', arguments: '{"query":"more"}' }] };
    },
    runSearch: async () => { searches += 1; return { count: 1, text: 'some results' }; },
  });
  check('only the budgeted searches run', searches === 2, String(searches));
  check('the turn after the budget is asked without tools', turnsWithTools === 2, String(turnsWithTools));
  check('the refusal is explained to the model', run.transcript.some((m) => m.role === 'tool' && /budget spent/.test(m.content)));
}

// ── 5. bad calls are answered, not crashed on ───────────────────────────────
{
  const run = await runSearchToolLoop({
    messages: [{ role: 'user', content: 'q' }],
    tools: [SEARCH_TOOL],
    stream: async (messages) =>
      messages.some((m) => m.role === 'tool')
        ? { ok: true, content: 'answered', toolCalls: [] }
        : {
          ok: true,
          content: '',
          toolCalls: [
            { id: 'a', name: 'fetch_url', arguments: '{}' },
            { id: 'b', name: 'search_web', arguments: '{not json' },
          ],
        },
    runSearch: async () => { throw new Error('should not search'); },
  });
  check('an unknown tool is refused by name', run.transcript.some((m) => m.role === 'tool' && /No tool named fetch_url/.test(m.content)));
  check('a query-less call is explained', run.transcript.some((m) => m.role === 'tool' && /needs a "query"/.test(m.content)));
  check('no search runs for a bad call', run.searches.length === 0);
  check('the answer still arrives after the refusals', run.content === 'answered', run.content);
}

// ── 6. a bare query is still a query ───────────────────────────────────────
check('a bare sentence is accepted as the query', queryFromToolCall('graph neural networks') === 'graph neural networks');
check('half a JSON object is not a query', queryFromToolCall('{"query":') === '');
check('an empty argument is not a query', queryFromToolCall('') === '' && queryFromToolCall('{}') === '');

// ── 7. stopping and failing are reported as themselves ─────────────────────
{
  const aborted = await runSearchToolLoop({
    messages: [{ role: 'user', content: 'q' }],
    tools: [SEARCH_TOOL],
    stream: async () => ({ ok: false, content: 'half an ans', toolCalls: [], aborted: true }),
    runSearch: async () => ({ count: 0, text: '' }),
  });
  check('a cancelled turn stops the loop as cancelled', aborted.stoppedBy === 'aborted' && aborted.content === 'half an ans');

  const failed = await runSearchToolLoop({
    messages: [{ role: 'user', content: 'q' }],
    tools: [SEARCH_TOOL],
    stream: async () => ({ ok: false, content: '', toolCalls: [], error: 'capacity_exhausted' }),
    runSearch: async () => ({ count: 0, text: '' }),
  });
  check('a failed turn stops the loop as failed', failed.stoppedBy === 'error' && failed.error === 'capacity_exhausted', failed.error);
}

const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) process.exit(1);
