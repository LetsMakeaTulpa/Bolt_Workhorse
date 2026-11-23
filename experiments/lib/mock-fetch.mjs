/**
 * A fetch the drift probes can be pointed at, installed before they start:
 *
 *   PROBE_MOCK='{"routes":{"/rest/v1/conversations":[403,{}]},"timeout":["/rest/v1/messages"]}' \
 *   PROBE_MOCK_REPORT=/tmp/seen.json \
 *   node --import ./experiments/lib/mock-fetch.mjs scripts/probe-anon.mjs
 *
 * Routes are keyed by pathname, `*` answers anything unlisted. A path listed under `timeout` rejects
 * at once with a `TimeoutError` — the name the probes classify as "no answer" — so their timeout
 * branch is exercised without waiting out the real 20 s. `PROBE_MOCK_REPORT` receives every request
 * the probe made, with whether it passed an AbortSignal, for the test to assert on.
 */
import { writeFileSync } from 'node:fs';

const spec = JSON.parse(process.env.PROBE_MOCK ?? '{}');
const routes = spec.routes ?? {};
const timeouts = spec.timeout ?? [];
const seen = [];

globalThis.fetch = async (input, init = {}) => {
  const path = new URL(String(input)).pathname;
  seen.push({ path, signal: Boolean(init?.signal) });

  if (timeouts.some((prefix) => path.startsWith(prefix))) {
    const error = new Error('The operation was aborted due to timeout');
    error.name = 'TimeoutError';
    throw error;
  }

  const [status, body] = routes[path] ?? routes['*'] ?? [401, {}];
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
};

if (process.env.PROBE_MOCK_REPORT) {
  process.on('exit', () => writeFileSync(process.env.PROBE_MOCK_REPORT, JSON.stringify(seen)));
}
