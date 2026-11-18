#!/usr/bin/env node
// One command that proves the repo still works: build, then every experiment test.
//
//   npm run smoke            # build + unit/db tests
//   npm run smoke -- --live  # + read-only probes against the live Supabase project
//
// This is the runner. It used to be bash, which meant the gate could not run on a Windows machine
// without Git Bash on PATH — the platform where most of these checks are easiest to get wrong.
// Node is already required to run any of them, so the steps live here in one list: a new check is
// one entry, not a shell function plus a registration line.
//
// Anything that cannot run (missing test-only package, no network) is reported as SKIP, never as a
// pass, and the exit code is non-zero if any check fails.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { bundle, tmpPath } from '../experiments/lib/build.mjs';

const live = process.argv.includes('--live');
const passed = [];
const failed = [];
const skipped = [];

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// a .cmd cannot be spawned without a shell on Windows, and `npm` is a shell builtin on neither side
const needsShell = process.platform === 'win32';

/** Run one check, capture its output, and report it as ok / FAILED with the tail of the log. */
function run(name, command, args, { env = {}, shell = false } = {}) {
  process.stdout.write(`→ ${name}\n`);
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    shell,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status === 0) {
    passed.push(name);
    console.log('  ok');
    return true;
  }
  failed.push(name);
  console.log('  FAILED');
  for (const line of output.trimEnd().split(/\r?\n/).slice(-20)) console.log(`    ${line}`);
  return false;
}

/**
 * A bundle path the test can import. Paths from `tmpPath()` are already absolute and only need
 * their separators normalised; prefixing the working directory onto one would build
 * `C:/proj/C:/Users/...`, which is not a path on Windows and not a file anywhere.
 */
const asModulePath = (path) => (isAbsolute(path) ? path : `${process.cwd()}/${path}`).replaceAll('\\', '/');

const nodeTest = (name, script, env) => run(name, process.execPath, [script], { env });

function skip(name, reason) {
  skipped.push(`${name} — ${reason}`);
  console.log(`→ ${name}\n  SKIPPED (${reason})`);
}

/** A test-only package the local tree is missing; true when it ends up present. Both are pinned
 * devDependencies, so a plain `npm ci` has them — this only rescues a partially installed tree. */
function ensurePackage(dir, spec, name) {
  if (existsSync(join('node_modules', dir))) return true;
  console.log(`→ installing ${name} (test-only, missing from node_modules)`);
  run(`${name} install`, npmCommand, ['install', '--no-save', '--no-package-lock', spec], { shell: needsShell });
  // the install is scaffolding, not a check: drop it from the tally either way
  passed.pop();
  failed.pop();
  return existsSync(join('node_modules', dir));
}

// ── 1. the app must typecheck and build ───────────────────────────────────────
run('build (tsc + vite)', npmCommand, ['run', 'build'], { shell: needsShell });

// ── 2. parser fixtures for the server-side engines ────────────────────────────
{
  const out = tmpPath('parsers.mjs');
  try {
    bundle('supabase/functions/web-search/parsers.ts', out);
    nodeTest('web-search parsers', 'experiments/websearch-parsers.test.mjs', { PARSERS_MODULE: out });
  } catch (err) {
    failed.push('web-search parsers');
    console.log(`→ web-search parsers\n  FAILED\n    ${err.message}`);
  }
}

// ── 2b. exa + tavily end to end through the handler, parsers and RRF ─────────
nodeTest('exa/tavily pipeline', 'experiments/web-engine-pipeline.test.mjs');

// ── 2c. the public anon key reaches web-search: the counter refuses overspend before any spend,
// and the compiler's model call is bounded and reported rather than hidden ──
nodeTest('web-search limits', 'experiments/websearch-limits.test.mjs');

// ── 3. model fallback + reliability (the suite bundles the real api.ts) ──────
nodeTest('model fallback chain', 'experiments/model-fallback.test.mjs');

