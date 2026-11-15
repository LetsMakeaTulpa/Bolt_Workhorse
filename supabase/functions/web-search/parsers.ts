/**
 * Pure response mappers for the code-search and OSINT engines.
 *
 * Kept out of index.ts so they can be unit-tested without a live Deno runtime, an API key,
 * or network access: fixtures in, SearchResult-shaped objects out.
 */

export interface MappedResult {
  title: string;
  url: string;
  snippet: string;
  source_engine: string;
  /** publication date, when the engine reports one */
  published?: string;
}

/** Engines date things inconsistently; normalise to YYYY-MM-DD or drop it. */
function isoDate(value: unknown): string | undefined {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : undefined;
}

const ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
};

/** grep.app wraps matched tokens in <mark> inside an HTML table cell. */
export function stripMarkup(html: unknown): string {
  return String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:quot|#39|apos|amp|lt|gt|nbsp);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * grep.app `/api/search` → one result per matching file.
 * Shape: { hits: { hits: [{ repo: { raw }, path: { raw }, branch: { raw }, content: { snippet } }] } }
 */
export function mapGrepHits(payload: unknown, maxResults: number): MappedResult[] {
  const hits = (payload as { hits?: { hits?: unknown[] } } | null)?.hits?.hits;
  if (!Array.isArray(hits)) return [];

  const results: MappedResult[] = [];
  for (const raw of hits) {
    const hit = raw as Record<string, { raw?: unknown }> | null;
    const repo = stripMarkup(hit?.repo?.raw);
    const path = stripMarkup(hit?.path?.raw);
    const branch = stripMarkup(hit?.branch?.raw) || 'main';
    const snippet = stripMarkup(hit?.content?.snippet);
    if (!repo || !path) continue;

    const url = repo.includes('/')
      ? `https://github.com/${repo}/blob/${encodeURIComponent(branch)}/${path.replace(/^\/+/, '')}`
      : `https://grep.app/search?q=${encodeURIComponent(repo)}`;

    results.push({
      title: `${repo}/${path}`,
      url,
      snippet: snippet.slice(0, 300) || `Code match in ${repo}`,
      source_engine: 'grepapp',
    });
    if (results.length >= maxResults) break;
  }
  return results;
}

/** Trims an extract to a snippet, collapsing whitespace so rendering stays predictable. */
function excerpt(value: unknown, max = 320): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Exa `/search` → web results.
 * Shape: { results: [{ title, url, text, publishedDate?, author?, score }] }
 * Entries without a URL are dropped: fusion keys on the canonical URL.
 */
export function mapExaResults(payload: unknown, maxResults: number): MappedResult[] {
  const rows = (payload as { results?: unknown[] } | null)?.results;
  if (!Array.isArray(rows)) return [];

  const results: MappedResult[] = [];
  for (const raw of rows) {
    const item = raw as Record<string, unknown> | null;
    const url = String(item?.url ?? '').trim();
    if (!url) continue;
    const title = String(item?.title ?? '').trim() || url;
    const body = excerpt(item?.text ?? item?.summary ?? item?.highlights, 320);
    const published = isoDate(item?.publishedDate ?? item?.published_date);
    results.push({ title, url, snippet: body, source_engine: 'exa', ...(published ? { published } : {}) });
    if (results.length >= maxResults) break;
  }
  return results;
}

/**
 * Tavily `/search` → web results.
 * Shape: { answer?, results: [{ title, url, content, score, published_date? }] }
 * `content` is the extract; `answer` is a synthesis and is deliberately not used as a snippet.
 */
export function mapTavilyResults(payload: unknown, maxResults: number): MappedResult[] {
  const rows = (payload as { results?: unknown[] } | null)?.results;
  if (!Array.isArray(rows)) return [];

  const results: MappedResult[] = [];
  for (const raw of rows) {
    const item = raw as Record<string, unknown> | null;
    const url = String(item?.url ?? '').trim();
    if (!url) continue;
    const title = String(item?.title ?? '').trim() || url;
    const body = excerpt(item?.content ?? item?.raw_content, 320);
    const published = isoDate(item?.published_date ?? item?.publishedDate);
    results.push({ title, url, snippet: body, source_engine: 'tavily', ...(published ? { published } : {}) });
    if (results.length >= maxResults) break;
  }
  return results;
}

/**
 * Shodan `/shodan/host/search` → one result per fingerprinted host.
 * Shape: { matches: [{ ip_str, port, hostnames[], org, product, country_name, data }] }
 */
export function mapShodanMatches(payload: unknown, maxResults: number): MappedResult[] {
  const matches = (payload as { matches?: unknown[] } | null)?.matches;
  if (!Array.isArray(matches)) return [];

  const results: MappedResult[] = [];
  for (const raw of matches) {
    const match = raw as Record<string, unknown> | null;
    const ip = String(match?.ip_str ?? '').trim();
    if (!ip) continue;

    const port = match?.port ? String(match.port) : '';
    const hostnames = Array.isArray(match?.hostnames)
      ? (match!.hostnames as unknown[]).map((name) => String(name)).filter(Boolean)
      : [];
    const product = String(match?.product ?? '').trim();
    const label = hostnames[0] ?? ip;
    const meta = [String(match?.org ?? '').trim(), product, String(match?.country_name ?? '').trim()]
      .filter(Boolean)
      .join(' · ');
    const banner = String(match?.data ?? '').replace(/\s+/g, ' ').trim().slice(0, 220);

    results.push({
      title: `${label}${port ? `:${port}` : ''}${product ? ` (${product})` : ''}`,
      url: `https://www.shodan.io/host/${encodeURIComponent(ip)}`,
      snippet: [meta, banner].filter(Boolean).join(' — ').slice(0, 320) || `Shodan host ${ip}`,
      source_engine: 'shodan',
    });
    if (results.length >= maxResults) break;
  }
  return results;
}
