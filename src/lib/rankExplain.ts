/**
 * Turns the fusion layer's intent model into the two things the Sources panel shows: what the
 * ranking did to this list, and how much a single dated result gained from it.
 *
 * The maths lives here rather than in the component so it can be tested against the same
 * `queryIntent` / `recencyWeight` the ranking actually used — the badge cannot drift from the score.
 */
import { queryIntent, recencyWeight, type QueryIntent } from './fusion';

export interface IntentSummary {
  label: string;
  detail: string;
}

export function describeIntent(intent: QueryIntent): IntentSummary {
  if (intent.navigational >= 0.5) {
    return {
      label: 'exact match',
      detail: 'Identifiers and quoted phrases count more, Exa is damped, dates are ignored.',
    };
  }
  if (intent.fresh >= 0.5) {
    return { label: 'recency-seeking', detail: 'Publication dates earn up to ×1.6 and Tavily is weighted above Exa.' };
  }
  if (intent.evergreen >= 0.5) {
    return { label: 'timeless', detail: 'Freshness is ignored, so older settled sources rank normally.' };
  }
  if (intent.semantic >= 0.5) {
    return { label: 'conceptual', detail: 'Exa is weighted above Tavily and dates do not move results.' };
  }
  return { label: 'mixed', detail: 'No strong signal, so engines are trusted roughly equally.' };
}

/** The score multiplier fusion applied to one result, 1 when the date played no part. */
export function freshnessBonus(published: string | undefined, intent: QueryIntent, now = Date.now()): number {
  return 1 + 0.6 * recencyWeight(published, intent.fresh, now);
}

export function summaryForQuery(query: string, now = Date.now()): IntentSummary {
  return describeIntent(queryIntent(query, now));
}
