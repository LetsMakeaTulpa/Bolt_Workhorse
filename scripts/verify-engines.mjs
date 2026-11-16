#!/usr/bin/env node
// Verifies that Exa and Tavily return real results from the deployed web-search function, and
// that those results survive the client's fusion layer.
//
//   npm run engines:verify
//   npm run engines:verify -- --query "quantum error correction" --engines exa,tavily
//
// Needs only the public anon key (from .env). The engine secrets live in the function env; this
// script never sees or prints them. Exit codes: 0 verified, 1 failed, 2 not configured.

import { readFileSync } from 'node:fs';
import { asUrl, bundle, tmpPath } from '../experiments/lib/build.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const QUERY = flag('query', 'reciprocal rank fusion information retrieval');
const ENGINES = flag('engines', 'exa,tavily').split(',').map((e) => e.trim()).filter(Boolean);
const LIMIT = Number(flag('limit', '8'));

function loadEnv() {
  const env = {};
  let text = '';
  try {
    text = readFileSync('.env', 'utf8');
  } catch {
    console.error('No .env found. Copy .env.example and set VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.');
    process.exit(2);
  }
  // Split on CRLF as well as LF: `.` does not match `\r`, so `(.*)$` never matches a CRLF line and
  // every key in a Windows-written .env would read as missing. A byte-order mark gets the same
  // treatment, or the first name carries it and stops matching.
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = line.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=(.*)$/);
    if (match) env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  const url = env.VITE_SUPABASE_URL;
  const key = env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error('.env is missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY.');
    process.exit(2);
  }
  return { url, key };
}

const { url, key } = loadEnv();

async function runEngine(engine) {
  const started = Date.now();
  const resp = await fetch(`${url}/functions/v1/web-search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      query: QUERY,
      engines: [engine],
      maxResultsPerEngine: LIMIT,
      compileQueries: false,
    }),
  });
  const body = await resp.json().catch(() => ({}));
  return {
    engine,
    httpStatus: resp.status,
    ms: Date.now() - started,
    status: body.engine_status?.find((entry) => entry.engine === engine)?.status ?? (body.engine_status ? 'absent' : 'undiagnosed'),
    detail: body.engine_status?.find((entry) => entry.engine === engine)?.detail ?? '',
    results: Array.isArray(body.results) ? body.results : [],
    error: body.error ?? null,
  };
}

const outcomes = [];
for (const engine of ENGINES) {
  process.stdout.write(`→ ${engine} … `);
  const outcome = await runEngine(engine);
  console.log(`${outcome.status} (${outcome.results.length} results, ${outcome.ms}ms)`);
  outcomes.push(outcome);
}

const hostOf = (raw) => {
  try {
    return new URL(raw).hostname.replace(/^www\./, '');
  } catch {
    return '?';
  }
};

console.log('\nengine      status         results  domains');
for (const outcome of outcomes) {
  const domains = [...new Set(outcome.results.map((r) => hostOf(r.url)))];
  console.log(
    `${outcome.engine.padEnd(11)} ${String(outcome.status).padEnd(14)} ${String(outcome.results.length).padEnd(8)} ${domains.slice(0, 4).join(', ') || '—'}`,
  );
  for (const result of outcome.results.slice(0, 3)) {
    console.log(`              · ${String(result.title ?? '').slice(0, 74)}  [${hostOf(result.url)}]`);
  }
}

const failures = [];
const missing = outcomes.filter((o) => o.status === 'missing_key');
const undiagnosed = outcomes.some((o) => o.status === 'undiagnosed');

for (const outcome of outcomes) {
  if (outcome.httpStatus !== 200) failures.push(`${outcome.engine}: HTTP ${outcome.httpStatus}${outcome.error ? ` (${outcome.error})` : ''}`);
  else if (outcome.status === 'error') failures.push(`${outcome.engine}: ${outcome.detail || 'engine error'}`);
  else if (outcome.status === 'missing_key') failures.push(`${outcome.engine}: ${outcome.detail || 'secret not set'}`);
  else if (outcome.status === 'undiagnosed') failures.push(`${outcome.engine}: function response has no engine_status; redeploy it`);
  else if (outcome.results.length === 0) failures.push(`${outcome.engine}: ran (${outcome.status}) but returned no results`);
  else if (!outcome.results.every((r) => typeof r.url === 'string' && /^https?:\/\//.test(r.url))) {
    failures.push(`${outcome.engine}: returned a result without a usable URL`);
  }
}

// ── the fusion layer: real engine payloads in, ranked sources out ──────────────
const fusion = (() => {
  // the same portable build the experiment suites use: os.tmpdir() rather than /tmp, and the esbuild
  // that ships with vite run under node rather than `npx`, which cmd.exe cannot spawn
  const mod = tmpPath('fieldwork-fusion.mjs');
  bundle('src/lib/fusion.ts', mod);
  return import(`${asUrl(mod)}?t=${Date.now()}`);
})();

if (!undiagnosed && outcomes.some((o) => o.results.length > 0 && o.status !== 'missing_key')) {
  const { fuseResults } = await fusion;
  const lists = {};
  for (const outcome of outcomes) {
    if (outcome.results.length) lists[outcome.engine] = outcome.results;
  }
  const fused = fuseResults(QUERY, lists, { limit: 20 });
  console.log(`\nfusion: ${Object.keys(lists).join(' + ')} → ${fused.length} sources`);

  if (fused.length === 0) failures.push('fusion: engine results produced no fused sources');
  const urls = fused.map((item) => item.url);
  if (new Set(urls).size !== urls.length) failures.push('fusion: duplicate URLs survived');
  if (!fused.some((item) => (item.engines ?? []).length > 0)) failures.push('fusion: engine attribution missing');

  const attribution = {};
  for (const item of fused) {
    for (const engine of item.engines ?? []) attribution[engine] = (attribution[engine] ?? 0) + 1;
  }
  console.log(`fusion attribution: ${Object.entries(attribution).map(([e, n]) => `${e}=${n}`).join(', ')}`);

  const overlap = fused.filter((item) => (item.engines ?? []).length > 1).length;
  console.log(`fusion corroborated (seen by >1 engine): ${overlap}`);

  if (overlap === 0) {
    console.log('note: no source was returned by both engines — fusion ran, but agreement was not exercised');
  }
}

console.log(`\nquery: "${QUERY}" · ${outcomes.length} engine(s) · slowest ${Math.max(...outcomes.map((o) => o.ms))}ms`);

// a missing secret is a setup step, not a broken engine — say so and exit 2
const onlyMissing = missing.length > 0 && failures.every((f) => missing.some((m) => f.startsWith(`${m.engine}:`)));
if (onlyMissing) {
  console.error('\nNot configured yet:');
  for (const m of missing) console.error(`  · ${m.engine}: ${m.detail || 'secret missing'}`);
  console.error('Set them in Supabase → Edge Functions → Secrets, then run this again.');
  process.exit(2);
}

if (failures.length) {
  console.error('\nFAILED');
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

console.log(`\n✓ ${outcomes.map((o) => o.engine).join(' and ')} returned real results through fusion`);
