/**
 * Turns the fusion layer's intent model into the two things the Sources panel shows: what the
 * ranking did to this list, and how much a single dated result gained from it.
 *
 * The maths lives here rather than in the component so it can be tested against the same
 * `queryIntent` / `recencyWeight` the ranking actually used — the badge cannot drift from the score.
 */
import { engineWeights, queryIntent, recencyWeight, type QueryIntent } from './fusion';

const DAY = 86_400_000;

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

/**
 * The score multiplier fusion applied to one result, 1 when the date played no part.
 *
 * `forced` is a run that overruled the query's intent — the freshness receipt's control — so the
 * badge reflects the multiplier that run actually applied rather than the one the words earned.
 */
export function freshnessBonus(
  published: string | undefined,
  intent: QueryIntent,
  now = Date.now(),
  forced = false,
): number {
  return 1 + 0.6 * recencyWeight(published, forced ? 1 : intent.fresh, now);
}

export function summaryForQuery(query: string, now = Date.now()): IntentSummary {
  return describeIntent(queryIntent(query, now));
}

/**
 * The Sources panel's order: the fusion score, highest first.
 *
 * A result with no score sinks below every scored one rather than being treated as zero — RRF
 * scores are tiny (0.03 is a good hit), so "absent" and "0.0" are different claims. Equal scores
 * keep the order fusion returned, and the rank is assigned after sorting, so #1 is always the row at
 * the top of the list and the badges on it explain why it is there.
 */
export function rankSources<T extends { relevance_score?: number }>(sources: T[]): (T & { rank: number })[] {
  return sources
    .map((source, index) => ({
      source,
      index,
      score: typeof source.relevance_score === 'number' && Number.isFinite(source.relevance_score)
        ? source.relevance_score
        : -Infinity,
    }))
    .sort((a, b) => (a.score === b.score ? a.index - b.index : b.score - a.score))
    .map((row, position) => ({ ...row.source, rank: position + 1 }));
}

export type RecencyTier = 'fresh' | 'recent' | 'aging' | 'old' | 'undated' | 'ignored';

export interface RecencyBadge {
  tier: RecencyTier;
  /** the exact multiplier fusion applied: 1 when the date played no part */
  multiplier: number;
  /** the publication date as the badge shows it, or null when there is none */
  published: string | null;
  detail: string;
}

/**
 * Why a date did or did not move this result.
 *
 * Tiers mirror the decay steps in `recencyWeight` (30 / 180 / 730 days) so the badge cannot claim
 * "fresh" for something the ranking already treats as old, and `ignored` is a state of its own: a
 * date on a timeless or identifier query is not a small boost, it is no boost, and saying so is the
 * point of the badge.
 */
export function recencyBadge(
  published: string | undefined,
  intent: QueryIntent,
  now = Date.now(),
  forced = false,
): RecencyBadge {
  const multiplier = freshnessBonus(published, intent, now, forced);
  const at = published ? Date.parse(published) : NaN;
  if (!published || !Number.isFinite(at)) {
    return {
      tier: 'undated',
      multiplier: 1,
      published: null,
      detail: 'No publication date, so freshness could not move this result in either direction.',
    };
  }

  const date = published.slice(0, 10);
  const ageDays = Math.max(0, (now - at) / DAY);
  const age = ageDays < 1 ? 'today' : ageDays < 60 ? `${Math.round(ageDays)}d ago` : `${Math.round(ageDays / 30)}mo ago`;

  const tier: RecencyTier = ageDays <= 30 ? 'fresh' : ageDays <= 180 ? 'recent' : ageDays <= 730 ? 'aging' : 'old';
  if (intent.fresh <= 0 && !forced) {
    return {
      tier: 'ignored',
      multiplier: 1,
      published,
      detail: `Published ${date} (${age}). This query is not recency-seeking, so the date did not move the result.`,
    };
  }

  // a forced run is the reader overruling the query's intent, so the badge must not claim the date
  // was ignored: it moved this result by exactly the multiplier shown
  return {
    tier,
    multiplier,
    published,
    detail:
      forced && intent.fresh <= 0
        ? `Published ${date} (${age}) — freshness ×${multiplier.toFixed(2)}, because recency was forced for this run.`
        : `Published ${date} (${age}) — freshness ×${multiplier.toFixed(2)} for a ${intent.fresh >= 1 ? 'recency-seeking' : 'partly recency-seeking'} query.`,
  };
}

export interface IntentBadge {
  /** the engine that supplied this result, without any `+` merge suffixes */
  engine: string;
  /** the query's intent class, as the panel labels it */
  intent: string;
  /** the weight fusion gave this engine */
  weight: number;
  /** the same engine's weight with no intent routing applied */
  base: number;
  delta: number;
  detail: string;
}

/**
 * Why this engine was trusted more or less for this query.
 *
 * The base weight is measured with an empty query, which earns no intent or keyword routing, so
 * `delta` is exactly what the intent model added or took away for this engine.
 */
export function intentBadge(engine: string, query: string, now = Date.now()): IntentBadge | null {
  const primary = String(engine ?? '').split('+')[0].trim();
  if (!primary) return null;
  // the weighted side must be the same call fusion makes, which applies engine character; the base
  // side is an empty query with character disabled, so it carries no routing at all
  const weight = engineWeights(query, now)[primary];
  if (typeof weight !== 'number' || !Number.isFinite(weight)) return null;
  const base = engineWeights('', now, { character: false })[primary] ?? weight;
  const delta = weight - base;
  const intent = describeIntent(queryIntent(query, now));
  return {
    engine: primary,
    intent: intent.label,
    weight,
    base,
    delta,
    detail:
      `${primary} weighted ×${weight.toFixed(2)} against a flat base of ×${base.toFixed(2)} ` +
      `(${delta >= 0 ? '+' : ''}${delta.toFixed(2)}) for this query, which reads as ${intent.label}.`,
  };
}
