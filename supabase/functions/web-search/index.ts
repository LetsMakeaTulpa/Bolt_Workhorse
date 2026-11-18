import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { mapExaResults, mapGrepHits, mapShodanMatches, mapTavilyResults } from "./parsers.ts";
import { DEFAULT_EXTRACT_LIMIT, extractTopSources, type ExtractionSummary } from "./extract.ts";
import {
  RATE_LIMITED_MARKER,
  checkLimits,
  clientIp,
  rateLimitedMessage,
  retryAfterSeconds,
  type Caller,
  type Verdict,
} from "./rateLimit.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
  // a refusal must be readable from the browser: Retry-After is what tells a client when to return
  "Access-Control-Expose-Headers": "Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Scope",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const FEATHERLESS_BASE = "https://api.featherless.ai/v1";

async function getApiKey(): Promise<string> {
  const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data } = await client
    .from("app_config")
    .select("featherless_api_key")
    .eq("id", 1)
    .maybeSingle();
  return data?.featherless_api_key ?? "";
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source_engine: string;
  /** every engine that independently returned this URL */
  engines?: string[];
  relevance_score?: number;
  citation_id?: string;
  /** full page text, when this source was inside the extraction window */
  content?: string;
  /** which extractor read the page: a plain fetch, or a Firecrawl render */
  content_source?: string;
}

/** Secrets for one request: the caller's own keys first, then the function environment. */
type EngineKeys = Record<string, string>;

const secret = (keys: EngineKeys | undefined, name: string): string => keys?.[name] ?? Deno.env.get(name) ?? '';

/**
 * Every key this request may use for one provider, in the order to try them: the bare name first,
 * then `NAME_1`, `NAME_2`, … as the account numbered them. A second key is a spare, not a
 * replacement, so an engine rotates through them when one is refused or rate limited.
 */
export function keyCandidates(keys: EngineKeys | undefined, name: string): string[] {
  const candidates: string[] = [];
  const add = (value: string | undefined) => {
    const trimmed = String(value ?? '').trim();
    if (trimmed && !candidates.includes(trimmed)) candidates.push(trimmed);
  };
  add(keys?.[name] ?? Deno.env.get(name));
  Object.entries(keys ?? {})
    .map(([key, value]) => ({
      value,
      index: key.startsWith(`${name}_`) && /^\d{1,3}$/.test(key.slice(name.length + 1))
        ? Number(key.slice(name.length + 1))
        : 0,
    }))
    .filter((row) => row.index > 0)
    .sort((a, b) => a.index - b.index)
    .forEach((row) => add(row.value));
  return candidates;
}

/** Whether this request has any key for a provider, numbered or bare. */
const hasKey = (keys: EngineKeys | undefined, name: string): boolean => keyCandidates(keys, name).length > 0;

/**
 * Try each key in turn until one answers. The last error is the one reported, because it is what
 * decided the outcome: a provider that refuses the first key and accepts the second is a rotation,
 * and an engine only fails when every key it had was refused.
 */
export async function withKeyRotation<T>(candidates: string[], attempt: (key: string) => Promise<T>): Promise<T> {
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      return await attempt(candidate);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('no key available');
}

interface SearchEngine {
  name: string;
  capabilities: string[];
  search: (query: string, maxResults: number, keys?: EngineKeys) => Promise<SearchResult[]>;
}

// ─── Search Engines ──────────────────────────────────────────────

const duckDuckGoEngine: SearchEngine = {
  name: "duckduckgo",
  capabilities: ["general", "web", "images"],
  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; FieldworkBot/1.0)" },
      });
      if (!resp.ok) return [];
      const html = await resp.text();
      const results: SearchResult[] = [];
      const resultRegex = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/g;
      let match;
      while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
        let rawUrl = match[1];
        const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
        if (uddgMatch) rawUrl = decodeURIComponent(uddgMatch[1]);
        const title = match[2].replace(/<[^>]+>/g, "").trim();
        const snippet = match[3].replace(/<[^>]+>/g, "").trim();
        if (title && rawUrl) {
          results.push({ title, url: rawUrl, snippet, source_engine: "duckduckgo" });
        }
      }
      return results;
    } catch { return []; }
  },
};

const wikipediaEngine: SearchEngine = {
  name: "wikipedia",
  capabilities: ["encyclopedia", "background", "entities"],
  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    try {
      const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${maxResults}&origin=*`;
      const resp = await fetch(searchUrl);
      if (!resp.ok) return [];
      const data = await resp.json();
      const searchResults = data?.query?.search ?? [];
      return searchResults.map((r: { title: string; snippet: string }) => ({
        title: r.title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`,
        snippet: r.snippet.replace(/<[^>]+>/g, ""),
        source_engine: "wikipedia",
      }));
    } catch { return []; }
  },
};

