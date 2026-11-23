/**
 * Turns the fusion layer's intent model into the two things the Sources panel shows: what the
 * ranking did to this list, and how much a single dated result gained from it.
 *
 * The maths lives here rather than in the component so it can be tested against the same
 * `queryIntent` / `recencyWeight` the ranking actually used — the badge cannot drift from the score.
 */
import { engineWeights, queryIntent, recencyWeight, type QueryIntent } from './fusion';
import type { ScoreTerms } from '../types';

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

  // A forced run is the reader overruling the query's own weighting, so the badge must not claim
  // the date was ignored or that the intent alone set the multiplier: on a question that is itself
  // recency-seeking, the ×1.21 is still there because someone pressed Search recent, and that is
  // the one fact the badge exists to explain.
  return {
    tier,
    multiplier,
    published,
    detail: forced
      ? `Published ${date} (${age}) — freshness ×${multiplier.toFixed(2)}, because recency was forced for this run.`
      : `Published ${date} (${age}) — freshness ×${multiplier.toFixed(2)} for a ${intent.fresh >= 1 ? 'recency-seeking' : 'partly recency-seeking'} query.`,
  };
}

/**
 * The stored score breakdown, if this row has one.
 *
 * Rows saved before fusion recorded its terms carry only the total. This returns null for those
 * rather than rebuilding components from memory: an explanation invented around a total would be
 * worse than admitting the components were never recorded.
 */
export function readScoreTerms(metadata: Record<string, unknown> | null | undefined): ScoreTerms | null {
  const raw = metadata?.score_terms;
  if (!raw || typeof raw !== 'object') return null;
  const terms = raw as Record<string, unknown>;
  if (typeof terms.engine !== 'string' || typeof terms.lane !== 'string') return null;
  const numeric = [
    'weight',
    'rank',
    'k',
    'rankTerm',
    'coverage',
    'exponent',
    'freshness',
    'freshnessMultiplier',
    'agreement',
    'agreementMultiplier',
    'merged',
    'mergeMultiplier',
    'score',
  ];
  if (!numeric.every((key) => typeof terms[key] === 'number' && Number.isFinite(terms[key] as number))) return null;
  return terms as unknown as ScoreTerms;
}

/** One line of the breakdown: what the term is, its value, and the sentence behind it. */
export interface ScoreTermRow {
  label: string;
  value: string;
  detail: string;
}

/**
 * The score's components as the card lists them, in the order they multiplied.
 *
 * The arithmetic is shown, not just the factors: "1.20 ÷ 62" and "0.86^1.5" let a reader reproduce
 * the final number, which is the difference between an explanation and a decoration.
 */
export function scoreTermRows(terms: ScoreTerms): ScoreTermRow[] {
  const rows: ScoreTermRow[] = [
    {
      label: 'Engine weight',
      value: `×${terms.weight.toFixed(2)}`,
      detail: `${terms.engine} was trusted ×${terms.weight.toFixed(2)} for this question${terms.lane === terms.engine ? '' : ` (lane ${terms.lane})`}`,
    },
    {
      label: 'Rank term',
      value: `${terms.weight.toFixed(2)} ÷ ${terms.k + terms.rank + 1}`,
      detail: `rank #${terms.rank + 1} in ${terms.lane}: ${terms.weight.toFixed(2)} ÷ (${terms.k} + ${terms.rank} + 1) = ${terms.rankTerm.toFixed(4)}`,
    },
    {
      label: 'Term coverage',
      value: `${terms.coverage.toFixed(2)}^${terms.exponent} = ${(terms.coverage ** terms.exponent).toFixed(3)}`,
      detail: 'IDF-weighted share of the question that this result’s title and snippet actually contain',
    },
    {
      label: 'Freshness',
      value: `×${terms.freshnessMultiplier.toFixed(2)}`,
      detail:
        terms.freshness > 0
          ? `the date earned a ${terms.freshness.toFixed(2)} freshness weight, lifted to ×${terms.freshnessMultiplier.toFixed(2)}`
          : 'no date, or a question that is not recency-seeking, so the date added nothing',
    },
    {
      label: 'Agreement',
      value: `×${terms.agreementMultiplier.toFixed(2)}`,
      detail: `${terms.agreement} engine${terms.agreement === 1 ? '' : 's'} returned this page (the bonus stops at three)`,
    },
  ];
  if (terms.merged > 1) {
    rows.push({
      label: 'Merged results',
      value: `×${terms.mergeMultiplier.toFixed(2)}`,
      detail: `${terms.merged} results resolved to this one page`,
    });
  }
  rows.push({
    label: 'Final score',
    value: terms.score.toFixed(4),
    detail: 'the product of the terms above — the number this list is sorted by',
  });
  return rows;
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
