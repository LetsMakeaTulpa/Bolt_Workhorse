import { ENGINE_CATALOG, type EngineIssue } from './engines';
import { KEYS_FOR_ENGINE } from './providerKeys';

/**
 * Whether a search engine is actually usable before a search is run.
 *
 * The browser can only know two things: which key names this account has stored, and what the
 * function reported the last time it ran. Deployment-level secrets are invisible from here, so an
 * engine with no personal key is *unknown*, not broken — claiming it is broken would be a lie the
 * client cannot back up.
 */
export type KeyState =
  | 'keyless' // never needs a key
  | 'ready' // every required name stored by this account
  | 'deployment' // nothing stored here, but the deployment holds every required name
  | 'partial' // some stored (Google needs both a key and a CSE id)
  | 'unused' // all stored, yet the function still reported missing_key
  | 'rejected' // stored, but the provider refused it and the deployment key answered
  | 'missing' // the function reported missing_key and nothing is stored
  | 'optional' // works anonymously; a key only raises a limit
  | 'unknown'; // nothing stored, no failure seen — the deployment may supply it

export interface EngineKeyStatus {
  engine: string;
  label: string;
  state: KeyState;
  /** short badge text for the composer row */
  text: string;
  /** full sentence for the tooltip */
  detail: string;
  required: string[];
  stored: string[];
}

/** Engines that work without a key and only gain a higher rate limit from one. */
const OPTIONAL_ENGINES = new Set(['urlscan']);

/**
 * One engine's key status. `stored` holds secret *names* this account saved, never values;
 * `issues` is the last run's status strip, which is the only evidence about deployment secrets.
 */
export function engineKeyStatus(
  engineId: string,
  stored: Set<string>,
  issues: EngineIssue[] = [],
  /** secret names the deployment reported holding; null when it could not be asked */
  deployment: Set<string> | null = null,
): EngineKeyStatus | null {
  const def = ENGINE_CATALOG.find((engine) => engine.id === engineId);
  if (!def) return null;

  const required = KEYS_FOR_ENGINE[engineId] ?? [];
  const kept = required.filter((name) => stored.has(name));
  const missing = required.filter((name) => !stored.has(name));
  const failedKey = issues.some((issue) => issue.engine === engineId && issue.status === 'missing_key');
  const rejectedKey = issues.some((issue) => issue.engine === engineId && issue.status === 'key_fallback');
  const base = { engine: engineId, label: def.label, required, stored: kept };

  if (required.length === 0) {
    return { ...base, state: 'keyless', text: 'keyless', detail: 'No key required — this engine calls an open API.' };
  }
  if (missing.length === 0) {
    if (rejectedKey) {
      return {
        ...base,
        state: 'rejected',
        text: 'rejected',
        detail: `The provider refused your ${required.join(' + ')} on the last run, which carried on with the deployment's own key. Replace the key in Settings.`,
      };
    }
    if (failedKey) {
      return {
        ...base,
        state: 'unused',
        text: 'saved, not seen',
        detail: `Your ${required.join(' + ')} is saved, but the function still reports a missing key. It may not be redeployed since the key was stored.`,
      };
    }
    return { ...base, state: 'ready', text: 'your key', detail: `Using your ${required.join(' + ')}.` };
  }
  // the deployment's own secrets are a fact now, not a guess: nothing personal stored still means
  // the engine answers
  if (deployment && required.every((name) => deployment.has(name))) {
    return {
      ...base,
      state: 'deployment',
      text: 'deployment key',
      detail: `This deployment holds ${required.join(' + ')}, so this engine answers with it rather than with a personal key${kept.length > 0 ? ' (yours is saved too)' : ''}.`,
    };
  }
  if (kept.length > 0) {
    return {
      ...base,
      state: 'partial',
      text: `needs ${missing.join(' + ')}`,
      detail: `${kept.join(' + ')} is saved; this engine also needs ${missing.join(' + ')}.`,
    };
  }
  if (OPTIONAL_ENGINES.has(engineId)) {
    return { ...base, state: 'optional', text: 'anonymous', detail: `Works without a key; ${required.join(' + ')} only raises the rate limit.` };
  }
  if (failedKey) {
    return { ...base, state: 'missing', text: 'missing key', detail: `The last run reported ${required.join(' + ')} missing. Add it in Settings, or deselect this engine.` };
  }
  return {
    ...base,
    state: 'unknown',
    text: 'no personal key',
    detail: `No ${required.join(' + ')} stored here. The deployment may supply one; if it does not, this engine reports a missing key after the run.`,
  };
}

/** Statuses for a list of selected engines, in the order they were selected. */
export function engineKeyRow(
  engines: string[],
  stored: Set<string>,
  issues: EngineIssue[] = [],
  deployment: Set<string> | null = null,
): EngineKeyStatus[] {
  return engines
    .map((engine) => engineKeyStatus(engine, stored, issues, deployment))
    .filter((status): status is EngineKeyStatus => status !== null);
}
