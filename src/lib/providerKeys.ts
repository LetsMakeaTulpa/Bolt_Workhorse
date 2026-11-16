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

/**
 * People number their keys (`EXA_API_KEY_1`, `TAVILY_API_KEY_2`) when they have several. The number
 * is part of the stored name, not an alias for it: a second Exa key is a spare the function rotates
 * to, so folding it onto the base name would overwrite the first one.
 */
const NUMBERED = /^(.+)_(\d{1,3})$/;

/**
 * The secret definition a pasted name belongs to, and the name it is stored under — always as typed.
 *
 * Numbering is only understood when the base is a real secret, so `EXA_KEY_1` is still reported as
 * unreadable instead of being guessed at — the same rule as any other unknown name.
 */
function resolveName(name: string): { name: string; def: ProviderKeyDef } | null {
  const direct = BY_NAME.get(name);
  if (direct) return { name, def: direct };
  const numbered = name.match(NUMBERED);
  if (!numbered) return null;
  const base = BY_NAME.get(numbered[1]);
  return base ? { name, def: base } : null;
}

/**
 * Where a stored name sits in one provider's rotation: 0 for the bare name, N for `NAME_N`, null for
 * a name belonging to something else. Shared with the status chips, so "my key is saved" and "my key
 * is used" agree about numbered keys.
 */
export function providerKeyIndex(name: string, base: string): number | null {
  if (name === base) return 0;
  if (!name.startsWith(`${base}_`)) return null;
  const rest = name.slice(base.length + 1);
  if (!/^\d{1,3}$/.test(rest)) return null;
  const index = Number(rest);
  return index > 0 ? index : null;
}

/** Every stored name for one provider, in the order the function tries them. */
export function providerKeyNames(stored: Iterable<string>, base: string): string[] {
  return [...stored]
    .map((name) => ({ name, index: providerKeyIndex(name, base) }))
    .filter((row): row is { name: string; index: number } => row.index !== null)
    .sort((a, b) => a.index - b.index)
    .map((row) => row.name);
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

    const typedName = match[1].toUpperCase();
    const value = match[2].trim().replace(/^["']|["']$/g, '');
    const resolved = resolveName(typedName);
    if (!resolved) {
      rejected.push(typedName);
      continue;
    }
    // validation messages name the line as pasted, so a typo is findable in the paste box
    if (value.length < 8) {
      invalid.push(typedName);
      continue;
    }
    if (resolved.def.url && !/^https?:\/\//i.test(value)) {
      invalid.push(typedName);
      continue;
    }
    // the same name twice in one paste is one row: the first wins. Two *numbered* names are two
    // rows, because that is how a spare key is kept instead of replacing the first
    if (seen.has(resolved.name)) continue;
    seen.add(resolved.name);
    keys.push({ name: resolved.name, value });
  }

  return { keys, rejected, invalid };
}

/** Human summary of what a paste will do, e.g. "Exa, Tavily". */
export function describeKeys(keys: ParsedKey[]): string {
  return keys.map((key) => BY_NAME.get(key.name)?.label ?? key.name).join(', ');
}
