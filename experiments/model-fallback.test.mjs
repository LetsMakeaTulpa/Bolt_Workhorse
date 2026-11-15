// Drives the real api.ts fallback logic against a stubbed llm-proxy.
// Run: npx esbuild src/lib/api.ts --bundle --format=esm --outfile=/tmp/api.mjs \
//        --define:import.meta.env.VITE_SUPABASE_URL='"https://proxy.test"' \
//        --define:import.meta.env.VITE_SUPABASE_ANON_KEY='"anon"' && node experiments/model-fallback.test.mjs

// minimal localStorage so reliability persistence can be exercised outside a browser
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

// supabase-js builds a realtime client eagerly on import and insists on a WebSocket constructor,
// which Node 20 does not have. Nothing here opens a socket, so a stub is enough to import api.ts.
if (!globalThis.WebSocket) {
  globalThis.WebSocket = class {
    close() {}
    addEventListener() {}
    removeEventListener() {}
  };
}

const {
  chatCompletion, fallbackChain, isRetryableModelError, modelReliability, recordModelResult,
  modelHealthCount, clearModelHealth, getModelHealth,
} = await import(process.env.API_MODULE ?? '/tmp/api.mjs');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const capacityError = () =>
  new Response(
    JSON.stringify({
      error: 'upstream failed',
      details: JSON.stringify({ error: { message: 'capacity_exhausted' } }),
    }),
    { status: 503, headers: { 'Content-Type': 'application/json' } },
  );

const switchingLimitError = () =>
  new Response(
    JSON.stringify({
      error: 'upstream failed',
      details: JSON.stringify({ error: { message: 'model_switching_limit_exceeded: max 4 switches/minute' } }),
    }),
    { status: 429, headers: { 'Content-Type': 'application/json' } },
  );

