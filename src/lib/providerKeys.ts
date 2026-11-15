/**
 * Which secrets the search engines accept, where each one goes, and a parser for the paste box.
 *
 * The function reads these by env-var name, so the UI only ever deals in `NAME=value` lines —
 * no guessing at token shapes, and nothing silently dropped: an unknown name is reported back
 * rather than stored under a key the function will never read.
 */

export interface ProviderKeyDef {
  name: string;
  label: string;
  /** engine id this unlocks, for grouping in the UI */
  engine: string;
  hint: string;
  /** a URL (SearXNG, grep.app mirror) rather than a token */
  url?: boolean;
}

export const PROVIDER_KEYS: ProviderKeyDef[] = [
  { name: 'EXA_API_KEY', label: 'Exa', engine: 'exa', hint: 'Semantic web search — strongest on conceptual queries' },
  { name: 'TAVILY_API_KEY', label: 'Tavily', engine: 'tavily', hint: 'Crawl-backed search with publication dates' },
  { name: 'FIRECRAWL_API_KEY', label: 'Firecrawl', engine: 'firecrawl', hint: 'Search and scrape pages to markdown' },
  { name: 'GOOGLE_API_KEY', label: 'Google API key', engine: 'google', hint: 'Programmable Search — needs the CSE id too' },
  { name: 'GOOGLE_CSE_ID', label: 'Google CSE id', engine: 'google', hint: 'The cx value of your Programmable Search engine' },
  { name: 'SHODAN_API_KEY', label: 'Shodan', engine: 'shodan', hint: 'Fingerprinted hosts and exposed services' },
  { name: 'URLSCAN_API_KEY', label: 'urlscan.io', engine: 'urlscan', hint: 'Optional — raises the anonymous rate limit' },
  { name: 'SEARXNG_URL', label: 'SearXNG URL', engine: 'searxng', hint: 'Comma-separated instance URLs with the JSON API on', url: true },
  { name: 'GREPAPP_COOKIE', label: 'grep.app cookie', engine: 'grepapp', hint: 'Gets past the bot challenge on datacenter IPs' },
];

const BY_NAME = new Map(PROVIDER_KEYS.map((key) => [key.name, key]));

/** Engine ids that stop being silent once the named key is stored. */
export const KEYS_FOR_ENGINE: Record<string, string[]> = {
  google: ['GOOGLE_API_KEY', 'GOOGLE_CSE_ID'],
  exa: ['EXA_API_KEY'],
  tavily: ['TAVILY_API_KEY'],
  firecrawl: ['FIRECRAWL_API_KEY'],
  shodan: ['SHODAN_API_KEY'],
  urlscan: ['URLSCAN_API_KEY'],
  searxng: ['SEARXNG_URL'],
  grepapp: ['GREPAPP_COOKIE'],
};

export interface ParsedKey {
  name: string;
  value: string;
}

export interface ParseResult {
  keys: ParsedKey[];
  /** lines that named something the function does not read */
  rejected: string[];
  /** lines that were structurally wrong (no value, too short, bad URL) */
  invalid: string[];
}

const LINE = /^(?:export\s+)?([A-Za-z][A-Za-z0-9_]{2,63})\s*[=:]\s*(.+)$/;

export function parseProviderKeys(input: string): ParseResult {
  const keys: ParsedKey[] = [];
  const rejected: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const raw of input.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(LINE);
    if (!match) {
      invalid.push(line.length > 40 ? `${line.slice(0, 40)}…` : line);
      continue;
    }

    const name = match[1].toUpperCase();
    const value = match[2].trim().replace(/^["']|["']$/g, '');
    const def = BY_NAME.get(name);
    if (!def) {
      rejected.push(name);
      continue;
    }
    if (value.length < 8) {
      invalid.push(name);
      continue;
    }
    if (def.url && !/^https?:\/\//i.test(value)) {
      invalid.push(name);
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    keys.push({ name, value });
  }

  return { keys, rejected, invalid };
}

/** Human summary of what a paste will do, e.g. "Exa, Tavily". */
export function describeKeys(keys: ParsedKey[]): string {
  return keys.map((key) => BY_NAME.get(key.name)?.label ?? key.name).join(', ');
}
