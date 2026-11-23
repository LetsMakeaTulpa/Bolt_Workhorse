/**
 * The model's own search tool, as one function instead of a closure inside App.
 *
 * Two rules define the dork path, and both live here so they can be asserted:
 *
 *  - a dork skips the query compiler. The operator is the request, and rewriting the query would
 *    drop the thing that was asked for.
 *  - a dork only runs on engines that parse operators. A `site:` search sent to arXiv is a
 *    plain-text search that spends a budget slot for nothing.
 *
 * A refusal answers the model in a sentence and never calls the search, so "the engines cannot run
 * this" is reported as itself rather than as an empty run.
 */
import { DORK_ENGINES } from './engines';
import { FOLLOW_UP_CONTENT_CHARS, formatSourceContext } from './sourceContext';
import type { Source, ToolSearchYield } from '../types';

/** Sources of a follow-up search that reach the model; the rest stay in the panel. */
const FOLLOW_UP_SOURCES = 8;

export interface ToolSearchRequest {
  query: string;
  /** the model asked for a dork rather than a plain search */
  dork: boolean;
  searchEnabled: boolean;
  /** the engines this turn selected */
  engines: string[];
  conversationId: string;
  performSearch: (
    query: string,
    conversationId: string,
    options: { keepStreaming?: boolean; compileQueries?: boolean; engines?: string[] },
  ) => Promise<Source[]>;
  /** urls the answer already holds, so "new" means new to the evidence, not new to the run */
  knownUrls: Iterable<string>;
}

export interface ToolSearchOutcome {
  /** how many sources the search returned; 0 for a refusal or an empty run */
  count: number;
  /** the sentence handed back to the model as the tool result */
  text: string;
  /** what this run is recorded as, when a search actually ran */
  yielded?: ToolSearchYield;
  /** sources that went into the prompt, in order */
  offered: Source[];
  /** sources beyond the follow-up cap: in the panel, never prompted */
  capped: Source[];
}

/** A refusal: nothing searched, nothing to record, nothing offered. */
const refused = (text: string): ToolSearchOutcome => ({ count: 0, text, offered: [], capped: [] });

export async function runToolSearch(request: ToolSearchRequest): Promise<ToolSearchOutcome> {
  const { query, dork, searchEnabled, engines, conversationId, performSearch, knownUrls } = request;

  if (!searchEnabled) {
    return refused('Search is switched off for this turn. Answer from what you have.');
  }

  const dorkEngines = dork ? engines.filter((engine) => DORK_ENGINES.has(engine)) : null;
  if (dorkEngines && dorkEngines.length === 0) {
    return refused(
      `No selected engine parses dork operators, so "${query}" would be a plain-text search. Answer with what you already have, or use search_web for a normal query.`,
    );
  }

  const known = new Set(knownUrls);
  const found = await performSearch(query, conversationId, {
    keepStreaming: true,
    compileQueries: !dork,
    ...(dorkEngines ? { engines: dorkEngines } : {}),
  });

  const yielded: ToolSearchYield = {
    query,
    found: found.length,
    added: found.filter((source) => !known.has(source.url)).length,
    // recorded so the strip can tell `search_dorks` apart from `search_web` after a reload
    ...(dork ? { dork: true } : {}),
  };

  if (found.length === 0) {
    return {
      count: 0,
      text: `Search for "${query}" returned no usable sources. Answer with what you already have.`,
      yielded,
      offered: [],
      capped: [],
    };
  }

  // "beyond the cap" is a different omission from "nothing was ever prompted", so the split is
  // returned rather than flattened into one list
  const offered = found.slice(0, FOLLOW_UP_SOURCES);
  const capped = found.slice(FOLLOW_UP_SOURCES);

  return {
    count: found.length,
    yielded,
    offered,
    capped,
    text: `Search results for "${query}":\n\n${formatSourceContext(offered, { contentChars: FOLLOW_UP_CONTENT_CHARS })}`,
  };
}
