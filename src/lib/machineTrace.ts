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
import type { PromptCoverage, PromptReason, Source } from '../types';
import { pageTextForPrompt, PROMPT_CONTENT_CHARS } from './sourceContext';

export interface ReadSource {
  /** the citation id the answer uses for this source */
  citation: string;
  title: string;
  url: string;
  /** which extractor read it: a plain fetch, or a Firecrawl render */
  via: string;
  /** the page text exactly as this turn's prompt carried it, cap and all */
  text: string;
  /** characters of page text the prompt carried — the length the model actually read */
  given: number;
  /** characters the stored row holds for this page, which may be more than was given */
  stored: number;
}

export interface MachineTrace {
  /** sources whose page text was extracted, in rank order */
  read: ReadSource[];
  /** queries the model ran itself, oldest first, deduplicated */
  extraSearches: string[];
  /** query → what that search brought in, for the turns that recorded it */
  searchYields: Record<string, { found: number; added: number; dork?: boolean }>;
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

/**
 * Sources whose page text was actually extracted, in rank order, with the text the prompt carried.
 *
 * The cap is the one the prompt applies, read back from the row when the turn recorded it and
 * otherwise the prompt's standard budget: showing more than the model read would let a figure the
 * model never saw look supported, which is the one thing this strip exists to prevent.
 */
export function readInFull(results: Source[] = [], defaultChars: number = PROMPT_CONTENT_CHARS): ReadSource[] {
  return results
    .map((source, index) => ({ source, citation: asText(source.citation_id) || `[${index + 1}]` }))
    .filter(({ source }) => asText(source.content).length > 0)
    .map(({ source, citation }) => {
      const cap =
        typeof source.prompt_chars === 'number' && source.prompt_chars > 0 ? source.prompt_chars : defaultChars;
      const text = pageTextForPrompt(source, cap);
      return {
        citation,
        title: asText(source.title) || asText(source.url),
        url: asText(source.url),
        via: asText(source.content_source) || 'fetch',
        text,
        given: text.length,
        stored: asText(source.content).length,
      };
    });
}

/**
 * A list of queries stored as jsonb: the compiler's output, or the model's own extra searches.
 *
 * The column can arrive as an array or as the JSON text it was written as; anything else is "none
 * recorded" rather than a guess. Duplicates are dropped case-insensitively: the same query asked
 * twice is one search the reader can run.
 */
export function parseQueries(value: unknown): string[] {
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
 * url → whether the prompt carried that source and why, from the rows that recorded a verdict.
 *
 * The Sources panel lists rows saved by the search, which runs before the prompt is built and so
 * cannot know what the prompt carried. The verdict lives on the answer saved afterwards, which is
 * why the panel reads it from the messages. The newest turn wins: the panel is showing the latest
 * answer's evidence. A url no row marked is absent — unknown, not "never shown". A row that has only
 * the boolean keeps its verdict with no reason: the cause was never recorded, so none is invented.
 */
export function promptCoverage(messages: { search_results?: Source[] | null }[]): Map<string, PromptCoverage> {
  const coverage = new Map<string, PromptCoverage>();
  for (const message of messages) {
    for (const source of message.search_results ?? []) {
      if (!source.url) continue;
      if (source.prompt_reason) {
        const reason = source.prompt_reason;
        coverage.set(source.url, { inPrompt: reason === 'given' || reason === 'trimmed', reason });
      } else if (typeof source.in_prompt === 'boolean') {
        coverage.set(source.url, { inPrompt: source.in_prompt, reason: null });
      }
    }
  }
  return coverage;
}

/** Everything the transcript strip draws, from the stored message alone. */
/**
 * What each extra search added, keyed by its query.
 *
 * A repeated query keeps its newest record: the strip shows the most recent run's yield, which is
 * the one the chip would re-run. Rows written before the yields were recorded yield nothing, and
 * the chip then says only what it always said rather than inventing a count.
 */
/**
 * The model's own search that produced a stored row, when one did.
 *
 * A source row records the query that returned it. When that query is one the model ran itself —
 * not the question on screen and not a dork lane — the panel can name the search behind the row,
 * instead of leaving its origin to the chip strip under the answer.
 */
export function modelSearchOrigin(
  originalQuery: string | null | undefined,
  modelSearches: Iterable<string>,
): string | null {
  const query = String(originalQuery ?? '').trim();
  if (!query) return null;
  for (const search of modelSearches) if (search === query) return query;
  return null;
}

export function parseSearchYields(value: unknown): Record<string, { found: number; added: number; dork?: boolean }> {
  const yields: Record<string, { found: number; added: number; dork?: boolean }> = {};
  if (!Array.isArray(value)) return yields;
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as { query?: unknown; found?: unknown; added?: unknown; dork?: unknown };
    const query = asText(record.query);
    const found = Number(record.found);
    const added = Number(record.added);
    if (!query || !Number.isFinite(found) || !Number.isFinite(added)) continue;
    // a row saved before the flag existed reads as a plain search, which is what it looked like
    yields[query] = { found, added, ...(record.dork === true ? { dork: true } : {}) };
  }
  return yields;
}

export function summarizeMachine(message: {
  search_results?: Source[] | null;
  tool_searches?: unknown;
  tool_search_yields?: unknown;
}): MachineTrace {
  const results = message.search_results ?? [];
  const read = readInFull(results);
  const extraSearches = parseQueries(message.tool_searches);
  const searchYields = parseSearchYields(message.tool_search_yields);
  // a row written before the mark carries no verdict: unknown, not "never shown"
  const marked = results.filter((source) => typeof source.in_prompt === 'boolean');
  const given = marked.length === 0 ? null : marked.filter((source) => source.in_prompt).length;
  const shown = results.length;
  const panelOnly = given === null ? 0 : Math.max(0, shown - given);
  return {
    read,
    extraSearches,
    searchYields,
    given,
    shown,
    panelOnly,
    anything: read.length > 0 || extraSearches.length > 0 || panelOnly > 0,
  };
}

/** One source as the prompt met it, with how much of the page it carried. */
export interface PromptSource {
  citation: string;
  title: string;
  url: string;
  /** characters of page text the prompt carried; 0 for a source that came back as a snippet */
  carried: number;
  /** characters the stored row holds, which may be more than the prompt carried */
  stored: number;
  /** true when the page ran past the cap: the model read only its opening */
  truncated: boolean;
  /** the extractor that read the page, or '' when it came back as a snippet */
  via: string;
  /** why the prompt carried it, or why it did not; null when the row recorded no verdict */
  reason: PromptReason | null;
  /** the page text exactly as the prompt carried it; '' when nothing was carried */
  text: string;
}

/** What one answer's prompt actually put in front of the model. */
export interface PromptView {
  /** the queries the search sent, in order — the compiler's rewrite of the question */
  asked: string[];
  /** sources the prompt carried, in the order the model met them */
  carried: PromptSource[];
  /** fused sources the prompt never carried, in rank order */
  leftOut: PromptSource[];
  /** false on a row that recorded no verdict: neither list is a claim about the prompt there */
  coverageRecorded: boolean;
  /** page characters the prompt carried in total */
  characters: number;
  /** carried pages that were cut at the cap */
  truncated: number;
  /** true when there is anything to show */
  anything: boolean;
}

/** Which side of the prompt a source is on, or null when the row never recorded a verdict. */
function coverageOf(source: Source): boolean | null {
  if (source.prompt_reason) return source.prompt_reason === 'given' || source.prompt_reason === 'trimmed';
  return typeof source.in_prompt === 'boolean' ? source.in_prompt : null;
}

/**
 * Read the prompt back out of the answer: what was asked, what was carried, and what was left out.
 *
 * The stored `search_results` are already in prompt order — the fused list, then whatever follow-up
 * searches appended — so filtering them is the order the model met them, with no ranking of its own.
 * The page text is sliced by the same cap the prompt used, because showing a longer page here would
 * let a figure the model never read look carried. A row saved before the verdict existed records no
 * omission: everything is listed, and the view says the coverage is unknown rather than inventing
 * sources the model never saw.
 */
export function promptView(message: {
  search_results?: Source[] | null;
  queries_used?: unknown;
}): PromptView {
  const results = message.search_results ?? [];
  const coverageRecorded = results.some((source) => coverageOf(source) !== null);
  const asked = parseQueries(message.queries_used);
  const carried: PromptSource[] = [];
  const leftOut: PromptSource[] = [];

  results.forEach((source, index) => {
    const citation = asText(source.citation_id) || `[${index + 1}]`;
    const stored = asText(source.content).length;
    const reason = source.prompt_reason ?? null;
    const coverage = coverageOf(source);
    // a row written before the mark has no omission to report: the stored sources are the only reading
    const inPrompt = coverage === null ? !coverageRecorded : coverage;
    const shared = {
      citation,
      title: asText(source.title) || asText(source.url),
      url: asText(source.url),
      stored,
      via: asText(source.content_source),
      reason,
    };

    if (!inPrompt) {
      leftOut.push({ ...shared, carried: 0, truncated: false, text: '' });
      return;
    }

    const cap =
      typeof source.prompt_chars === 'number' && source.prompt_chars > 0 ? source.prompt_chars : PROMPT_CONTENT_CHARS;
    const text = pageTextForPrompt(source, cap);
    carried.push({
      ...shared,
      carried: text.length,
      truncated: text.length > 0 && stored > text.length,
      text,
    });
  });

  const characters = carried.reduce((sum, entry) => sum + entry.carried, 0);
  return {
    asked,
    carried,
    leftOut,
    coverageRecorded,
    characters,
    truncated: carried.filter((entry) => entry.truncated).length,
    anything: carried.length > 0 || leftOut.length > 0,
  };
}