// ── 3b. the model the provider actually ran, not the one that was asked for ──
nodeTest('served model mismatch', 'experiments/model-served.test.mjs');

// ── 3c. and the same fact told where the answer is, not only in the activity log ──
{
  const notice = tmpPath('model-notice.mjs');
  try {
    bundle('src/components/ModelNotice.tsx', notice, ['--jsx=automatic', '--external:react', '--external:react-dom']);
    nodeTest('model notice banner', 'experiments/model-notice.test.mjs', { MODEL_NOTICE_MODULE: notice });
  } catch (err) {
    failed.push('model notice banner');
    console.log(`→ model notice banner\n  FAILED\n    ${err.message}`);
  }
}

// ── 3d. the model can ask for another search, and the loop stops it searching forever ──
{
  const apiOut = tmpPath('api-search-tool.mjs');
  const loopOut = tmpPath('search-tool.mjs');
  try {
    bundle('src/lib/api.ts', apiOut, [
      '--define:import.meta.env.VITE_SUPABASE_URL="https://proxy.test"',
      '--define:import.meta.env.VITE_SUPABASE_ANON_KEY="anon"',
    ]);
    bundle('src/lib/searchTool.ts', loopOut);
    nodeTest('search tool loop', 'experiments/search-tool.test.mjs', {
      API_MODULE: apiOut,
      SEARCH_TOOL_MODULE: loopOut,
    });
  } catch (err) {
    failed.push('search tool loop');
    console.log(`→ search tool loop
  FAILED
    ${err.message}`);
  }
}

// ── 3e. the top sources are read as pages, and a page that fails is not a search failure ──
{
  try {
    // the suite bundles its own modules when given no paths; these are only to reuse the build
    const extractOut = tmpPath('extract.mjs');
    const contextOut = tmpPath('source-context.mjs');
    bundle('supabase/functions/web-search/extract.ts', extractOut);
    bundle('src/lib/sourceContext.ts', contextOut);
    nodeTest('page extraction', 'experiments/extract.test.mjs', {
      EXTRACT_MODULE: extractOut,
      SOURCE_CONTEXT_MODULE: contextOut,
    });
  } catch (err) {
    failed.push('page extraction');
    console.log(`→ page extraction\n  FAILED\n    ${err.message}`);
  }
}

// ── 4. the key importer classifies the sample dump and leaks nothing ─────────
run('key importer', process.execPath, [
  'scripts/import-keys.mjs',
  'experiments/fixtures/key-dump-sample.txt',
  '--out-dir',
  tmpPath('smoke-keys'),
]);

// ── 4b–4f. the search UI's own logic ─────────────────────────────────────────
nodeTest('engine status strip', 'experiments/engine-status-ui.test.mjs');
nodeTest('fusion intent weighting', 'experiments/fusion-intent.test.mjs');
nodeTest('follow-up parsing', 'experiments/followups.test.mjs');
// the ledger is lifted out of the answer and drawn as a table: a parser drift either loses rows or
// eats the prose above them, and neither is visible until someone reads the post closely
nodeTest('claim ledger parsing', 'experiments/claim-ledger.test.mjs');
nodeTest('provider key parsing', 'experiments/provider-keys.test.mjs');
nodeTest('ranking badges', 'experiments/rank-badges.test.mjs');

// ── 4h. every ranking constant must still be distinguishable from its neutral value ─────────
// The ablation is what says a constant earns its place; if the fixture drifts until a constant
// changes nothing, that verdict is unearned and the constant could be set to anything.
run('ranking constants still separate', process.execPath, ['experiments/ranking-sweep.mjs', '--assert-separation']);

// ── 4g. a superseded search stops its requests instead of finishing ──────────
nodeTest('search abort', 'experiments/search-abort.test.mjs');
nodeTest('chat turn reliability', 'experiments/chat-reliability.test.mjs');
nodeTest('answer grounding', 'experiments/grounding.test.mjs');
nodeTest('machine trace', 'experiments/machine-trace.test.mjs');
nodeTest('freshness receipt', 'experiments/freshness.test.mjs');
nodeTest('client engines', 'experiments/client-engines.test.mjs');