const arxivEngine: SearchEngine = {
  name: "arxiv",
  capabilities: ["academic", "scientific", "preprints"],
  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    try {
      const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${maxResults}&sortBy=relevance`;
      const resp = await fetch(url);
      if (!resp.ok) return [];
      const xml = await resp.text();
      const results: SearchResult[] = [];
      const entryRegex = /<entry>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<id>(.*?)<\/id>[\s\S]*?<summary>(.*?)<\/summary>/g;
      let match;
      while ((match = entryRegex.exec(xml)) !== null && results.length < maxResults) {
        results.push({
          title: match[1].trim(),
          url: match[2].trim(),
          snippet: match[3].trim().substring(0, 300),
          source_engine: "arxiv",
        });
      }
      return results;
    } catch { return []; }
  },
};

const githubEngine: SearchEngine = {
  name: "github",
  capabilities: ["code", "repositories", "documentation", "issues"],
  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    try {
      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${maxResults}&sort=stars&order=desc`;
      const resp = await fetch(url, {
        headers: { "Accept": "application/vnd.github.v3+json", "User-Agent": "FieldworkBot/1.0" },
      });
      if (!resp.ok) return [];
      const data = await resp.json();
      const items = data?.items ?? [];
      return items.map((item: { full_name: string; html_url: string; description: string }) => ({
        title: item.full_name,
        url: item.html_url,
        snippet: item.description ?? "No description available",
        source_engine: "github",
      }));
    } catch { return []; }
  },
};

const braveEngine: SearchEngine = {
  name: "brave",
  capabilities: ["general", "web", "privacy"],
  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    try {
      const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}`;
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; FieldworkBot/1.0)" },
      });
      if (!resp.ok) return [];
      const html = await resp.text();
      const results: SearchResult[] = [];
      const snippetRegex = /<a[^>]*href="([^"]+)"[^>]*class="[^"]*result-header[^"]*"[^>]*>[\s\S]*?<span[^>]*>(.*?)<\/span>[\s\S]*?<p[^>]*class="[^"]*snippet[^"]*"[^>]*>(.*?)<\/p>/g;
      let match;
      while ((match = snippetRegex.exec(html)) !== null && results.length < maxResults) {
        const urlMatch = match[1];
        if (urlMatch && !urlMatch.startsWith("/")) {
          results.push({
            title: match[2].replace(/<[^>]+>/g, "").trim(),
            url: urlMatch,
            snippet: match[3].replace(/<[^>]+>/g, "").trim(),
            source_engine: "brave",
          });
        }
      }
      return results;
    } catch { return []; }
  },
};

const openAlexEngine: SearchEngine = {
  name: "openalex",
  capabilities: ["academic", "scholarly", "metadata"],
  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    try {
      const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per_page=${maxResults}`;
      const resp = await fetch(url);
      if (!resp.ok) return [];
      const data = await resp.json();
      const works = data?.results ?? [];
      return works.map((w: Record<string, unknown>) => ({
        title: (w.title as string) ?? "Untitled",
        url: (w.doi as string) ?? (w.id as string) ?? "",
        snippet: ((w.abstract_inverted_index as Record<string, number[]>) 
          ? Object.keys(w.abstract_inverted_index as Record<string, number[]>).join(" ").substring(0, 300)
          : "No abstract available"),
        source_engine: "openalex",
      }));
    } catch { return []; }
  },
};

// ─── Extended engines (activated by secrets, skipped when absent) ─

const UA = 'Mozilla/5.0 (compatible; FieldworkBot/1.0)';

const googleEngine: SearchEngine = {
  name: 'google',
  capabilities: ['general', 'web'],
  async search(query: string, maxResults: number, keys?: EngineKeys): Promise<SearchResult[]> {
    const key = secret(keys, 'GOOGLE_API_KEY');
    const cx = secret(keys, 'GOOGLE_CSE_ID');
    if (!key || !cx) return [];
    try {
      const url = `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=${encodeURIComponent(query)}&num=${Math.min(10, maxResults)}`;
      const resp = await fetch(url);
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data?.items ?? []).map((item: Record<string, string>) => ({
        title: item.title ?? '',
        url: item.link ?? '',
        snippet: item.snippet ?? '',
        source_engine: 'google',
      }));
    } catch { return []; }
  },
};

const exaEngine: SearchEngine = {
  name: 'exa',
  capabilities: ['general', 'semantic', 'web', 'research'],
  async search(query: string, maxResults: number, keys?: EngineKeys): Promise<SearchResult[]> {
    const candidates = keyCandidates(keys, 'EXA_API_KEY');
    if (candidates.length === 0) throw new Error('EXA_API_KEY is not set');
    const wanted = Math.min(25, Math.max(5, maxResults));
    return withKeyRotation(candidates, async (key) => {
      const resp = await fetch('https://api.exa.ai/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({
          query,
          numResults: wanted,
          type: 'auto',
          contents: { text: { maxCharacters: 500 } },
        }),
      });
      if (!resp.ok) throw new Error(`exa http ${resp.status}`);
      return mapExaResults(await resp.json(), wanted);
    });
  },
};

