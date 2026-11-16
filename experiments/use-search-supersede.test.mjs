// Rendered proof, from the outside: a run that has been superseded must not put its results on
// screen. The guard is the interesting part — the engines here *ignore* their abort signal and
// answer anyway, which is exactly the case an AbortController alone cannot stop. Only the hook's
// own epoch check keeps the stale list off the screen, so if that check goes, so does this test.
//
//   node experiments/use-search-supersede.test.mjs
//
// react-test-renderer is test-only and installed with --no-save (see scripts/smoke.sh), so the
// hook is rendered as the app renders it rather than through a stand-in for React.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ESBUILD, installWebSocketStub } from './lib/build.mjs';

// The bundle is written inside the project, not into the temp dir: `react` is kept external so the
// hook renders with the same copy the test drives, and a bundle in the temp dir cannot resolve a
// bare `react` import — it has no node_modules above it.
const DIR = (process.env.USESEARCH_DIR ?? 'node_modules/.cache/fieldwork').replaceAll('\\', '/');
mkdirSync(DIR, { recursive: true });
const MODULE = `${DIR}/use-search.mjs`;

// react stays external so the hook renders with the same React copy the test drives; everything
// else (api, fusion, engines, dorks, supabase-js) is bundled in, as it is in the app.
execFileSync(
  process.execPath,
  [
    ESBUILD,
    'src/hooks/useSearch.ts',
    '--bundle',
    '--format=esm',
    `--outfile=${MODULE}`,
    '--external:react',
    '--log-level=error',
    '--define:import.meta.env.VITE_SUPABASE_URL="https://proxy.test"',
    '--define:import.meta.env.VITE_SUPABASE_ANON_KEY="anon"',
  ],
  { stdio: 'inherit' },
);

// the browser surface the bundled modules reach for at import time
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
globalThis.window = globalThis;
globalThis.navigator ??= { userAgent: 'node' };
installWebSocketStub();
// react-test-renderer's act wants this in React 18 dev builds
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** What an engine that answered with `titles` sends back through the edge function. */
const answer = (query, titles) => ({
  results: titles.map((title, index) => ({
    title,
    url: `https://example.test/${query.replaceAll(' ', '-')}/${index + 1}`,
    snippet: `${title} — about ${query}`,
    source_engine: 'duckduckgo',
  })),
  engine_status: [],
  engines_used: ['duckduckgo'],
  queries_used: [query],
});

const responseOf = (payload) => ({
  ok: true,
  status: 200,
  json: async () => payload,
  text: async () => JSON.stringify(payload),
});

const requests = [];
const prompt = new Map();
const held = new Map();

/** Make a query's engine answer immediately. */
const answersNow = (query, titles) => prompt.set(query, answer(query, titles));

/**
 * Make a query's engine hang until the test releases it, and keep hanging after the abort. This is
 * the misbehaving-provider case: the request is cancelled, the reply arrives anyway.
 */
const hold = (query) => {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  held.set(query, { promise, resolve });
};

globalThis.fetch = (url, init) => {
  const body = init?.body ? JSON.parse(init.body) : {};
  const query = body.query ?? '';
  requests.push({ query, engines: body.engines, signal: init?.signal });
  const hanging = held.get(query);
  if (hanging) return hanging.promise.then((payload) => responseOf(payload));
  return Promise.resolve(responseOf(prompt.get(query) ?? answer(query, [])));
};

const moduleUrl = pathToFileURL(`${process.cwd().replaceAll('\\', '/')}/${MODULE}`).href;
const { useSearch } = await import(`${moduleUrl}?t=${Date.now()}`);
const React = (await import('react')).default;
const renderer = await import('react-test-renderer');
const act = renderer.act ?? renderer.default.act;
const create = renderer.create ?? renderer.default.create;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// ---- the hook, driven the way App drives it -------------------------------------------------
const log = { activity: [], saved: [], closed: [], aborts: 0 };
let rowId = 0;

const options = {
  engines: ['duckduckgo'],
  useDorks: false,
  presets: [{ name: 'general', config: { engines: ['duckduckgo'], max_results: 5 } }],
  selectedPreset: 'general',
  isStreaming: false,
  logActivity: async (conversationId, activity_type, description, details, status) => {
    log.activity.push({ conversationId, activity_type, description, details: details ?? {}, status: status ?? 'completed' });
    return {
      id: `activity-${++rowId}`,
      conversation_id: conversationId,
      activity_type,
      description,
      details: details ?? {},
      status: status ?? 'completed',
      created_at: '',
    };
  },
  ensureConversation: async () => 'conversation-1',
  saveSources: async (conversationId, saved, originalQuery) => {
    log.saved.push({ conversationId, query: originalQuery, titles: saved.map((source) => source.title) });
  },
  abortStream: () => {
    log.aborts += 1;
  },
  closeActivity: (row, description) => {
    log.closed.push({ id: row.id, description });
  },
};

/** Every render writes the hook's return value here, so assertions read what the app would show. */
let view = null;
const Probe = (props) => {
  view = useSearch(props.options);
  return null;
};

let root;
await act(async () => {
  root = create(React.createElement(Probe, { options }));
});

const titles = () => view.results.map((source) => source.title);

// ---- 1. a slow run, then a fast one that replaces it ----------------------------------------
hold('postgres index bloat');
answersNow('crispr off-target prediction', [
  'CRISPR off-target prediction review',
  'CRISPR off-target prediction benchmark',
]);

let runA;
await act(async () => {
  runA = view.performSearch('postgres index bloat', 'conversation-1');
});

check('the first run is on screen as searching', view.isSearching === true && titles().length === 0, JSON.stringify(titles()));
check('the first run reached the engine', requests.at(-1)?.query === 'postgres index bloat', JSON.stringify(requests.map((r) => r.query)));

