/**
 * The per-lane result lists behind one search run.
 *
 * The fused list is what the reader sees, and it cannot be turned back into what the engines
 * offered: identity resolution, agreement merging and the relevance gate all collapse rows, so
 * "which engines returned this page, at what rank" and "which engines returned nothing" are lost the
 * moment fusion runs. Keeping the lanes is what makes two runs comparable at all — the same page
 * from three engines and three engines returning the same page look identical after fusion.
 *
 * Only urls are stored. Titles and snippets are already in `sources` for the rows that survived, and
 * a lane is useful for what it ranked, not for the prose it carried; urls keep a run small enough to
 * keep one per search.
 */
import type { Source } from '../types';
import { canonicalUrl } from './fusion';

export interface LaneResult {
  /** the fusion lane key: an engine id, or `engine·q2` for the second query of a dork batch */
  lane: string;
  /** the engine under the lane, with the batch index removed */
  engine: string;
  /** the query this lane was run for */
  query: string | null;
  /** the ordered canonical urls, exactly as the engine ranked them */
  urls: string[];
}

export interface RunRecord {
  /** the question this run answered */
  query: string;
  kind: 'search' | 'dork';
  /** engines the run asked, including a keyless fallback when it used one */
  engines: string[];
  /** the queries the search really sent, after the compiler rewrote them */
  queries: string[];
  lanes: LaneResult[];
  /** stable across runs with identical lanes, whatever order the lanes answered in */
  lanesHash: string;
}

const LANE_INDEX = /·q(\d+)$/;

/** Build the record for a finished run from the per-lane lists fusion scored. */
export function recordLanes(
  perLane: Record<string, Source[]>,
  options: { query: string; kind: 'search' | 'dork'; engines: string[]; queries: string[] },
): RunRecord {
  const { query, kind, engines, queries } = options;
  const lanes: LaneResult[] = Object.entries(perLane).map(([lane, results]) => {
    const indexed = LANE_INDEX.exec(lane);
    const queryIndex = indexed ? Number(indexed[1]) : 0;
    return {
      lane,
      engine: indexed ? lane.slice(0, -indexed[0].length) : lane,
      // a batch lane names its own query; a plain search lane covers the run's whole query — the
      // compiled list rides along in `queries`, because every engine saw all of it
      query: indexed ? (queries[queryIndex] ?? null) : query,
      urls: results.map((source) => canonicalUrl(source.url)).filter(Boolean),
    };
  });

  return { query, kind, engines, queries, lanes, lanesHash: lanesHash(lanes) };
}

/**
 * A stable fingerprint of the lane lists.
 *
 * Lanes are sorted by key before hashing, so the order engines happened to answer in does not change
 * the fingerprint; the urls inside a lane keep their order, because that order is the engine's
 * ranking and comparing rank is the point. FNV-1a, 64-bit, over the canonical text — the same
 * function in the browser and in the tests.
 */
export function lanesHash(lanes: LaneResult[]): string {
  const canonical = [...lanes]
    .sort((a, b) => a.lane.localeCompare(b.lane))
    .map((lane) => `${lane.lane}\n${lane.urls.join('\n')}`)
    .join('\n\n');

  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= BigInt(canonical.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}