const searxngEngine: SearchEngine = {
  name: 'searxng',
  capabilities: ['general', 'web', 'meta'],
  async search(query: string, maxResults: number, keys?: EngineKeys): Promise<SearchResult[]> {
    const instances = secret(keys, 'SEARXNG_URL')
      .split(',')
      .map((value) => value.trim().replace(/\/$/, ''))
      .filter(Boolean);
    for (const base of instances) {
      try {
        const resp = await fetch(`${base}/search?q=${encodeURIComponent(query)}&format=json&safesearch=0`, {
          headers: { 'User-Agent': UA },
        });
        if (!resp.ok) continue;
        const data = await resp.json();
        const results = (data?.results ?? []).slice(0, maxResults).map((item: Record<string, string>) => ({
          title: item.title ?? '',
          url: item.url ?? '',
          snippet: (item.content ?? '').slice(0, 300),
          source_engine: 'searxng',
        }));
        if (results.length > 0) return results;
      } catch { continue; }
    }
    return [];
  },
};

const tavilyEngine: SearchEngine = {
  name: 'tavily',
  capabilities: ['general', 'research', 'scrape'],
  async search(query: string, maxResults: number, keys?: EngineKeys): Promise<SearchResult[]> {
    const candidates = keyCandidates(keys, 'TAVILY_API_KEY');
    if (candidates.length === 0) throw new Error('TAVILY_API_KEY is not set');
    const wanted = Math.min(20, maxResults);
    return withKeyRotation(candidates, async (key) => {
      const resp = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: key, query, max_results: wanted, search_depth: 'advanced' }),
      });
      if (!resp.ok) throw new Error(`tavily http ${resp.status}`);
      return mapTavilyResults(await resp.json(), wanted);
    });
  },
};

const firecrawlEngine: SearchEngine = {
  name: 'firecrawl',
  capabilities: ['general', 'scrape', 'crawl'],
  async search(query: string, maxResults: number, keys?: EngineKeys): Promise<SearchResult[]> {
    const candidates = keyCandidates(keys, 'FIRECRAWL_API_KEY');
    if (candidates.length === 0) return [];
    try {
      return await withKeyRotation(candidates, async (key) => {
        const resp = await fetch('https://api.firecrawl.dev/v1/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ query, limit: Math.min(10, maxResults) }),
        });
        if (!resp.ok) throw new Error(`firecrawl http ${resp.status}`);
        const data = await resp.json();
        const items = data?.data ?? data?.results ?? [];
        return items.map((item: Record<string, string>) => ({
          title: item.title ?? item.url,
          url: item.url,
          snippet: (item.description ?? item.markdown ?? '').slice(0, 320),
          source_engine: 'firecrawl',
        }));
      });
    } catch { return []; }
  },
};

/**
 * grep.app code search.
 *
 * The public endpoint sits behind a bot challenge for datacenter IPs, so this engine is
 * opt-in twice over: GREPAPP_BASE_URL can point at a proxy/mirror you control, and
 * GREPAPP_COOKIE can carry a browser `cf_clearance`-style cookie. With neither, it simply
 * returns no results instead of failing the search.
 */
const grepAppEngine: SearchEngine = {
  name: 'grepapp',
  capabilities: ['technical', 'code', 'snippets'],
  async search(query: string, maxResults: number, keys?: EngineKeys): Promise<SearchResult[]> {
    const mirror = secret(keys, 'GREPAPP_BASE_URL');
    const base = (mirror || 'https://grep.app').replace(/\/$/, '');
    const cookie = secret(keys, 'GREPAPP_COOKIE');
    try {
      const resp = await fetch(`${base}/api/search?q=${encodeURIComponent(query)}&page=1`, {
        headers: {
          'User-Agent': UA,
          Accept: 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
        },
      });
      if (!resp.ok) return [];
      const data = await resp.json();
      return mapGrepHits(data, maxResults);
    } catch { return []; }
  },
};

const shodanEngine: SearchEngine = {
  name: 'shodan',
  capabilities: ['intel', 'hosts', 'iot', 'services'],
  async search(query: string, maxResults: number, keys?: EngineKeys): Promise<SearchResult[]> {
    const key = secret(keys, 'SHODAN_API_KEY');
    if (!key) return [];
    try {
      const params = new URLSearchParams({ key, query, minify: 'true' });
      const resp = await fetch(`https://api.shodan.io/shodan/host/search?${params.toString()}`);
      // 401 = bad key, 402 = no query credits; both degrade to no results rather than an error
      if (!resp.ok) return [];
      const data = await resp.json();
      return mapShodanMatches(data, maxResults);
    } catch { return []; }
  },
};

const urlscanEngine: SearchEngine = {
  name: 'urlscan',
  capabilities: ['intel', 'domains', 'phishing'],
  async search(query: string, maxResults: number, keys?: EngineKeys): Promise<SearchResult[]> {
    const key = secret(keys, 'URLSCAN_API_KEY');
    try {
      const resp = await fetch(`https://urlscan.io/api/v1/search/?q=${encodeURIComponent(query)}&size=${Math.min(20, maxResults)}`, {
        headers: key ? { 'API-Key': key } : {},
      });
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data?.results ?? []).slice(0, maxResults).map((item: Record<string, any>) => ({
        title: item.page?.title || item.page?.domain || 'urlscan result',
        url: item.page?.url ?? `https://urlscan.io/result/${item.task?.uuid ?? ''}/`,
        snippet: `${item.page?.domain ?? ''} · ${item.task?.time ?? ''}`.trim(),
        source_engine: 'urlscan',
      }));
    } catch { return []; }
  },
};

