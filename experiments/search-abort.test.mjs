// A superseded search must stop working, not just have its answer dropped. Abort has to reach the
// network, or a cancelled run keeps spending provider rate limit for a result nobody will read.
import { execFileSync } from 'node:child_process';

const API = '/tmp/fieldwork-abort-api.mjs';
const CLIENT = '/tmp/fieldwork-abort-client.mjs';

const build = (entry, out, extra = []) =>
  execFileSync('npx', ['--yes', 'esbuild', entry, '--bundle', '--format=esm', `--outfile=${out}`, '--log-level=error', ...extra], {
    stdio: 'inherit',
  });

build('src/lib/api.ts', API, [
  '--define:import.meta.env.VITE_SUPABASE_URL="https://proxy.test"',
  '--define:import.meta.env.VITE_SUPABASE_ANON_KEY="anon"',
]);
build('src/lib/clientEngines.ts', CLIENT);

// browser shims: clientEngines touches window timers and the api module reads storage
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = globalThis;

const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });

let aborted = 0;
let requests = 0;

/** A request that never answers on its own, and rejects the moment its signal aborts. */
const hangUntilAborted = (_url, init) => {
  requests += 1;
  const signal = init?.signal;
  return new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      aborted += 1;
      reject(abortError());
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        aborted += 1;
        reject(abortError());
      },
      { once: true },
    );
  });
};

globalThis.fetch = hangUntilAborted;

const { webSearch } = await import(`${API}?t=${Date.now()}`);
const { searchClientEngines } = await import(`${CLIENT}?t=${Date.now()}`);

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

// 1. the edge-function call is cancellable
const controller = new AbortController();
const pending = webSearch('postgres index bloat', ['duckduckgo'], 5, false, 'general', false, controller.signal);
controller.abort();
let rejected = false;
try {
  await pending;
} catch (err) {
  rejected = err?.name === 'AbortError';
}
check('webSearch rejects when its signal aborts', rejected);
check('the abort reached the network', aborted === 1, `aborted=${aborted}`);

// 2. an already-cancelled search does no work at all
const before = requests;
const skipped = await searchClientEngines('crispr off-target', ['hn', 'crossref'], 5, undefined, AbortSignal.abort());
check('an already-aborted client run returns nothing', skipped.length === 0);
check('and performs no request', requests === before, `requests ${before} → ${requests}`);

// 3. cancelling mid-run stops every engine and suppresses partials
const partials = [];
const runController = new AbortController();
const run = searchClientEngines('graph neural network', ['hn', 'crossref', 'europepmc'], 5, (engine, items) => {
  partials.push([engine, items.length]);
}, runController.signal);
runController.abort();
const results = await run;
check('a cancelled client run resolves empty', results.length === 0);
check('no engine streams partials after cancellation', partials.length === 0, JSON.stringify(partials));
check('cancellation reached the in-flight requests', aborted >= 4, `aborted=${aborted}`);

console.log(`\n${passed}/${passed + failures.length} assertions passed`);
if (failures.length > 0) process.exit(1);
