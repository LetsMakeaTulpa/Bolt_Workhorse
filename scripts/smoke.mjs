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
import { join } from 'node:path';
import { bundle, tmpPath } from '../experiments/lib/build.mjs';

const live = process.argv.includes('--live');
const passed = [];
const failed = [];
const skipped = [];

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// a .cmd cannot be spawned without a shell on Windows, and `npm` is a shell builtin on neither side
const needsShell = process.platform === 'win32';

const asModulePath = (path) => `${process.cwd()}/${path}`.replaceAll('\\', '/');

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

const nodeTest = (name, script, env) => run(name, process.execPath, [script], { env });

function skip(name, reason) {
  skipped.push(`${name} — ${reason}`);
  console.log(`→ ${name}\n  SKIPPED (${reason})`);
}

/** `npm install --no-save` for a test-only package; true when it ends up present. */
function ensurePackage(dir, spec, name) {
  if (existsSync(join('node_modules', dir))) return true;
  console.log(`→ installing ${name} (test-only, not saved)`);
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

// ── 3. model fallback + reliability (the suite bundles the real api.ts) ──────
nodeTest('model fallback chain', 'experiments/model-fallback.test.mjs');

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
nodeTest('provider key parsing', 'experiments/provider-keys.test.mjs');
nodeTest('ranking badges', 'experiments/rank-badges.test.mjs');

// ── 4h. every ranking constant must still be distinguishable from its neutral value ─────────
// The ablation is what says a constant earns its place; if the fixture drifts until a constant
// changes nothing, that verdict is unearned and the constant could be set to anything.
run('ranking constants still separate', process.execPath, ['experiments/ranking-sweep.mjs', '--assert-separation']);

// ── 4g. a superseded search stops its requests instead of finishing ──────────
nodeTest('search abort', 'experiments/search-abort.test.mjs');

// ── 4g2. the same property from the outside, through the rendered hook ───────
if (existsSync(join('node_modules', 'react-test-renderer'))) {
  nodeTest('useSearch supersession', 'experiments/use-search-supersede.test.mjs');
} else {
  skip('useSearch supersession', 'react-test-renderer unavailable (npm install --no-save react-test-renderer@18.3.1)');
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
    nodeTest('empty result bubble', 'experiments/empty-result-bubble.test.mjs', {
      BUBBLE_MODULE: asModulePath(bubble),
      EMPTY_MODULE: asModulePath(empty),
    });
  } catch (err) {
    failed.push('empty result bubble');
    console.log(`→ empty result bubble\n  FAILED\n    ${err.message}`);
  }
}
nodeTest('prompt variant', 'experiments/prompt-variant.test.mjs');
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
    skip(name, 'PGlite unavailable (offline install failed)');
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