const ahmiaEngine: SearchEngine = {
  name: 'ahmia',
  capabilities: ['dark', 'onion', 'general'],
  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    try {
      const resp = await fetch(`https://ahmia.fi/search/?q=${encodeURIComponent(query)}`, {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
        redirect: 'follow',
      });
      if (!resp.ok) return [];
      const html = await resp.text();
      const results: SearchResult[] = [];
      const linkRegex = /<a[^>]+href="([^"]*redirect_url=([^"&]+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
      let match;
      while ((match = linkRegex.exec(html)) !== null && results.length < maxResults) {
        const onionUrl = decodeURIComponent(match[2]);
        if (!onionUrl.includes('.onion')) continue;
        results.push({
          title: match[3].replace(/<[^>]+>/g, '').trim() || onionUrl,
          url: onionUrl,
          snippet: 'Onion service indexed by Ahmia',
          source_engine: 'ahmia',
        });
      }
      return results;
    } catch { return []; }
  },
};

/**
 * The Wayback Machine, for queries that name a page or a domain.
 *
 * There is no full-text search behind it — the CDX index is a list of captures per URL — so the
 * engine only answers when the query carries a URL or a bare domain, and returns nothing otherwise.
 * A live page that has changed is exactly the case a general engine cannot serve: this returns the
 * copy from the day it said what the answer needs.
 */
const waybackEngine: SearchEngine = {
  name: 'wayback',
  capabilities: ['archive', 'history', 'domains'],
  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const raw = query.match(/https?:\/\/[^\s"']+|[a-z0-9-]+(?:\.[a-z0-9-]+)+/i)?.[0];
    if (!raw) return [];
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      const params = new URLSearchParams({
        url,
        output: 'json',
        limit: String(Math.max(3, Math.min(maxResults, 10))),
        filter: 'statuscode:200',
        collapse: 'digest',
        fl: 'timestamp,original,mimetype',
      });
      const resp = await fetch(`https://web.archive.org/cdx/search/cdx?${params.toString()}`, {
        headers: { 'User-Agent': UA },
      });
      if (!resp.ok) return [];
      const rows = await resp.json();
      if (!Array.isArray(rows) || rows.length < 2) return [];
      // the first row is the column header
      return (rows.slice(1) as string[][]).map((row) => {
        const [timestamp, original, mimetype] = row;
        const date = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`;
        return {
          title: `Wayback ${date}: ${original}`,
          url: `https://web.archive.org/web/${timestamp}/${original}`,
          snippet: `Archived copy from ${date}${mimetype ? ` (${mimetype})` : ''} — the page as it stood that day`,
          source_engine: 'wayback',
        };
      });
    } catch {
      return [];
    }
  },
};

const crtshEngine: SearchEngine = {
  name: 'crtsh',
  capabilities: ['intel', 'domains', 'subdomains'],
  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const domain = query.match(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/i)?.[0];
    if (!domain) return [];
    try {
      const resp = await fetch(`https://crt.sh/?q=${encodeURIComponent(domain)}&output=json`, { headers: { 'User-Agent': UA } });
      if (!resp.ok) return [];
      const data = await resp.json();
      if (!Array.isArray(data)) return [];
      const seen = new Set<string>();
      const results: SearchResult[] = [];
      for (const cert of data) {
        const name = cert?.common_name;
        if (!name || seen.has(name)) continue;
        seen.add(name);
        results.push({
          title: `Certificate: ${name}`,
          url: `https://crt.sh/?q=${encodeURIComponent(name)}`,
          snippet: `${cert?.issuer_name ?? ''} · ${cert?.not_before ?? ''}`.trim(),
          source_engine: 'crtsh',
        });
        if (results.length >= maxResults) break;
      }
      return results;
    } catch { return []; }
  },
};

/** Which secrets each engine needs, so a request can say *why* it returned nothing. */
const ENGINE_KEY_ENV: Record<string, string[]> = {
  google: ['GOOGLE_API_KEY', 'GOOGLE_CSE_ID'],
  exa: ['EXA_API_KEY'],
  tavily: ['TAVILY_API_KEY'],
  firecrawl: ['FIRECRAWL_API_KEY'],
  shodan: ['SHODAN_API_KEY'],
  urlscan: ['URLSCAN_API_KEY'],
  searxng: ['SEARXNG_URL'],
};

/**
 * A provider refusing the credential (401/403, or wording to that effect) rather than the request.
 * Kept narrow on purpose: a 429 or a 5xx says nothing about the key, and retrying those on a
 * different credential would just spend the owner's quota on the same failure.
 */
export function isKeyRejection(message: string): boolean {
  return /\b(?:http\s*)?(?:401|403)\b|unauthori[sz]ed|forbidden|invalid\s+(?:api\s*)?key|api[\s_-]*key\s+(?:is\s+)?(?:invalid|expired|revoked)|incorrect\s+api[\s_-]*key/i.test(
    message,
  );
}

