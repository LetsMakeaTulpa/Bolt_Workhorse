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
  /** how many fused sources the prompt carried; null when the row predates the mark */
  given: number | null;
  /** how many fused sources the answer has in total — the panel lists all of them */
  shown: number;
  /** fused sources that never reached the model, so nobody can say it ignored them */
  panelOnly: number;
  /** false when there is nothing to disclose: no page text, no extra search, nothing withheld */
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

/**
 * The sources the prompt actually carried.
 *
 * The presence of any mark is what says the row records a verdict; the marks themselves then decide.
 * Keying on the *presence* rather than on finding at least one `true` matters: a row whose sources
 * are all marked false carried none of them to the model, and falling back to "all sources" there
 * would credit the answer with evidence it never read. A row with no marks at all predates the
 * record, so every source is the only honest reading.
 */
export function usedSources(message: { search_results?: Source[] | null }): Source[] {
  const results = message.search_results ?? [];
  const marked = results.some((source) => typeof source.in_prompt === 'boolean');
  return marked ? results.filter((source) => source.in_prompt === true) : results;
}

/**
 * url → whether the prompt carried that source, from the rows that recorded a verdict.
 *
 * The Sources panel lists rows saved by the search, which runs before the prompt is built and so
 * cannot know what the prompt carried. The verdict lives on the answer saved afterwards, which is
 * why the panel reads it from the messages. The newest turn wins: the panel is showing the latest
 * answer's evidence. A url no row marked is absent — unknown, not "never shown".
 */
export function promptCoverage(messages: { search_results?: Source[] | null }[]): Map<string, boolean> {
  const coverage = new Map<string, boolean>();
  for (const message of messages) {
    for (const source of message.search_results ?? []) {
      if (typeof source.in_prompt === 'boolean' && source.url) coverage.set(source.url, source.in_prompt);
    }
  }
  return coverage;
}

/** Everything the transcript strip draws, from the stored message alone. */
export function summarizeMachine(message: {
  search_results?: Source[] | null;
  tool_searches?: unknown;
}): MachineTrace {
  const results = message.search_results ?? [];
  const read = readInFull(results);
  const extraSearches = parseToolSearches(message.tool_searches);
  // a row written before the mark carries no verdict: unknown, not "never shown"
  const marked = results.filter((source) => typeof source.in_prompt === 'boolean');
  const given = marked.length === 0 ? null : marked.filter((source) => source.in_prompt).length;
  const shown = results.length;
  const panelOnly = given === null ? 0 : Math.max(0, shown - given);
  return {
    read,
    extraSearches,
    given,
    shown,
    panelOnly,
    anything: read.length > 0 || extraSearches.length > 0 || panelOnly > 0,
  };
}