let runB;
await act(async () => {
  runB = view.performSearch('crispr off-target prediction', 'conversation-1');
  await runB;
});

check('the newer run owns the results', titles().join('|') === 'CRISPR off-target prediction benchmark|CRISPR off-target prediction review' || titles().every((title) => /CRISPR/.test(title)), JSON.stringify(titles()));
check('the newer run is what the panel reports', view.lastQuery === 'crispr off-target prediction', view.lastQuery);
check('a new search also stops the answer that was streaming', log.aborts === 2, `aborts=${log.aborts}`);
check('the newer run finished searching', view.isSearching === false);

// The composer's lane strip is gone once the next search starts; the trail is what a past search
// can still be judged by, so the row has to carry the per-engine yield.
const yieldRows = log.activity.filter((row) => Array.isArray(row.details?.lane_yield));
check('the trail records a lane-yield row for the run', yieldRows.length === 1, `rows=${yieldRows.length}`);
check(
  'the lane-yield row names the engine and its counts',
  yieldRows[0]?.details.lane_yield?.[0]?.engine === 'duckduckgo' &&
    yieldRows[0]?.details.lane_yield?.[0]?.returned > 0,
  JSON.stringify(yieldRows[0]?.details?.lane_yield),
);
check(
  'the row says which engine wasted results, in words',
  /Lane yield:/.test(yieldRows[0]?.description ?? ''),
  yieldRows[0]?.description,
);
check('the gate verdict rides along with it', yieldRows[0]?.details?.gate_relaxed === false, String(yieldRows[0]?.details?.gate_relaxed));
check(
  'the row lists the dead lanes, even when there are none',
  Array.isArray(yieldRows[0]?.details?.dead_lanes) && yieldRows[0].details.dead_lanes.length === 0,
  JSON.stringify(yieldRows[0]?.details?.dead_lanes),
);

const abortedFirstRun = requests.at(-2);
check('the superseded run had its request cancelled', abortedFirstRun?.signal?.aborted === true);

// ---- 2. the superseded engine ignores its abort and answers late ---------------------------
let lateA;
await act(async () => {
  held.get('postgres index bloat').resolve(answer('postgres index bloat', ['Postgres index bloat explained']));
  lateA = await runA;
});

check('the late answer is discarded', titles().every((title) => /CRISPR/.test(title)), JSON.stringify(titles()));
check('the late answer does not join the newer list', !titles().includes('Postgres index bloat explained'), JSON.stringify(titles()));
check('the stale run resolved with nothing', Array.isArray(lateA) && lateA.length === 0, JSON.stringify(lateA));
check('the stale run saved no sources', log.saved.length === 1 && log.saved[0].query === 'crispr off-target prediction', JSON.stringify(log.saved.map((s) => s.query)));
check('the stale run left the panel on the newer query', view.lastQuery === 'crispr off-target prediction', view.lastQuery);
check('the stale run did not restart the spinner', view.isSearching === false);
check(
  'the stale run closed its own activity row',
  log.closed.some((row) => /cancelled|superseded/i.test(row.description)),
  JSON.stringify(log.closed),
);

// ---- 3. cancel, then a late answer ---------------------------------------------------------
hold('graph neural network');
let runC;
await act(async () => {
  runC = view.performSearch('graph neural network', 'conversation-1');
});

let cancelled;
await act(async () => {
  cancelled = view.cancelSearch();
});

check('cancelling reports that a run was stopped', cancelled === true);
check('cancelling stops the spinner', view.isSearching === false && view.status === 'Search cancelled', `${view.isSearching} / ${view.status}`);
check('cancelling cancels the request', requests.at(-1)?.signal?.aborted === true);

await act(async () => {
  held.get('graph neural network').resolve(answer('graph neural network', ['Graph neural network survey']));
  await runC;
});

check('a cancelled run cannot land either', !titles().includes('Graph neural network survey'), JSON.stringify(titles()));
check('a cancelled run leaves the last good list alone', titles().every((title) => /CRISPR/.test(title)), JSON.stringify(titles()));
check('a cancelled run saves nothing', !log.saved.some((save) => save.query === 'graph neural network'), JSON.stringify(log.saved.map((s) => s.query)));

// ---- 4. the engine set changing mid-run supersedes it without starting a search ------------
hold('rust async runtime');
let runD;
await act(async () => {
  runD = view.performSearch('rust async runtime', 'conversation-1');
});
check('the run is searching again', view.isSearching === true);

await act(async () => {
  root.update(React.createElement(Probe, { options: { ...options, engines: ['wikipedia'] } }));
});

check('changing engines drops the results belonging to the old set', titles().length === 0, JSON.stringify(titles()));
check('changing engines stops the spinner', view.isSearching === false);

await act(async () => {
  held.get('rust async runtime').resolve(answer('rust async runtime', ['Rust async runtime internals']));
  await runD;
});

check('a run invalidated by the engine change cannot land', titles().length === 0, JSON.stringify(titles()));
check('nor can it save', !log.saved.some((save) => save.query === 'rust async runtime'), JSON.stringify(log.saved.map((s) => s.query)));

// ---- 5. the requests themselves were the ones the queries asked for ------------------------
assert.deepEqual(
  requests.map((request) => request.query),
  ['postgres index bloat', 'crispr off-target prediction', 'graph neural network', 'rust async runtime'],
);
check('every search started exactly one engine request', requests.filter((request) => request.engines?.includes('duckduckgo')).length === 4, String(requests.length));

await act(async () => {
  root.unmount();
});

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
process.exit(failed.length ? 1 : 0);