/**
 * Run one engine, and when the caller's own key is rejected, try again on the function's secret.
 *
 * Per-user keys exist so someone can bring their own quota; an expired key they pasted months ago
 * should not turn a working deployment into an error, and equally should not be silently ignored —
 * the returned detail says the personal key was refused so the composer can show it.
 */
export async function searchWithKeyFallback(
  engine: SearchEngine,
  query: string,
  maxResults: number,
  keys: EngineKeys | undefined,
  keyNames: string[] = [],
  onFallback?: (detail: string) => void,
): Promise<SearchResult[]> {
  try {
    return await engine.search(query, maxResults, keys);
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    // only a key this request actually supplied can be retried on a different one
    const rejected = keyNames.find((name) => Boolean(keys?.[name]));
    if (!rejected || !isKeyRejection(message)) throw err;

    try {
      // an empty map forces `secret()` to read the function environment
      const results = await engine.search(query, maxResults, {});
      onFallback?.(`your ${rejected} was rejected (${message}); used the function's own key`);
      return results;
    } catch (second) {
      throw new Error(`${message}; fallback key also failed: ${String((second as Error)?.message ?? second)}`);
    }
  }
}

export const ENGINES: Record<string, SearchEngine> = {
  duckduckgo: duckDuckGoEngine,
  wikipedia: wikipediaEngine,
  arxiv: arxivEngine,
  github: githubEngine,
  brave: braveEngine,
  openalex: openAlexEngine,
  google: googleEngine,
  exa: exaEngine,
  searxng: searxngEngine,
  tavily: tavilyEngine,
  firecrawl: firecrawlEngine,
  shodan: shodanEngine,
  grepapp: grepAppEngine,
  urlscan: urlscanEngine,
  ahmia: ahmiaEngine,
  wayback: waybackEngine,
  crtsh: crtshEngine,
};

// ─── Semantic Query Compiler (bounded, and reported) ─────────────

/**
 * The query compiler is the only place a search spends model credits before an engine runs, so it
 * is bounded on every axis a runaway could take: one attempt, an abort when the provider is slow,
 * a small completion budget, and a hard cap on how many queries come back. The report travels with
 * the response so the activity trail can name the model that rewrote the question and what it cost
 * — a hidden model call is also an unaccountable one.
 */
const COMPILER_MODEL = (Deno.env.get("SEARCH_COMPILER_MODEL") ?? "").trim() || "Qwen/Qwen2.5-7B-Instruct";
const COMPILER_TIMEOUT_MS = Math.min(
  60_000,
  Math.max(10, Number(Deno.env.get("SEARCH_COMPILER_TIMEOUT_MS")) || 12_000),
);
const COMPILER_MAX_TOKENS = 220;
/** More queries than this do not buy better coverage; they multiply the fan-out per engine. */
export const MAX_COMPILED_QUERIES = 5;
/** One query the engines are handed is one line of a model's prose; bound it like one. */
export const MAX_QUERY_CHARS = 160;

export interface CompilationReport {
  model: string;
  /** false when the compiler never reached the provider (disabled, or no key configured) */
  ran: boolean;
  reason: 'ok' | 'disabled' | 'no_key' | 'timeout' | 'error' | 'empty';
  queries: string[];
  duration_ms: number;
  /** provider-reported tokens for this call, when it reported them */
  tokens?: number;
  detail?: string;
}

function compilationReport(partial: Partial<CompilationReport> & { queries: string[] }): CompilationReport {
  return { model: COMPILER_MODEL, ran: false, reason: 'ok', duration_ms: 0, ...partial };
}

/**
 * Turn the model's answer into queries the engines can use: strip list markers and quotes, drop a
 * preamble line, de-duplicate, and cap both the count and each line's length. A model that ignores
 * "one per line, no explanations" therefore costs a bounded fan-out instead of an unbounded one.
 */
export function tidyQueries(raw: string): string[] {
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const cleaned = line
      .replace(/^\s*(?:[-*•]|\d{1,2}[.)])\s*/, '')
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) continue;
    // "Here are the queries:" is a lead-in, not a query: a query has no reason to end in a colon
    if (/^(?:here|sure|certainly|these are|below are)\b/i.test(cleaned) || /:\s*$/.test(cleaned)) continue;
    const bounded = cleaned.slice(0, MAX_QUERY_CHARS).trim();
    const key = bounded.toLowerCase();
    if (!bounded || seen.has(key)) continue;
    seen.add(key);
    queries.push(bounded);
    if (queries.length >= MAX_COMPILED_QUERIES) break;
  }
  return queries;
}

