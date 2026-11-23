#!/usr/bin/env node
/**
 * The private tables, asked for with the public anon key — the way anyone holding the site's own key
 * would ask.
 *
 * The local RLS suite stays green while the hosted project is world-readable, because it tests the
 * schema the migrations *would* build. Nothing else asks the deployed project the only question that
 * matters: can a stranger read this? Two migrations close it — `20261115120000` locks `app_config`
 * (which holds the model key), `20261115140000` revokes anon on the per-account tables — and this
 * stays green only while no later migration or policy hands the grant back.
 *
 *   npm run rls:check
 *
 * Exit: 0 every private table refused anon · 1 one answered it · 2 could not reach a verdict (see
 * scripts/probeExit.mjs). Row contents are never printed: only statuses and counts.
 */
import { TIMEOUT_MS, exitWhenDone, missingCredentials, verdict } from './probeExit.mjs';
import { anonKey, projectRef, url } from './supabaseEnv.mjs';

/**
 * Tables that must never answer an anonymous caller: per-account content plus the two server-side
 * ones (`app_config` holds the model key, `request_rate_limits` the spend counters).
 *
 * Deliberately absent: `research_presets` and `search_settings` are reference data granted to anon,
 * and `app_config_public` is the view built to be readable. That is what the control asks for.
 */
const PRIVATE = [
  'conversations',
  'messages',
  'sources',
  'findings',
  'evidence',
  'activity_logs',
  'research_projects',
  'user_engine_keys',
  'search_runs',
  'request_rate_limits',
  'app_config',
];

/** A table anon is *supposed* to read: if this fails, the key is wrong and no verdict below counts. */
const CONTROL = 'research_presets';

async function ask(table) {
  try {
    const response = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, rows: Array.isArray(body) ? body.length : null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  if (missingCredentials('anon exposure')) return 2;

  console.log(`Hosted project: ${projectRef}`);

  const control = await ask(CONTROL);
  if (control.error || control.status !== 200) {
    console.log(
      `  ????  control ${CONTROL} answered ${control.error ?? `HTTP ${control.status}`}, but anon is granted SELECT on it — a key or project problem, not a privacy verdict`,
    );
    return 2;
  }
  console.log(`  ok    control ${CONTROL} is readable with the anon key, as intended`);

  const exposed = [];
  const blind = [];

  for (const table of PRIVATE) {
    const answer = await ask(table);
    if (answer.status === 401 || answer.status === 403) {
      console.log(`  ok    ${table} refused anon (HTTP ${answer.status})`);
    } else if (answer.status === 404) {
      // not deployed yet: a table that does not exist cannot leak, and the schema probe reports it,
      // so a green run here must not be read as "proven private"
      console.log(`  skip  ${table} is not in the hosted schema yet`);
    } else if (answer.status === 200) {
      const detail =
        answer.rows === null
          ? 'answered 200 with something that is not a row list'
          : answer.rows === 0
            ? 'anon was granted SELECT — 0 rows today, which is not the same as unreachable'
            : `anon read ${answer.rows}${answer.rows === 1 ? ' row' : ' rows'}`;
      console.log(`  FAIL  ${table} answered anon — ${detail}`);
      exposed.push(table);
    } else {
      console.log(`  ????  ${table} answered ${answer.error ?? `HTTP ${answer.status}`}, which proves neither exposure nor refusal`);
      blind.push(table);
    }
  }

  if (exposed.length > 0) {
    // Named as a pair on purpose: applying only 20261115140000 leaves app_config readable, and that
    // table holds a provider key rather than rows of someone's research.
    console.error(
      `\n${exposed.length} private table${exposed.length === 1 ? '' : 's'} readable with the anon key: ${exposed.join(', ')}. Apply the pending migrations (DEPLOY.md §3): 20261115140000_add_user_auth_rls.sql revokes anon on the per-account tables, 20261115120000_lock_app_config_service_role.sql locks app_config. Until then the hosted project serves this data — and that key — to anyone holding the site's own anon key.`,
    );
  }
  if (blind.length > 0) {
    console.error(`\n${blind.length} table${blind.length === 1 ? '' : 's'} could not be judged: ${blind.join(', ')}.`);
  }
  if (exposed.length === 0 && blind.length === 0) {
    console.log(`\nAll ${PRIVATE.length} private tables refuse the public anon key.`);
  }
  return verdict({ failed: exposed.length > 0, blind: blind.length > 0 });
}

exitWhenDone(main);
