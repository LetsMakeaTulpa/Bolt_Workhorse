/**
 * The machine behind an answer, read back out of the row that stored it.
 *
 * A chat with search features should not hide the part that is not chat: which sources were actually
 * opened and read (the function fetches the top pages and hands the model their text, so a "source"
 * can be a page the answer really read or only a snippet it was shown), and which searches the model
 * ran on its own when the first pass was thin. Both are already on the message — `search_results`
 * carries `content` for the pages that were read, `tool_searches` carries the model's own queries —
 * so the transcript can say so without another request, and offer each query as a button the reader
 * can press to run it themselves.
 */
import type { Source } from '../types';

export interface ReadSource {
  /** the citation id the answer uses for this source */
  citation: string;
  title: string;
  url: string;
  /** which extractor read it: a plain fetch, or a Firecrawl render */
  via: string;
}

export interface MachineTrace {
  /** sources whose page text was extracted, in rank order */
  read: ReadSource[];
  /** queries the model ran itself, oldest first, deduplicated */
  extraSearches: string[];
  /** false when the answer used neither page text nor its own search */
  anything: boolean;
}

const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Sources whose page text was actually extracted, in rank order. */
export function readInFull(results: Source[] = []): ReadSource[] {
  return results
    .map((source, index) => ({ source, citation: asText(source.citation_id) || `[${index + 1}]` }))
    .filter(({ source }) => asText(source.content).length > 0)
    .map(({ source, citation }) => ({
      citation,
      title: asText(source.title) || asText(source.url),
      url: asText(source.url),
      via: asText(source.content_source) || 'fetch',
    }));
}

/**
 * The extra queries to show.
 *
 * The column is jsonb, so it can arrive as an array or as the JSON text it was written as; anything
 * else is "none recorded" rather than a guess. Duplicates are dropped case-insensitively: the same
 * query asked twice is one search the reader can run.
 */
export function parseToolSearches(value: unknown): string[] {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return [];
    try {
      raw = JSON.parse(text);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const queries: string[] = [];
  for (const entry of raw) {
    const query = asText(entry).replace(/\s+/g, ' ');
    if (!query) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
  }
  return queries;
}

/** Everything the transcript strip draws, from the stored message alone. */
export function summarizeMachine(message: {
  search_results?: Source[] | null;
  tool_searches?: unknown;
}): MachineTrace {
  const read = readInFull(message.search_results ?? []);
  const extraSearches = parseToolSearches(message.tool_searches);
  return { read, extraSearches, anything: read.length > 0 || extraSearches.length > 0 };
}
