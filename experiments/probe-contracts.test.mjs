// The drift gate's three probes are CLI programs, so their exit code *is* the verdict — and until now
// nothing in smoke checked that the verdict was still the one DEPLOY.md promises. A refactor that
// turned rls:check into an unconditional 0 would have looked like a healthy gate forever.
//
// Each probe runs as the workflow runs it, with `fetch` replaced by experiments/lib/mock-fetch.mjs,
// and the pass, fail and cannot-probe paths are asserted for all three. No network, no credentials.
// Run: node experiments/probe-contracts.test.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MOCK = pathToFileURL(join(process.cwd(), 'experiments', 'lib', 'mock-fetch.mjs')).href;
const workDir = mkdtempSync(join(tmpdir(), 'probe-contracts-'));
let reportId = 0;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Run one probe the way the workflow does. `routes` are keyed by pathname, `*` answers the rest. */
function probe(script, args = [], { routes = {}, timeout = [], noCredentials = false, report = false } = {}) {
  const reportPath = report ? join(workDir, `seen-${++reportId}.json`) : '';
  const started = Date.now();
  const child = spawnSync(process.execPath, ['--import', MOCK, script, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      VITE_SUPABASE_URL: noCredentials ? '' : 'https://probe.test',
      VITE_SUPABASE_ANON_KEY: noCredentials ? '' : 'anon-key',
      PROBE_MOCK: JSON.stringify({ routes, timeout }),
      PROBE_MOCK_REPORT: reportPath,
    },
  });
  return {
    code: child.status,
    output: `${child.stdout ?? ''}${child.stderr ?? ''}`,
    seconds: (Date.now() - started) / 1000,
    seen: reportPath ? JSON.parse(readFileSync(reportPath, 'utf8')) : null,
  };
}

const refused = { '*': [403, { message: 'permission denied for table' }] };
const allowed = { '*': [200, { message: 'ok' }] };

