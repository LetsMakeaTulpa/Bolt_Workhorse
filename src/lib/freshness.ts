/**
 * The date window the answer's sources actually cover.
 *
 * A recency-seeking query is the one case where the panel's dates matter as a whole rather than one
 * at a time: "latest X" answered from 2019 is a different answer from the same prose with a 2026
 * source behind it, and the transcript should be able to say which one it is holding. The window is
 * taken from the dates already stored on the sources, so there is nothing to fetch and nothing to
 * remember: it is a reading of the row.
 *
 * The judgement is deliberately borrowed, not re-made. "Asked for recent material" is the same
 * `queryIntent(...).fresh > 0` at which `recencyWeight` starts moving results at all — a `fresh` of
 * zero is where the ranking ignores dates outright — and "old" is the ranking's own `aging`/`old`
 * tiers, so the receipt cannot disagree with the multiplier that placed the source. An undated source contributes nothing in either direction: the count of
 * them is reported instead, because a recency query answered by undated pages is not fresh evidence,
 * it is no evidence either way, and saying that is the point.
 */
import type { Source } from '../types';
import { queryIntent } from './fusion';
import { recencyBadge } from './rankExplain';



export interface Freshness {
  /** earliest publication date among the sourced answer's pages, `YYYY-MM-DD` */
  oldest: string | null;
  /** latest publication date among them, `YYYY-MM-DD` */
  newest: string | null;
  /** how many pages carried a usable date */
  dated: number;
  /** how many carried none — dated pages are counted, undated ones are not guessed at */
  undated: number;
  /** the query asks for recent material */
  wantsRecent: boolean;
  /** a recency query whose newest page is past the ranking's aging tier, or which has no dates at all */
  stale: boolean;
  /** age of the newest dated page in whole months; null when nothing is dated */
  newestAgeMonths: number | null;
}

/** Whole months between an ISO day and now, counted the way a person counts them. */
function monthsBetween(from: string, at: number): number {
  const start = new Date(Date.parse(from));
  const end = new Date(at);
  let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
  if (end.getUTCDate() < start.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

/** An ISO day, or null. Anything else is "no date" rather than a date to parse hopefully. */
function isoDay(value: string | undefined): string | null {
  const match = (value ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const day = `${match[1]}-${match[2]}-${match[3]}`;
  return Number.isFinite(Date.parse(day)) ? day : null;
}

/** The date window of these sources, and whether it answers the query that asked for it. */
export function freshnessOf(results: Source[], query: string, now = Date.now()): Freshness {
  const dated = results
    .map((source) => isoDay(source.published))
    .filter((day): day is string => day !== null)
    .sort();
  const oldest = dated[0] ?? null;
  const newest = dated[dated.length - 1] ?? null;

  const intent = queryIntent(query, now);
  // any recency signal at all: below this the ranking ignores dates, above it they moved the order
  const wantsRecent = intent.fresh > 0;
  const tier = newest ? recencyBadge(newest, intent, now).tier : null;

  return {
    oldest,
    newest,
    dated: dated.length,
    undated: results.length - dated.length,
    wantsRecent,
    // an answer with no sources at all has its own disclosure; this one is about a sourced answer
    stale: wantsRecent && results.length > 0 && (newest === null || tier === 'aging' || tier === 'old'),
    newestAgeMonths: newest ? monthsBetween(newest, now) : null,
  };
}
