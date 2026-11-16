// A superseded search must stop working, not just have its answer dropped. Abort has to reach the
// network, or a cancelled run keeps spending provider rate limit for a result nobody will read.
import { installWebSocketStub, tmpPath, ESBUILD } from './lib/build.mjs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// The local esbuild JS entry point is run under node directly: spawning `npx` through cmd.exe
// strips the quotes in --define and turns the value into invalid JSON.
const DIR = (process.env.ABORT_DIR ?? tmpPath('')).replaceAll('\\', '/');
const API = `${DIR}/fieldwork-abort-api.mjs`;
const CLIENT = `${DIR}/fieldwork-abort-client.mjs`;
const GUARD = `${DIR}/fieldwork-abort-guard.mjs`;

const build = (entry, out, extra = []) =>
  execFileSync(
    process.execPath,
    [ESBUILD, entry, '--bundle', '--format=esm', `--outfile=${out}`, '--log-level=error', ...extra],
    { stdio: 'inherit' },
  );

build('src/lib/api.ts', API, [
  '--define:import.meta.env.VITE_SUPABASE_URL="https://proxy.test"',
  '--define:import.meta.env.VITE_SUPABASE_ANON_KEY="anon"',
]);
build('src/lib/clientEngines.ts', CLIENT);
build('src/lib/runGuard.ts', GUARD);

// browser shims: clientEngines touches window timers and the api module reads storage
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = globalThis;
// supabase-js builds its realtime client eagerly and Node 20 has no WebSocket
installWebSocketStub();

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

const { webSearch } = await import(`${pathToFileURL(API).href}?t=${Date.now()}`);
const { searchClientEngines } = await import(`${pathToFileURL(CLIENT).href}?t=${Date.now()}`);
const { RunGuard } = await import(`${pathToFileURL(GUARD).href}?t=${Date.now()}`);

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

// 4. supersession: a run invalidated from outside the search path cannot write any more
const guard = new RunGuard();
const first = guard.begin();
check('a fresh run owns the screen', first.isCurrent() && guard.running);

const second = guard.begin();
check('a newer run supersedes the previous one', !first.isCurrent() && second.isCurrent());
check('starting a run aborts the one it replaced', first.controller.signal.aborted && !second.controller.signal.aborted);

// the engine-set change: nothing new is started, the old run simply stops owning the result list
const stale = guard.begin();
check('superseding reports that something was running', guard.supersede() === true);
check('a superseded run cannot write its results', stale.isCurrent() === false);
check('superseding aborts the fetch it invalidated', stale.controller.signal.aborted);
check('nothing is left running', guard.running === false && guard.aborted === true);
check('superseding twice is a no-op', guard.supersede() === false);

const freshRun = guard.begin();
check('a run begun after a supersede is current again', freshRun.isCurrent() && guard.running && !guard.aborted);
check('the run that was superseded stays stale', stale.isCurrent() === false);

console.log(`\n${passed}/${passed + failures.length} assertions passed`);
if (failures.length > 0) process.exit(1);