const sse = (text) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        for (const word of text.split(' ')) {
          controller.enqueue(
            enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: `${word} ` } }] })}\n\n`),
          );
        }
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );

const emptyStream = () =>
  new Response(new ReadableStream({ start: (c) => c.close() }), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });

function run(responses) {
  const calls = [];
  let index = 0;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.model);
    const next = responses[index++];
    return typeof next === 'function' ? next() : next;
  };

  let content = '';
  let error = '';
  const switches = [];
  const promise = new Promise((resolve) => {
    chatCompletion(
      'xortron/RESTRICTED-RESEARCH-MODEL',
      [{ role: 'user', content: 'hello' }],
      {
        onToken: (t) => { content += t; },
        onDone: (full) => resolve({ done: full }),
        onError: (e) => resolve({ error: e }),
        onModelSwitch: (from, to, reason) => switches.push({ from, to, reason }),
      },
      undefined,
      ['xortron/other', 'TheDrummer/Uncensored-7B'],
    );
  });
  return { promise: promise.then((r) => ({ ...r, content, calls, switches })), calls, switches };
}

// 1. capacity on the primary degrades to the next refusal-free model
{
  const run1 = run([capacityError, () => sse('fallback answered')]);
  const out = await run1.promise;
  check('capacity error falls back to the next model', out.done === 'fallback answered ', JSON.stringify(out.done));
  check('fallback used the chain in order', out.calls.join(' -> ') === 'xortron/RESTRICTED-RESEARCH-MODEL -> xortron/other', out.calls.join(' -> '));
  check('switch callback reported the reason', out.switches.length === 1 && /capacity/.test(out.switches[0].reason));
  check('no error surfaced when a fallback succeeded', !out.error);
}

// 2. empty 200 stream also degrades
{
  const run2 = run([emptyStream, () => sse('second try')]);
  const out = await run2.promise;
  check('empty stream falls back', out.done === 'second try ', JSON.stringify(out.done));
}

// 3. the switch rate limit must not cause another switch
{
  const run3 = run([switchingLimitError, () => sse('never')]);
  const out = await run3.promise;
  check('switch limit stops the chain', Boolean(out.error), String(out.error).slice(0, 60));
  check('switch limit makes no extra model call', out.calls.length === 1, out.calls.join(' -> '));
  check('switch limit gets friendly wording', /4 per minute/.test(out.error));
}

// 4. a hard 400 is not retried on another model
{
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'invalid request' }), { status: 400 });
  let error = '';
  await new Promise((resolve) => {
    chatCompletion('xortron/RESTRICTED-RESEARCH-MODEL', [{ role: 'user', content: 'x' }], {
      onToken: () => {},
      onDone: () => resolve(),
      onError: (e) => { error = e; resolve(); },
    }, undefined, ['xortron/other']);
  });
  check('non-retryable error is not retried', /invalid request/.test(error), error.slice(0, 50));
}

// 5. chain ordering prefers XORTRON, then other refusal-free builds, then the catalogue
{
  const models = [
    { id: 'Qwen/Qwen3-8B', lane: undefined },
    { id: 'TheDrummer/Uncensored-32B', lane: 'refusal-free' },
    { id: 'xortron/RESTRICTED-RESEARCH-MODEL', lane: 'refusal-free' },
    { id: 'xortron/UNCENSORED-31B', lane: 'refusal-free' },
  ];
  const chain = fallbackChain('xortron/RESTRICTED-RESEARCH-MODEL', models, 3);
  check(
    'chain: xortron first, then refusal-free, then catalogue',
    chain.join(',') === 'xortron/UNCENSORED-31B,TheDrummer/Uncensored-32B,Qwen/Qwen3-8B',
    chain.join(','),
  );
}

// 6. models that answered are promoted next time
{
  store.clear();
  const models = [
    { id: 'Qwen/Qwen3-8B' },
    { id: 'TheDrummer/Uncensored-32B', lane: 'refusal-free' },
    { id: 'xortron/UNCENSORED-31B', lane: 'refusal-free' },
  ];
  // the drummmer answers, the xortron build is at capacity
  recordModelResult('TheDrummer/Uncensored-32B', true);
  recordModelResult('xortron/UNCENSORED-31B', false);
  const chain = fallbackChain('xortron/RESTRICTED-RESEARCH-MODEL', models, 3);
  check(
    'a model that answered is promoted ahead of an untried sibling',
    chain.join(',') === 'TheDrummer/Uncensored-32B,xortron/UNCENSORED-31B,Qwen/Qwen3-8B',
    chain.join(','),
  );
  check('reliability is persisted', store.has('fieldwork.model-health.v1'), [...store.keys()].join(','));
  check('success scores above failure', modelReliability('TheDrummer/Uncensored-32B') > modelReliability('xortron/UNCENSORED-31B'));
}

// 7. a live attempt feeds the record: capacity failure then success on the fallback
{
  store.clear();
  const run7 = run([capacityError, () => sse('ok')]);
  await run7.promise;
  const health = JSON.parse(store.get('fieldwork.model-health.v1') ?? '{}');
  check(
    'failed primary and successful fallback are recorded',
    health['xortron/RESTRICTED-RESEARCH-MODEL']?.fail === 1 && health['xortron/other']?.ok === 1,
    JSON.stringify(health),
  );
}

// 7b. the provider's prose wording for the same limit (captured live) must not switch
{
  const proseSwap = () =>
    new Response(
      JSON.stringify({
        error: 'upstream failed',
        details: JSON.stringify({
          error: {
            message:
              'Your current plan only allows you to switch models 4 times per minute. Please try again later or upgrade your plan to increase this limit.',
          },
        }),
      }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    );
  const run7b = run([proseSwap, () => sse('should never be requested')]);
  const out = await run7b.promise;
  check('prose switch-limit wording stops the chain', Boolean(out.error), String(out.error).slice(0, 70));
  check('prose switch-limit wording makes no extra model call', out.calls.length === 1, out.calls.join(' -> '));
  check('prose switch-limit wording gets friendly text', /4 per minute/.test(out.error));
  check('prose switch-limit wording is classified non-retryable', !isRetryableModelError(out.error));
}

// 7c. resetting the history forgets what was learned
{
  store.clear();
  const models = [
    { id: 'TheDrummer/Uncensored-32B', lane: 'refusal-free' },
    { id: 'xortron/UNCENSORED-31B', lane: 'refusal-free' },
  ];
  // make the learned order the opposite of the lane order, so a reset is observable
  recordModelResult('TheDrummer/Uncensored-32B', true);
  recordModelResult('TheDrummer/Uncensored-32B', true);
  recordModelResult('xortron/UNCENSORED-31B', false);
  check('two models tracked after three attempts', modelHealthCount() === 2, String(modelHealthCount()));

  const snapshot = getModelHealth();
  check(
    'picker snapshot exposes counts per model',
    snapshot['TheDrummer/Uncensored-32B']?.ok === 2 && snapshot['xortron/UNCENSORED-31B']?.fail === 1,
    JSON.stringify(snapshot),
  );

  const before = fallbackChain('xortron/RESTRICTED-RESEARCH-MODEL', models, 2).join(',');
  check('learned order leads with the model that answered', before.startsWith('TheDrummer/Uncensored-32B'), before);

  clearModelHealth();
  check('reset clears the stored history', modelHealthCount() === 0 && !store.has('fieldwork.model-health.v1'));

  const after = fallbackChain('xortron/RESTRICTED-RESEARCH-MODEL', models, 2).join(',');
  check(
    'order after reset reverts to lane order',
    after === 'xortron/UNCENSORED-31B,TheDrummer/Uncensored-32B' && after !== before,
    `${before} -> ${after}`,
  );
}

// 8. retryable classification
check('capacity_exhausted is retryable', isRetryableModelError('capacity_exhausted (HTTP 503)'));
check('switching limit is not retryable', !isRetryableModelError('model_switching_limit_exceeded'));

// 9. cancelling mid-stream stops the completion instead of finishing it
{
  const controller = new AbortController();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body).model);
    return new Response(
      new ReadableStream({
        start(stream) {
          const enc = new TextEncoder();
          stream.enqueue(
            enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial ' } }] })}\n\n`),
          );
          // a real fetch cancels the body when its signal aborts; emulate that for the reader
          init.signal?.addEventListener('abort', () => stream.error(new DOMException('Aborted', 'AbortError')));
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );
  };

  const events = [];
  await new Promise((resolve) => {
    chatCompletion(
      'xortron/RESTRICTED-RESEARCH-MODEL',
      [{ role: 'user', content: 'x' }],
      {
        onToken: (token) => {
          events.push(`token:${token}`);
          controller.abort();
        },
        onDone: (full) => { events.push(`done:${full}`); resolve(); },
        onError: (error) => { events.push(`error:${error}`); resolve(); },
        onAbort: (partial) => { events.push(`abort:${partial}`); resolve(); },
      },
      undefined,
      ['xortron/other'],
      controller.signal,
    );
  });

  check('cancel fires onAbort, not onDone', events.some((event) => event.startsWith('abort:')), events.join(' | '));
  check('cancel keeps the text that already streamed', events.some((event) => event === 'abort:partial '), events.join(' | '));
  check('cancel does not fall back to another model', calls.length === 1, calls.join(' -> '));
  check('cancel is not reported as an error', !events.some((event) => event.startsWith('error:')));
}

// 10. a signal aborted before the request makes no model call at all
{
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return sse('never requested');
  };
  const events = [];
  await chatCompletion(
    'xortron/RESTRICTED-RESEARCH-MODEL',
    [{ role: 'user', content: 'x' }],
    {
      onToken: (token) => events.push(`token:${token}`),
      onDone: (full) => events.push(`done:${full}`),
      onError: (error) => events.push(`error:${error}`),
      onAbort: (partial) => events.push(`abort:${partial}`),
    },
    undefined,
    ['xortron/other'],
    controller.signal,
  );
  check('already-cancelled signal makes no request', calls === 0, String(calls));
  check('already-cancelled signal reports an abort', events.length === 1 && events[0] === 'abort:', events.join(' | '));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
process.exit(failed.length ? 1 : 0);
