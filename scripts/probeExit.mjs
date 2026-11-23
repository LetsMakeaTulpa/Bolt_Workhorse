/**
 * One verdict for every drift probe, so the four callers cannot drift apart the way the project can.
 *
 *   0  every assertion held
 *   1  the hosted project answered wrongly — a finding
 *   2  the probe could not reach a verdict: no credentials, an environment answer (rate limit, no
 *      model key), or a migration whose SQL the reader cannot name
 *
 * 2 outranks 1. A run that only partly looked must not read as a plain finding, because "1, apply
 * your migrations" is advice someone will follow while the gate is still blind somewhere else.
 */
import { anonKey, url } from './supabaseEnv.mjs';

export const OK = 0;
export const FAILED = 1;
export const BLIND = 2;

/** Every probe request gives up here. A gate that never finishes reports nothing at all. */
export const TIMEOUT_MS = 20_000;

export function verdict({ failed, blind }) {
  if (blind) return BLIND;
  return failed ? FAILED : OK;
}

/** Without both public values there is nothing to ask. Says so and returns true. */
export function missingCredentials(what) {
  if (url && anonKey) return false;
  console.log(`No VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in .env or the environment — cannot probe ${what}.`);
  return true;
}

/** One footer for all probes, so a thrown error can never exit 0. */
export function exitWhenDone(main) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`\n${error instanceof Error ? error.message : error}`);
      process.exit(FAILED);
    });
}
