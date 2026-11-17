// A provider can answer as a different model than the one it was asked for. The stream says which
// model actually ran, so this drives the real api.ts against a stubbed llm-proxy and checks that the
// mismatch is noticed once, named, and does not interfere with the answer it arrives with.
// Run: node experiments/model-served.test.mjs (standalone it builds api.ts itself)
import { asUrl, bundle, installWebSocketStub, tmpPath } from './lib/build.mjs';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

// supabase-js builds a realtime client on import and needs a WebSocket constructor Node lacks
installWebSocketStub();

const API_PATH = process.env.API_MODULE ?? tmpPath('api-model-served.mjs');
if (!process.env.API_MODULE) {
  bundle('src/lib/api.ts', API_PATH, [
    '--define:import.meta.env.VITE_SUPABASE_URL="https://proxy.test"',
    '--define:import.meta.env.VITE_SUPABASE_ANON_KEY="anon"',
  ]);
}

const { chatCompletion, servedModelMismatch } = await import(asUrl(API_PATH));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const REQUESTED = 'xortron/RESTRICTED-RESEARCH-MODEL';

/** An OpenAI-shaped stream whose every chunk names `model` (omit it to test a provider that does not). */
const stream = (text, model) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        for (const word of text.split(' ')) {
          const chunk = { choices: [{ delta: { content: `${word} ` } }] };
          if (model !== undefined) chunk.model = model;
          controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );

async function run(responseFactory) {
  globalThis.fetch = async () => responseFactory();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  let content = '';
  const served = [];
  let done = '';
  let error = '';
  try {
    await new Promise((resolve) => {
      void chatCompletion(
        REQUESTED,
        [{ role: 'user', content: 'hello' }],
        {
          onToken: (token) => { content += token; },
          onDone: (full) => { done = full; resolve(); },
          onError: (message) => { error = message; resolve(); },
          onModelServed: (requested, got) => served.push({ requested, got }),
        },
      );
    });
  } finally {
    console.warn = originalWarn;
  }
  return { content, done, error, served, warnings };
}

// 1. the comparison itself
{
  check('the same model is not a mismatch', !servedModelMismatch(REQUESTED, REQUESTED));
  check('a different model is a mismatch', servedModelMismatch(REQUESTED, 'Qwen/Qwen2.5-7B-Instruct'));
  check('case and padding are the provider spelling it differently', !servedModelMismatch(REQUESTED, `  ${REQUESTED.toLowerCase()} `));
  check('a missing model field claims nothing', !servedModelMismatch(REQUESTED, undefined) && !servedModelMismatch(REQUESTED, ''));
  check('an empty request is not a mismatch', !servedModelMismatch('', 'Qwen/Qwen2.5-7B-Instruct'));
}

// 2. the provider serves what was asked for: no warning, the answer arrives intact
{
  const outcome = await run(() => stream('the answer is four words', REQUESTED));
  check('a matching model says nothing', outcome.served.length === 0, JSON.stringify(outcome.served));
  check('a matching model logs nothing', outcome.warnings.length === 0, outcome.warnings.join(' | '));
  check('the answer still completes', outcome.done === 'the answer is four words ' || outcome.content.trim() === 'the answer is four words', outcome.done);
}

// 3. the provider serves something else: one warning, with both names
{
  const outcome = await run(() => stream('the answer is four words', 'Qwen/Qwen2.5-7B-Instruct'));
  check('a different model is reported once', outcome.served.length === 1, JSON.stringify(outcome.served));
  check('the report names what was asked for', outcome.served[0]?.requested === REQUESTED, outcome.served[0]?.requested);
  check('the report names what actually answered', outcome.served[0]?.got === 'Qwen/Qwen2.5-7B-Instruct', outcome.served[0]?.got);
  check('every chunk repeats the model but only one warning is logged', outcome.warnings.length === 1, outcome.warnings.join(' | '));
  check('the warning carries both ids', /Qwen\/Qwen2\.5-7B-Instruct/.test(outcome.warnings[0] ?? '') && outcome.warnings[0]?.includes(REQUESTED), outcome.warnings[0]);
  check('the answer is still delivered whole', outcome.content.trim() === 'the answer is four words', outcome.content);
  check('a mismatch is not an error', outcome.error === '', outcome.error);
}

// 4. a provider that does not echo a model is not accused of anything
{
  const outcome = await run(() => stream('no model field here', undefined));
  check('a stream without a model field warns nothing', outcome.served.length === 0 && outcome.warnings.length === 0);
  check('and still delivers the answer', outcome.content.trim() === 'no model field here', outcome.content);
}

const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) process.exit(1);