async function compileQueries(
  question: string,
  preset: string,
  useDorks: boolean,
  apiKey: string,
): Promise<{ queries: string[]; report: CompilationReport }> {
  if (!apiKey) {
    return { queries: [question], report: compilationReport({ ran: false, reason: 'no_key', queries: [question] }) };
  }

  const systemPrompt = `You are a semantic search query compiler for a research intelligence platform. Given a research question, generate 3-5 optimized search queries tailored for different search engines. Consider:
- Exact phrases and key terms
- Synonyms and alternate terminology
- Historical names or alternate spellings
- Domain-specific terminology
- ${useDorks ? "Apply Google dork operators (site:, filetype:, intitle:, inurl:) where appropriate" : "Use natural search queries without operators"}
- Different angles: primary sources, secondary analysis, contrary views
Return ONLY the queries, one per line. No numbering, no explanations.`;

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMPILER_TIMEOUT_MS);
  try {
    const resp = await fetch(`${FEATHERLESS_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: COMPILER_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Research question: "${question}"\nPreset: ${preset}\nGenerate search queries:` },
        ],
        max_tokens: COMPILER_MAX_TOKENS,
        temperature: 0.3,
      }),
    });

    const duration_ms = Date.now() - started;
    if (!resp.ok) {
      return {
        queries: [question],
        report: compilationReport({
          ran: true,
          reason: 'error',
          detail: `provider http ${resp.status}`,
          duration_ms,
          queries: [question],
        }),
      };
    }

    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content ?? "";
    const compiled = tidyQueries(text);
    const queries = compiled.length > 0 ? compiled : [question];
    const tokens = Number(data?.usage?.total_tokens);
    return {
      queries,
      report: compilationReport({
        ran: true,
        reason: compiled.length > 0 ? 'ok' : 'empty',
        duration_ms,
        queries,
        ...(Number.isFinite(tokens) && tokens > 0 ? { tokens } : {}),
      }),
    };
  } catch (err) {
    const timedOut = controller.signal.aborted;
    return {
      queries: [question],
      report: compilationReport({
        ran: true,
        reason: timedOut ? 'timeout' : 'error',
        detail: timedOut
          ? `no answer within ${COMPILER_TIMEOUT_MS}ms`
          : String((err as Error)?.message ?? err).slice(0, 120),
        duration_ms: Date.now() - started,
        queries: [question],
      }),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Reciprocal Rank Fusion ──────────────────────────────────────

/**
 * Identity of a result across engines: same page should merge even when one engine wrote
 * `www.` or a trailing slash. Query strings are kept — they often select different content.
 */
function urlKey(raw: string): string {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    const path = url.pathname.replace(/\/+$/, '');
    return `${host}${path}${url.search}`.toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

function reciprocalRankFusion(
  engineResults: { engine: string; results: SearchResult[] }[],
  weights: Record<string, number> = {},
): SearchResult[] {
  const k = 60; // RRF constant
  const scores = new Map<string, { result: SearchResult; score: number; engines: string[] }>();

  for (const { engine, results } of engineResults) {
    const weight = weights[engine] ?? 1.0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const key = urlKey(r.url);
      const rrfScore = weight / (k + i + 1);
      const existing = scores.get(key);
      if (existing) {
        // agreement is the point: additive score plus a record of who found it
        existing.score += rrfScore;
        if (!existing.engines.includes(engine)) existing.engines.push(engine);
        if (!existing.result.snippet && r.snippet) existing.result.snippet = r.snippet;
      } else {
        scores.set(key, { result: r, score: rrfScore, engines: [engine] });
      }
    }
  }

  const fused = Array.from(scores.values());
  fused.sort((a, b) => b.score - a.score);

  return fused.map((f) => ({
    ...f.result,
    engines: f.engines,
    source_engine: f.engines.join('+'),
    relevance_score: f.score,
  }));
}

// ─── Query Expansion ─────────────────────────────────────────────

function expandQuery(query: string): string[] {
  const expansions: string[] = [query];
  // Add quoted version for exact match
  const quoted = query.replace(/"/g, "");
  if (quoted !== query) expansions.push(`"${quoted}"`);
  // Add site-restricted versions for common research domains
  expansions.push(`${query} site:edu OR site:gov`);
  return expansions.slice(0, 3);
}

// ─── Engine Selection (Portfolio Optimizer) ──────────────────────

const ENGINE_CAPABILITY_MAP: Record<string, string[]> = {
  general: ["duckduckgo", "wikipedia", "brave", "exa", "searxng", "google"],
  academic: ["arxiv", "openalex", "wikipedia", "exa"],
  technical: ["github", "grepapp", "duckduckgo", "wikipedia", "exa"],
  historical: ["wikipedia", "duckduckgo", "arxiv", "wayback"],
  verification: ["duckduckgo", "wikipedia", "brave", "google"],
  intel: ["shodan", "grepapp", "urlscan", "crtsh", "duckduckgo"],
  dark: ["ahmia", "duckduckgo"],
  legacy: ["duckduckgo", "brave"],
};

function selectEngines(preset: string, configuredEngines: string[]): string[] {
  const presetCapabilities: Record<string, string[]> = {
    general: ["duckduckgo", "wikipedia", "arxiv", "github"],
    deep: ["duckduckgo", "wikipedia", "arxiv", "github", "brave"],
    historical: ["duckduckgo", "wikipedia", "arxiv", "wayback"],
    academic: ["arxiv", "wikipedia", "openalex", "duckduckgo"],
    technical: ["github", "grepapp", "duckduckgo", "wikipedia"],
    "fact-check": ["duckduckgo", "wikipedia", "brave"],
    "source-tracing": ["duckduckgo", "wikipedia", "arxiv"],
    timeline: ["duckduckgo", "wikipedia", "arxiv"],
    "evidence-dossier": ["duckduckgo", "wikipedia", "arxiv", "github", "brave"],
    explain: ["duckduckgo", "wikipedia", "arxiv", "github"],
    "map-relationships": ["duckduckgo", "wikipedia", "arxiv"],
    "research-gaps": ["arxiv", "wikipedia", "duckduckgo"],
    dark: ["ahmia", "duckduckgo", "brave", "exa"],
    intel: ["shodan", "urlscan", "crtsh", "duckduckgo", "exa"],
    uncensored: ["searxng", "exa", "duckduckgo", "brave"],
    "deep-legacy": ["duckduckgo", "wikipedia", "arxiv", "github", "brave"],
    "shodan-web": ["duckduckgo", "brave"],
  };

  const recommended = presetCapabilities[preset] ?? presetCapabilities["general"];
  // Intersect with configured engines, fallback to recommended
  const available = recommended.filter((e) => configuredEngines.includes(e) || configuredEngines.length === 0);
  return available.length > 0 ? available : recommended;
}

// ─── Main Handler ────────────────────────────────────────────────

/** The service-role client, or null when this deployment has no counters to spend (local, tests). */
type AdminClient = ReturnType<typeof createClient>;

function adminClient(): AdminClient | null {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
}

/**
 * Who is calling, and which provider keys they brought. One authentication, because the rate limit
 * and the per-user keys are the same question: a verified session is an account, anything else is
 * a public anon-key caller identified by address.
 *
 * Keys are read once per request and handed to the engines, so one person's Tavily quota is never
 * spent by another's search. Anything unreadable (bad token, missing table) simply means "fall
 * back to the environment".
 */
async function identifyCaller(client: AdminClient, req: Request): Promise<{ caller: Caller; keys: EngineKeys }> {
  const anonymous: Caller = { kind: "anonymous", id: clientIp(req.headers) };
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return { caller: anonymous, keys: {} };

  try {
    const { data: auth, error } = await client.auth.getUser(token);
    if (error || !auth?.user?.id) return { caller: anonymous, keys: {} };
    const { data, error: readError } = await client
      .from("user_engine_keys")
      .select("name, value")
      .eq("user_id", auth.user.id);
    if (readError || !data) return { caller: { kind: "user", id: auth.user.id }, keys: {} };
    return {
      caller: { kind: "user", id: auth.user.id },
      keys: Object.fromEntries(data.map((row) => [row.name as string, row.value as string])),
    };
  } catch (err) {
    console.error("caller check failed, treating as anonymous", (err as Error).message);
    return { caller: anonymous, keys: {} };
  }
}

/**
 * A refusal that says which budget ran out and when to come back, so the composer can show the
 * reason in the trail instead of a bare "Search failed (429)".
 */
function rateLimitedResponse(caller: Caller, verdict: Extract<Verdict, { ok: false }>): Response {
  const retryAfter = retryAfterSeconds(verdict.resetAt);
  console.warn(`search rate limited: ${caller.kind} ${verdict.scope} ${verdict.used}/${verdict.limit}`);
  return new Response(
    JSON.stringify({
      error: RATE_LIMITED_MARKER,
      message: rateLimitedMessage(caller, retryAfter),
      tier: caller.kind,
      scope: verdict.scope,
      limit: verdict.limit,
      used: verdict.used,
      retry_after: retryAfter,
    }),
    {
      status: 429,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Retry-After": String(retryAfter),
        "X-RateLimit-Limit": String(verdict.limit),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Scope": verdict.scope,
      },
    }
  );
}

/**
 * The secret names this deployment holds. A browser cannot read function env, so without this the
 * composer could only guess "unknown" for every engine the account has no key for — an honest guess,
 * but useless. Naming the configured ones turns it into a fact.
 *
 * Names only: no value and no fragment of one ever leaves the function, and a name being present
 * does not promise the provider will accept it (that is what key_prefer/key_fallback reports).
 */
const KNOWN_SECRETS = [
  "EXA_API_KEY",
  "TAVILY_API_KEY",
  "FIRECRAWL_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_CSE_ID",
  "SHODAN_API_KEY",
  "URLSCAN_API_KEY",
  "SEARXNG_URL",
  "GREPAPP_COOKIE",
];

export function configuredSecrets(read: (name: string) => string | undefined = (name) => Deno.env.get(name)): string[] {
  return KNOWN_SECRETS.filter((name) => (read(name) ?? "").trim().length > 0);
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  // GET is the configuration probe: which secrets exist here, so the composer can show a real key
  // state before a search instead of "unknown"
  if (req.method === "GET") {
    return new Response(JSON.stringify({ configured: configuredSecrets() }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // Identify the caller before the body is even read: the counter and the per-user keys are one
    // question, and a caller over budget must not cost a token of compilation or a single engine hit.
    const admin = adminClient();
    let caller: Caller = { kind: "anonymous", id: clientIp(req.headers) };
    let userKeys: EngineKeys = {};
    if (admin) {
      const identified = await identifyCaller(admin, req);
      caller = identified.caller;
      userKeys = identified.keys;
      const verdict = await checkLimits(admin, caller);
      if (!verdict.ok) return rateLimitedResponse(caller, verdict);
    }

    const body = await req.json();
    const {
      query,
      engines: requestedEngines = [],
      maxResultsPerEngine = 5,
      useDorks = false,
      preset = "general",
      compileQueries: shouldCompile = true,
      // the ranked top is worth reading in full; a caller can turn that off for speed
      extract: shouldExtract = true,
      extractLimit = DEFAULT_EXTRACT_LIMIT,
    } = body;

    if (!query) {
      return new Response(
        JSON.stringify({ error: "Missing 'query' field" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // a signed-in caller's own provider keys were resolved with the caller, before the limit
    const FEATHERLESS_API_KEY = await getApiKey();
    const engines = requestedEngines.length > 0 ? requestedEngines : selectEngines(preset, []);

    // Compile queries — one bounded model call, reported so the trail can name it and its cost.
    // The report always carries the queries that were actually searched, including the dork
    // expansions used when compilation is off, so it can never disagree with `queries_used`.
    let queries: string[] = [query];
    let compilation: CompilationReport;
    if (shouldCompile) {
      const plan = await compileQueries(query, preset, useDorks, FEATHERLESS_API_KEY);
      queries = plan.queries;
      compilation = plan.report;
    } else {
      queries = useDorks ? expandQuery(query) : [query];
      compilation = compilationReport({ ran: false, reason: 'disabled', queries });
    }

    // Run searches across all engines and queries in parallel
    const allEngineResults: { engine: string; results: SearchResult[] }[] = [];
    const searchPromises: Promise<void>[] = [];

    // Every engine reports why it produced nothing, so "0 results" can be diagnosed from one
    // response instead of guessing between a missing secret, a rejected key and a quiet query.
    type EngineReport = { engine: string; status: string; results: number; detail?: string };
    const reports = new Map<string, EngineReport>();
    // key_fallback ranks above a plain ok so a rejected personal key is not overwritten by the
    // second query succeeding quietly
    const SEVERITY: Record<string, number> = { ok: 0, empty: 1, key_fallback: 1.5, error: 2, missing_key: 3, unknown_engine: 3 };
    const note = (engineName: string, status: string, count = 0, detail?: string) => {
      const prev = reports.get(engineName);
      const keepPrev = prev && (SEVERITY[prev.status] ?? 0) > (SEVERITY[status] ?? 0);
      reports.set(engineName, {
        engine: engineName,
        status: keepPrev ? prev!.status : status,
        results: (prev?.results ?? 0) + count,
        detail: keepPrev ? prev!.detail : detail,
      });
    };

    for (const engineName of engines) {
      const engine = ENGINES[engineName];
      if (!engine) {
        note(engineName, 'unknown_engine', 0, 'no engine registered under this name');
        continue;
      }

      const required = ENGINE_KEY_ENV[engineName];
      const missing = required?.find((name) => !hasKey(userKeys, name));
      if (missing) {
        note(engineName, 'missing_key', 0, `${missing} is not set for this account`);
        continue;
      }

      // For each engine, search with the primary query (and one expansion if compiled)
      const queriesForEngine = queries.slice(0, 2);
      for (const q of queriesForEngine) {
        // a rejected personal key degrades to the deployment's own secret instead of failing
        let fallbackDetail = '';
        searchPromises.push(
          searchWithKeyFallback(engine, q, maxResultsPerEngine, userKeys, required ?? [], (detail) => {
            fallbackDetail = detail;
          }).then((results) => {
            const status = fallbackDetail ? 'key_fallback' : results.length > 0 ? 'ok' : 'empty';
            note(engineName, status, results.length, fallbackDetail || undefined);
            allEngineResults.push({ engine: engineName, results });
          }).catch((err) => {
            note(engineName, 'error', 0, String(err?.message ?? err).slice(0, 120));
          })
        );
      }
    }

    await Promise.all(searchPromises);

    // Apply Reciprocal Rank Fusion
    const fused = reciprocalRankFusion(allEngineResults);

    // Deduplicate by URL (RRF already handles this, but be safe)
    const seen = new Set<string>();
    const deduped = fused.filter((r) => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    });

    // Assign citation IDs
    const finalResults = deduped.map((r, i) => ({
      ...r,
      citation_id: `[${i + 1}]`,
    }));

    // Read the top pages, so the answer is written from the page rather than from a search engine's
    // summary of it. Failures are reported, never thrown: a result without text is still a result.
    let results: SearchResult[] = finalResults;
    let extraction: ExtractionSummary | null = null;
    if (shouldExtract !== false && finalResults.length > 0) {
      const limit = Math.min(8, Math.max(0, Number(extractLimit) || DEFAULT_EXTRACT_LIMIT));
      const extracted = await extractTopSources(finalResults, {
        limit,
        firecrawlKey: keyCandidates(userKeys, 'FIRECRAWL_API_KEY')[0] ?? '',
      });
      results = extracted.results;
      extraction = extracted.summary;
    }

    return new Response(
      JSON.stringify({
        query,
        queries_used: queries,
        compilation,
        engines_used: engines,
        total_results: results.length,
        preset,
        engine_status: [...reports.values()],
        extraction,
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

Deno.serve(handleRequest);
