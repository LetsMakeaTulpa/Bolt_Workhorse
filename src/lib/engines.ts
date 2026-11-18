/**
 * Single catalogue of search engines.
 *
 * `runtime: 'browser'` engines call keyless, CORS-open public APIs directly from the page.
 * `runtime: 'server'` engines run inside the `web-search` edge function; the ones marked
 * `needsSetup` stay silent until their secret (or self-hosted URL) exists there.
 */

import type { EngineStatus } from '../types';

export type EngineRuntime = 'server' | 'browser';
export type EngineGroup = 'Web' | 'Academic' | 'Community' | 'News' | 'Deep web' | 'Dark web' | 'OSINT';

export interface EngineDef {
  id: string;
  label: string;
  group: EngineGroup;
  runtime: EngineRuntime;
  needsSetup?: boolean;
  note?: string;
}

export const ENGINE_CATALOG: EngineDef[] = [
  { id: 'duckduckgo', label: 'DuckDuckGo', group: 'Web', runtime: 'server' },
  { id: 'brave', label: 'Brave', group: 'Web', runtime: 'server' },
  {
    id: 'google',
    label: 'Google',
    group: 'Web',
    runtime: 'server',
    needsSetup: true,
    note: 'Google Programmable Search — needs GOOGLE_API_KEY + GOOGLE_CSE_ID (100 queries/day on the free tier)',
  },
  { id: 'exa', label: 'Exa', group: 'Web', runtime: 'server', needsSetup: true, note: 'Neural/semantic web search — needs EXA_API_KEY' },
  {
    id: 'searxng',
    label: 'SearXNG',
    group: 'Web',
    runtime: 'server',
    needsSetup: true,
    note: 'Meta-search you host or trust — set SEARXNG_URL (JSON API must be enabled)',
  },
  { id: 'tavily', label: 'Tavily', group: 'Web', runtime: 'server', needsSetup: true, note: 'Research-oriented search + extraction — needs TAVILY_API_KEY' },
  { id: 'firecrawl', label: 'Firecrawl', group: 'Web', runtime: 'server', needsSetup: true, note: 'Search and crawl any site to markdown — needs FIRECRAWL_API_KEY' },

  { id: 'arxiv', label: 'arXiv', group: 'Academic', runtime: 'server' },
  { id: 'openalex', label: 'OpenAlex', group: 'Academic', runtime: 'server' },
  { id: 'crossref', label: 'Crossref (DOIs)', group: 'Academic', runtime: 'browser' },
  { id: 'europepmc', label: 'Europe PMC', group: 'Academic', runtime: 'browser', note: 'Biomedical literature and preprints' },

  { id: 'wikipedia', label: 'Wikipedia', group: 'Community', runtime: 'server' },
  { id: 'github', label: 'GitHub', group: 'Community', runtime: 'server' },
  {
    id: 'grepapp',
    label: 'grep.app (code)',
    group: 'Community',
    runtime: 'server',
    needsSetup: true,
    note: 'Code search across public repos — needs GREPAPP_COOKIE or a GREPAPP_BASE_URL mirror; datacenter IPs hit a bot challenge',
  },
  { id: 'hn', label: 'Hacker News', group: 'Community', runtime: 'browser' },
  { id: 'stackexchange', label: 'Stack Overflow', group: 'Community', runtime: 'browser' },
  { id: 'lemmy', label: 'Lemmy', group: 'Community', runtime: 'browser', note: 'Federated, lightly moderated discussion' },
  { id: 'wikidata', label: 'Wikidata', group: 'Community', runtime: 'browser', note: 'Entity graph: people, organisations, events' },
  { id: 'openlibrary', label: 'Open Library', group: 'Community', runtime: 'browser', note: 'Books, editions and authors' },

  { id: 'archiveorg', label: 'Internet Archive', group: 'Deep web', runtime: 'browser', note: 'Archived texts, media and vanished pages' },
  {
    id: 'wayback',
    label: 'Wayback Machine',
    group: 'Deep web',
    runtime: 'server',
    needsSetup: true,
    note: 'How a page looked over time — activated by the updated search function',
  },
  { id: 'gdelt', label: 'GDELT', group: 'News', runtime: 'browser', note: 'Worldwide news coverage from the last three months' },

  {
    id: 'ahmia',
    label: 'Ahmia (onion index)',
    group: 'Dark web',
    runtime: 'server',
    needsSetup: true,
    note: 'Indexes Tor onion services — activated by the updated search function',
  },

  { id: 'crtsh', label: 'crt.sh (CT logs)', group: 'OSINT', runtime: 'browser', note: 'Certificate transparency: subdomains and infrastructure' },
  { id: 'shodan', label: 'Shodan', group: 'OSINT', runtime: 'server', needsSetup: true, note: 'Fingerprinted hosts and services — needs SHODAN_API_KEY' },
  { id: 'urlscan', label: 'urlscan.io', group: 'OSINT', runtime: 'server', needsSetup: true, note: 'Sites as scanned; optional URLSCAN_API_KEY for higher limits' },
];