try {
  // ── rls:check ──────────────────────────────────────────────────────────────
  const anonPass = probe('scripts/probe-anon.mjs', [], { routes: { '/rest/v1/research_presets': [200, []], ...refused }, report: true });
  check('rls:check passes when every private table refuses anon', anonPass.code === 0, `exit ${anonPass.code}`);
  check(
    'every rls:check request carries an AbortSignal',
    anonPass.seen?.length > 10 && anonPass.seen.every((row) => row.signal),
    `${anonPass.seen?.length} requests, ${anonPass.seen?.filter((row) => !row.signal).length} without a signal`,
  );

  const anonRows = probe('scripts/probe-anon.mjs', [], {
    routes: { '/rest/v1/research_presets': [200, []], '/rest/v1/app_config': [200, [{ id: 'x' }]], ...refused },
  });
  check('rls:check fails when a private table answers with rows', anonRows.code === 1 && /app_config/.test(anonRows.output), `exit ${anonRows.code}`);

  const anonEmpty = probe('scripts/probe-anon.mjs', [], {
    routes: { '/rest/v1/research_presets': [200, []], '/rest/v1/messages': [200, []], ...refused },
  });
  check(
    'a grant with no rows is still a failure, not a pass',
    anonEmpty.code === 1 && /0 rows today/.test(anonEmpty.output),
    `exit ${anonEmpty.code}`,
  );

  const anonControl = probe('scripts/probe-anon.mjs', [], { routes: { ...refused } });
  check('rls:check is blind, not green, when its control table cannot be read', anonControl.code === 2, `exit ${anonControl.code}`);

  const anonOdd = probe('scripts/probe-anon.mjs', [], {
    routes: { '/rest/v1/research_presets': [200, []], '/rest/v1/app_config': [500, {}], ...refused },
  });
  check('an unreadable answer is a blind spot, not an exposure', anonOdd.code === 2, `exit ${anonOdd.code}`);

  const anonSkip = probe('scripts/probe-anon.mjs', [], {
    routes: { '/rest/v1/research_presets': [200, []], '/rest/v1/search_runs': [404, {}], ...refused },
  });
  check('a table that is not deployed yet is a skip, not a failure', anonSkip.code === 0, `exit ${anonSkip.code}`);

  check('rls:check cannot probe without credentials', probe('scripts/probe-anon.mjs', [], { noCredentials: true }).code === 2);

  // ── functions:check ────────────────────────────────────────────────────────
  const healthy = {
    '/functions/v1/web-search': [200, { configured: ['EXA_API_KEY', 'TAVILY_API_KEY'] }],
    '/functions/v1/llm-proxy/models': [200, { models: [{ id: 'a/b' }], default_model: 'a/b' }],
  };
  const fnPass = probe('scripts/probe-functions.mjs', [], { routes: healthy, report: true });
  check('functions:check passes when both functions answer as expected', fnPass.code === 0, `exit ${fnPass.code}`);
  check(
    'every functions:check request carries an AbortSignal',
    fnPass.seen?.length === 2 && fnPass.seen.every((row) => row.signal),
    JSON.stringify(fnPass.seen),
  );

  const stale = probe('scripts/probe-functions.mjs', [], {
    routes: { ...healthy, '/functions/v1/web-search': [500, { error: 'Unexpected end of JSON input' }] },
  });
  check('a stale web-search fails the run and says to redeploy', stale.code === 1 && /Redeploy/.test(stale.output), `exit ${stale.code}`);

  const leaked = probe('scripts/probe-functions.mjs', [], {
    routes: { ...healthy, '/functions/v1/web-search': [200, { configured: ['EXA_API_KEY', 'sk-live-secret'] }] },
  });
  check('a secret value where a name belongs fails the run', leaked.code === 1, `exit ${leaked.code}`);

  const noModels = probe('scripts/probe-functions.mjs', [], {
    routes: { ...healthy, '/functions/v1/llm-proxy/models': [200, { models: [], default_model: 'a/b' }] },
  });
  check('an empty model list fails the run', noModels.code === 1, `exit ${noModels.code}`);

  for (const status of [429, 503]) {
    const blind = probe('scripts/probe-functions.mjs', [], {
      routes: { ...healthy, '/functions/v1/llm-proxy/models': [status, { error: 'environment' }] },
    });
    check(`HTTP ${status} from llm-proxy is a blind spot, not staleness`, blind.code === 2, `exit ${blind.code}`);
  }

  check('functions:check cannot probe without credentials', probe('scripts/probe-functions.mjs', [], { noCredentials: true }).code === 2);

  // ── migrations:check ───────────────────────────────────────────────────────
  const schemaPass = probe('scripts/apply-migrations.mjs', ['--check'], { routes: allowed, report: true });
  check('migrations:check passes when every object is present', schemaPass.code === 0, `exit ${schemaPass.code}`);
  check(
    'every migrations:check request carries an AbortSignal',
    schemaPass.seen?.length > 25 && schemaPass.seen.every((row) => row.signal),
    `${schemaPass.seen?.length} requests, ${schemaPass.seen?.filter((row) => !row.signal).length} without a signal`,
  );

  check('migrations:check fails when objects are missing', probe('scripts/apply-migrations.mjs', ['--check'], { routes: { '*': [404, {}] } }).code === 1);

  const hung = probe('scripts/apply-migrations.mjs', ['--check'], { routes: allowed, timeout: ['/rest/v1/messages'] });
  check(
    'a hung object ends the pass at once and fails as blind',
    hung.code === 2 && /never asked/.test(hung.output) && hung.seconds < 10,
    `exit ${hung.code} in ${hung.seconds}s`,
  );

  const dryHung = probe('scripts/apply-migrations.mjs', ['--check', '--dry'], { routes: allowed, timeout: ['/rest/v1/messages'] });
  check('--dry refuses to call a truncated list a success', dryHung.code === 2, `exit ${dryHung.code}`);

  check('migrations:check cannot probe without credentials', probe('scripts/apply-migrations.mjs', ['--check'], { noCredentials: true }).code === 2);

  // a migration the reader cannot name is a blind spot, and it outranks the objects it could check
  const hole = 'supabase/migrations/20990101000000_probe_contract.sql';
  writeFileSync(hole, "do $$\nbegin\n  execute 'create table public.unreadable (id int)';\nend\n$$;\n");
  try {
    const unreadable = probe('scripts/apply-migrations.mjs', ['--check'], { routes: allowed });
    check(
      'an unprobed migration fails as blind, not as drift',
      unreadable.code === 2 && /cannot cover every migration/.test(unreadable.output),
      `exit ${unreadable.code}`,
    );
  } finally {
    rmSync(hole, { force: true });
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

const failures = results.filter((row) => !row.ok);
console.log(`\n${results.length - failures.length}/${results.length} assertions passed`);
if (failures.length) process.exit(1);