// ── 4g2. the same property from the outside, through the rendered hook ───────
if (existsSync(join('node_modules', 'react-test-renderer'))) {
  nodeTest('useSearch supersession', 'experiments/use-search-supersede.test.mjs');
} else {
  skip('useSearch supersession', 'react-test-renderer missing from node_modules (it is a devDependency: run npm install)');
}

// ── 4i. the composer shows which selected engines have a key ─────────────────
{
  const dir = join('node_modules', '.cache', 'fieldwork');
  mkdirSync(dir, { recursive: true });
  // inside the project, so an external `react` resolves to the copy the test renders with
  const status = join(dir, 'engine-key-status.mjs');
  const row = join(dir, 'engine-key-row.mjs');
  const lane = join(dir, 'lane-yield-row.mjs');
  try {
    bundle('src/lib/engineKeyStatus.ts', status);
    bundle('src/components/EngineKeyRow.tsx', row, ['--jsx=automatic', '--external:react', '--external:react-dom']);
    bundle('src/components/LaneYieldRow.tsx', lane, ['--jsx=automatic', '--external:react', '--external:react-dom']);
    nodeTest('engine key status', 'experiments/engine-key-status.test.mjs', {
      KEYSTATUS_MODULE: asModulePath(status),
      KEYROW_MODULE: asModulePath(row),
      LANE_MODULE: asModulePath(lane),
    });
  } catch (err) {
    failed.push('engine key status');
    console.log(`→ engine key status\n  FAILED\n    ${err.message}`);
  }
}

// ── 4i2. the source card's badge row, against title and date combinations ────
{
  const dir = join('node_modules', '.cache', 'fieldwork');
  mkdirSync(dir, { recursive: true });
  const card = join(dir, 'source-card.mjs');
  try {
    bundle('src/components/SourceCard.tsx', card, ['--jsx=automatic', '--external:react', '--external:react-dom']);
    nodeTest('source card badges', 'experiments/source-card.test.mjs', { SOURCE_CARD_MODULE: asModulePath(card) });
  } catch (err) {
    failed.push('source card badges');
    console.log(`→ source card badges\n  FAILED\n    ${err.message}`);
  }
}

// ── 4i2b. the Sources tab says how much of its list reached the model ───────
nodeTest('source coverage summary', 'experiments/source-coverage.test.mjs');

// ── 4i3. an empty Sources panel still explains itself and offers a next move ──
{
  const dir = join('node_modules', '.cache', 'fieldwork');
  mkdirSync(dir, { recursive: true });
  const card = join(dir, 'no-sources-card.mjs');
  try {
    bundle('src/components/NoSourcesCard.tsx', card, ['--jsx=automatic', '--external:react', '--external:react-dom']);
    nodeTest('empty sources panel', 'experiments/no-sources-card.test.mjs', { NO_SOURCES_MODULE: asModulePath(card) });
  } catch (err) {
    failed.push('empty sources panel');
    console.log(`→ empty sources panel\n  FAILED\n    ${err.message}`);
  }
}

// ── 4i4. the switch that lets a search-less answer through ──────────────────
nodeTest('empty-result preference', 'experiments/empty-result-pref.test.mjs');

// ── 4j–4n. the answer contract, the empty page, prompts, ranking, searxng ────
nodeTest('system prompt', 'experiments/system-prompt.test.mjs');
nodeTest('empty result', 'experiments/empty-result.test.mjs');