/**
 * Layers of the web, not engine brands: pick the surfaces a search should cover and the
 * engines underneath them follow. A layer is "on" when all of its engines are selected.
 */
export type Surface = 'surface' | 'deep' | 'dark' | 'code' | 'infra';

export interface SurfaceDef {
  id: Surface;
  label: string;
  hint: string;
  engines: string[];
}

export const SURFACES: SurfaceDef[] = [
  {
    id: 'surface',
    label: 'Surface web',
    hint: 'Indexed clearnet: general engines and communities',
    engines: ['duckduckgo', 'brave', 'google', 'exa', 'searxng', 'tavily', 'firecrawl', 'wikipedia', 'hn', 'stackexchange', 'lemmy', 'wikidata', 'gdelt'],
  },
  {
    id: 'deep',
    label: 'Deep web',
    hint: 'Records, papers and archives that normal indexes miss',
    engines: ['archiveorg', 'wayback', 'openlibrary', 'europepmc', 'openalex', 'crossref', 'arxiv'],
  },
  {
    id: 'dark',
    label: 'Dark web',
    hint: 'Tor onion services, indexed via Ahmia',
    engines: ['ahmia'],
  },
  {
    id: 'code',
    label: 'Code & repos',
    hint: 'Source code across public repositories',
    engines: ['github', 'grepapp'],
  },
  {
    id: 'infra',
    label: 'Infrastructure',
    hint: 'Hosts, certificates and live scans',
    engines: ['shodan', 'urlscan', 'crtsh'],
  },
];

/** Which layers are fully represented by the given engine selection. */
/**
 * Engines that answer with no provider key. A search whose chosen engines return nothing retries
 * on these, so a missing key degrades the ranking instead of blanking the results page.
 */
export const KEYLESS_ENGINES = ['duckduckgo', 'wikipedia', 'arxiv', 'github', 'hn', 'crossref', 'europepmc', 'gdelt'];

/** The keyless engines not already in `selected`, in preference order. */
export function fallbackEnginesFor(selected: string[]): string[] {
  const chosen = new Set(selected);
  return KEYLESS_ENGINES.filter((engine) => !chosen.has(engine));
}

export function activeSurfaces(engines: string[]): Surface[] {
  return SURFACES.filter((surface) => surface.engines.every((engine) => engines.includes(engine))).map(
    (surface) => surface.id,
  );
}

export const ENGINE_GROUPS: EngineGroup[] = [...new Set(ENGINE_CATALOG.map((engine) => engine.group))];

/** One engine that did not simply answer, phrased for a status strip. */
export interface EngineIssue {
  engine: string;
  /** human label from the catalogue, falling back to the id */
  name: string;
  status: string;
  label: string;
  detail: string;
  /** a missing/rejected key is a setup problem; an empty result is just information */
  severity: 'warning' | 'info';
}

export const ENGINE_LABELS = new Map(ENGINE_CATALOG.map((engine) => [engine.id, engine.label]));

const FAILURE_STATUSES = new Set(['missing_key', 'error', 'unknown_engine']);

/** The engine answered, but only after the caller's own key was refused. */
export const KEY_FALLBACK_STATUS = 'key_fallback';

