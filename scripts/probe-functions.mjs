#!/usr/bin/env node
/**
 * A cheap anon-key GET per deployed function.
 *
 * The schema probe cannot see this: a function deployed months ago and one deployed tonight both
 * answer 200 from the gateway until asked for something specific. `web-search` answered every request
 * with a 500 through a whole audit — and again during preview — while every schema check stayed green.
 *
 *   npm run functions:check
 *
 *   web-search        {configured: [...]}          the engine secret names the deployment holds
 *   llm-proxy/models  {models, default_model}      the list the model picker is built from; it costs
 *                     one upstream request, so 429 (our budget) and 503 (no model key) are blind
 *                     spots rather than staleness — redeploying would not fix either
 *
 * Exit: 0 every assertion held · 1 the deployed build answered wrongly · 2 could not reach a verdict
 * (see scripts/probeExit.mjs).
 */
import { TIMEOUT_MS, exitWhenDone, missingCredentials, verdict } from './probeExit.mjs';
import { anonKey, projectRef, url } from './supabaseEnv.mjs';

let failures = 0;
let blind = 0;

const snippet = (value) => JSON.stringify(value).slice(0, 140);

function record(what, ok, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
}

function cannotJudge(what, detail) {
  blind++;
  console.log(`  ????  ${what} — ${detail}`);
}

/** The contract is names only; a value here would be a secret escaping the function. */
const isSecretName = (name) => typeof name === 'string' && /^[A-Z][A-Z0-9_]*$/.test(name);

async function get(path) {
  try {
    const response = await fetch(`${url}${path}`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function probeWebSearch() {
  const answer = await get('/functions/v1/web-search');
  if (answer.error) return record('GET web-search answered', false, answer.error);

  record('GET web-search answered 200', answer.status === 200, `HTTP ${answer.status}`);
  const configured = answer.body?.configured;
  record('it reported its engine status', Array.isArray(configured), snippet(answer.body));
  if (Array.isArray(configured)) {
    const notNames = configured.filter((name) => !isSecretName(name));
    record('the status holds names, never values', notNames.length === 0, snippet(notNames));
  }
}

async function probeLlmProxy() {
  const answer = await get('/functions/v1/llm-proxy/models');
  if (answer.error) return record('GET llm-proxy/models answered', false, answer.error);

  // The environment talking, not the build: neither status improves by redeploying.
  if (answer.status === 429 || answer.status === 503) {
    return cannotJudge('GET llm-proxy/models', `HTTP ${answer.status} (${snippet(answer.body?.error ?? null)})`);
  }

  record('GET llm-proxy/models answered 200', answer.status === 200, `HTTP ${answer.status}`);
  const models = answer.body?.models;
  record(
    'it listed the models the picker needs',
    Array.isArray(models) && models.length > 0,
    Array.isArray(models) ? `${models.length} models` : snippet(answer.body),
  );
  if (Array.isArray(models)) {
    const malformed = models.filter((model) => typeof model?.id !== 'string' || model.id === '');
    record('every model has an id', malformed.length === 0, `${malformed.length} without one`);
  }
  record('it named a default model', typeof answer.body?.default_model === 'string' && answer.body.default_model !== '');
}

async function main() {
  if (missingCredentials('the deployed functions')) return 2;

  console.log(`Hosted project: ${projectRef}`);
  await probeWebSearch();
  await probeLlmProxy();

  if (failures > 0) {
    console.error(
      `\n${failures} assertion${failures === 1 ? '' : 's'} failed: the deployed build is behind the repository. Redeploy with \`npx --yes supabase@2.39.2 functions deploy web-search --project-ref ${projectRef}\` (and \`… functions deploy llm-proxy …\`), then re-run this check. DEPLOY.md §4.`,
    );
  }
  if (blind > 0) {
    console.error(`\n${blind} probe${blind === 1 ? '' : 's'} could not reach a verdict — a probe that did not run is not a pass.`);
  }
  if (failures === 0 && blind === 0) console.log('\nBoth deployed functions answer with the shape this repository expects.');
  return verdict({ failed: failures > 0, blind: blind > 0 });
}

exitWhenDone(main);