// ── 4o. the gap report in the bubble, not just the string it builds ──────────
{
  const dir = join('node_modules', '.cache', 'fieldwork');
  mkdirSync(dir, { recursive: true });
  const bubble = join(dir, 'message-bubble.mjs');
  const empty = join(dir, 'empty-result.mjs');
  try {
    // react-markdown's entity decoder resolves to a DOM build that touches `document` on import
    bundle('src/components/MessageBubble.tsx', bubble, [
      '--jsx=automatic',
      '--external:react',
      '--external:react-dom',
      '--alias:decode-named-character-reference=./node_modules/decode-named-character-reference/index.js',
    ]);
    bundle('src/lib/emptyResult.ts', empty);
    const turn = join(dir, 'turn-decision.mjs');
    bundle('src/lib/turnDecision.ts', turn);
    nodeTest('empty result bubble', 'experiments/empty-result-bubble.test.mjs', {
      BUBBLE_MODULE: asModulePath(bubble),
      EMPTY_MODULE: asModulePath(empty),
      TURN_DECISION_MODULE: asModulePath(turn),
    });
  } catch (err) {
    failed.push('empty result bubble');
    console.log(`→ empty result bubble\n  FAILED\n    ${err.message}`);
  }
}
// ── 4o2. a citation and its source row light up the same sentences ───────────
if (existsSync(join('node_modules', 'react-test-renderer'))) {
  nodeTest('citation focus', 'experiments/citation-focus.test.mjs');
} else {
  skip('citation focus', 'react-test-renderer missing from node_modules (it is a devDependency: run npm install)');
}
nodeTest('prompt variant', 'experiments/prompt-variant.test.mjs');
// ── 4p2. a retry answers from the sources the failed turn already stored ────
nodeTest('retry reuses stored sources', 'experiments/reuse-sources.test.mjs');
// ── 4p. the panel's collapse is remembered on the device ─────────────────────
nodeTest('panel collapse preference', 'experiments/panel-pref.test.mjs');
nodeTest('ranking compare', 'experiments/ranking-compare.test.mjs');
// --check fails on an nDCG or margin regression against flat trust
run('ranking benchmark', process.execPath, ['experiments/ranking-harness.mjs', '--check']);
nodeTest('searxng adapter', 'experiments/searxng.test.mjs');

// ── 5. database tests need PGlite, which is test-only and not in package.json ─
if (ensurePackage('@electric-sql/pglite', '@electric-sql/pglite', 'PGlite')) {
  nodeTest('app_config lockdown', 'experiments/app-config-lockdown.test.mjs');
  nodeTest('anon write privileges', 'experiments/rls-write-audit.test.mjs');
  nodeTest('per-user RLS isolation', 'experiments/auth-rls.test.mjs');
  nodeTest('proxy rate limits', 'experiments/rate-limit.test.mjs');
} else {
  for (const name of ['app_config lockdown', 'anon write privileges', 'per-user RLS isolation', 'proxy rate limits']) {
    skip(name, '@electric-sql/pglite missing from node_modules (it is a devDependency: run npm install)');
  }
}

// ── 6. optional: talk to the real database ──────────────────────────────────
if (live) {
  const bash = spawnSync('bash', ['-c', 'true'], { encoding: 'utf8' });
  if (!existsSync('.env')) {
    skip('live RLS probes', 'no .env with Supabase credentials');
  } else if (bash.status !== 0) {
    skip('live RLS probes', 'the probe is a bash script and bash is not available here');
  } else {
    const env = {};
    for (const line of readFileSync('.env', 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const match = line.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=(.*)$/);
      if (match) env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
    }
    run('live RLS probes', 'bash', ['experiments/rls-probe.sh'], { env });
  }
}

console.log('\n────────────────────────────────────');
console.log(`passed: ${passed.length}`);
if (skipped.length > 0) {
  console.log(`skipped: ${skipped.length}`);
  for (const entry of skipped) console.log(`  ${entry}`);
}
if (failed.length > 0) {
  console.log(`failed: ${failed.length}`);
  for (const entry of failed) console.log(`  ${entry}`);
  process.exit(1);
}
console.log('failed: 0');