/** Short phrase for a reported status, e.g. `missing_key` → `missing key`. */
export function engineIssueLabel(status: string): string {
  switch (status) {
    case 'missing_key':
      return 'missing key';
    case 'error':
      return 'failed';
    case 'unknown_engine':
      return 'not available';
    case 'empty':
      return 'no results';
    case 'key_fallback':
      return 'your key rejected';
    default:
      return status || 'unknown';
  }
}

/**
 * Turns the function's `engine_status` into something the UI can show. `ok` engines are
 * dropped; everything else explains why the result list is thinner than expected.
 */
export function summarizeEngineStatus(statuses: EngineStatus[] | undefined): EngineIssue[] {
  if (!Array.isArray(statuses)) return [];
  return statuses
    .filter((entry) => entry && typeof entry.engine === 'string' && entry.status !== 'ok')
    .map((entry) => {
      const failure = FAILURE_STATUSES.has(entry.status);
      return {
        engine: entry.engine,
        name: ENGINE_LABELS.get(entry.engine) ?? entry.engine,
        status: entry.status,
        label: engineIssueLabel(entry.status),
        detail: entry.detail || (failure ? engineIssueLabel(entry.status) : `${entry.results ?? 0} results`),
        severity: failure ? ('warning' as const) : ('info' as const),
      };
    });
}

/** Lane runs hit several queries; keep one chip per engine+reason. */
export function mergeEngineIssues(current: EngineIssue[], next: EngineIssue[]): EngineIssue[] {
  const seen = new Set(current.map((issue) => `${issue.engine}:${issue.status}`));
  return [...current, ...next.filter((issue) => !seen.has(`${issue.engine}:${issue.status}`))];
}

export const BROWSER_ENGINE_IDS = new Set(ENGINE_CATALOG.filter((engine) => engine.runtime === 'browser').map((engine) => engine.id));

/**
 * Engines that actually parse dork syntax. The academic and community APIs treat the whole
 * query as plain text, so including them in a dork lane just adds off-topic filler.
 */
export const DORK_ENGINES = new Set(['duckduckgo', 'brave', 'google', 'exa', 'searxng', 'tavily', 'firecrawl', 'ahmia']);

/** Works out of the box today: keyless browser engines plus the deployed server set. */
export const DEFAULT_ENGINES = [
  'duckduckgo',
  // a self-hosted SearXNG is the one general-web engine that needs no paid key: selected by
  // default so configuring SEARXNG_URL is enough to search the open web, and reported as
  // missing_key until it is
  'searxng',
  'wikipedia',
  'arxiv',
  'github',
  'hn',
  'stackexchange',
  'crossref',
  'europepmc',
  'openlibrary',
  'archiveorg',
];

/**
 * One-tap depth presets, phrased as the kind of material you are hunting rather than as engine
 * brands. Each one is just a bundled engine selection, so anything set here can still be tuned
 * engine by engine afterwards.
 */
export interface SearchScope {
  id: string;
  label: string;
  hint: string;
  engines: string[];
}

export const SEARCH_SCOPES: SearchScope[] = [
  {
    id: 'recent',
    label: 'Recent',
    hint: 'Live pages, news and fresh discussion',
    engines: ['duckduckgo', 'brave', 'hn', 'wikipedia', 'stackexchange'],
  },
  {
    id: 'deep',
    label: 'Deep',
    hint: 'Papers, records and books that normal indexes miss',
    engines: ['arxiv', 'openalex', 'crossref', 'europepmc', 'openlibrary'],
  },
  {
    id: 'lost',
    label: 'Lost',
    hint: 'Archived, delisted and forgotten material',
    engines: ['archiveorg', 'openlibrary', 'hn', 'lemmy'],
  },
  {
    id: 'dark',
    label: 'Dark',
    hint: 'Tor onion services, indexed via Ahmia',
    engines: ['ahmia'],
  },
  {
    id: 'all',
    label: 'All',
    hint: 'Every engine that works without a key',
    engines: ENGINE_CATALOG.filter((engine) => !engine.needsSetup).map((engine) => engine.id),
  },
];

/** The scope matching the current selection exactly, or null once the user tunes engines by hand. */
export function matchScope(engines: string[]): string | null {
  const selected = [...new Set(engines)].sort().join(',');
  const scope = SEARCH_SCOPES.find((entry) => [...new Set(entry.engines)].sort().join(',') === selected);
  return scope?.id ?? null;
}
