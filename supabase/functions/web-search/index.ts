import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
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
  relevance_score?: number;
  citation_id?: string;
}

interface SearchEngine {
  name: string;
  capabilities: string[];
  search: (query: string, maxResults: number) => Promise<SearchResult[]>;
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

const ENGINES: Record<string, SearchEngine> = {
  duckduckgo: duckDuckGoEngine,
  wikipedia: wikipediaEngine,
  arxiv: arxivEngine,
  github: githubEngine,
  brave: braveEngine,
  openalex: openAlexEngine,
};

// ─── Semantic Query Compiler ─────────────────────────────────────

async function compileQueries(
  question: string,
  preset: string,
  useDorks: boolean,
  apiKey: string,
): Promise<string[]> {
  const systemPrompt = `You are a semantic search query compiler for a research intelligence platform. Given a research question, generate 3-5 optimized search queries tailored for different search engines. Consider:
- Exact phrases and key terms
- Synonyms and alternate terminology
- Historical names or alternate spellings
- Domain-specific terminology
- ${useDorks ? "Apply Google dork operators (site:, filetype:, intitle:, inurl:) where appropriate" : "Use natural search queries without operators"}
- Different angles: primary sources, secondary analysis, contrary views
Return ONLY the queries, one per line. No numbering, no explanations.`;

  try {
    const resp = await fetch(`${FEATHERLESS_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "Qwen/Qwen2.5-7B-Instruct",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Research question: "${question}"\nPreset: ${preset}\nGenerate search queries:` },
        ],
        max_tokens: 300,
        temperature: 0.3,
      }),
    });

    if (!resp.ok) return [question];
    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content ?? "";
    const queries = text.split("\n").map((q: string) => q.trim()).filter((q: string) => q.length > 0);
    return queries.length > 0 ? queries : [question];
  } catch {
    return [question];
  }
}

// ─── Reciprocal Rank Fusion ──────────────────────────────────────

function reciprocalRankFusion(
  engineResults: { engine: string; results: SearchResult[] }[],
  weights: Record<string, number> = {},
): SearchResult[] {
  const k = 60; // RRF constant
  const scores = new Map<string, { result: SearchResult; score: number }>();

  for (const { engine, results } of engineResults) {
    const weight = weights[engine] ?? 1.0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const key = r.url;
      const rrfScore = weight / (k + i + 1);
      const existing = scores.get(key);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(key, { result: r, score: rrfScore });
      }
    }
  }

  const fused = Array.from(scores.values());
  fused.sort((a, b) => b.score - a.score);

  return fused.map((f) => ({
    ...f.result,
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
  general: ["duckduckgo", "wikipedia", "brave"],
  academic: ["arxiv", "openalex", "wikipedia"],
  technical: ["github", "duckduckgo", "wikipedia"],
  historical: ["wikipedia", "duckduckgo", "arxiv"],
  verification: ["duckduckgo", "wikipedia", "brave"],
  legacy: ["duckduckgo", "brave"],
};

function selectEngines(preset: string, configuredEngines: string[]): string[] {
  const presetCapabilities: Record<string, string[]> = {
    general: ["duckduckgo", "wikipedia", "arxiv", "github"],
    deep: ["duckduckgo", "wikipedia", "arxiv", "github", "brave"],
    historical: ["duckduckgo", "wikipedia", "arxiv"],
    academic: ["arxiv", "wikipedia", "openalex", "duckduckgo"],
    technical: ["github", "duckduckgo", "wikipedia"],
    "fact-check": ["duckduckgo", "wikipedia", "brave"],
    "source-tracing": ["duckduckgo", "wikipedia", "arxiv"],
    timeline: ["duckduckgo", "wikipedia", "arxiv"],
    "evidence-dossier": ["duckduckgo", "wikipedia", "arxiv", "github", "brave"],
    explain: ["duckduckgo", "wikipedia", "arxiv", "github"],
    "map-relationships": ["duckduckgo", "wikipedia", "arxiv"],
    "research-gaps": ["arxiv", "wikipedia", "duckduckgo"],
    dark: ["duckduckgo", "brave"],
    "deep-legacy": ["duckduckgo", "wikipedia", "arxiv", "github", "brave"],
    "shodan-web": ["duckduckgo", "brave"],
  };

  const recommended = presetCapabilities[preset] ?? presetCapabilities["general"];
  // Intersect with configured engines, fallback to recommended
  const available = recommended.filter((e) => configuredEngines.includes(e) || configuredEngines.length === 0);
  return available.length > 0 ? available : recommended;
}

// ─── Main Handler ────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const {
      query,
      engines: requestedEngines = [],
      maxResultsPerEngine = 5,
      useDorks = false,
      preset = "general",
      compileQueries: shouldCompile = true,
    } = body;

    if (!query) {
      return new Response(
        JSON.stringify({ error: "Missing 'query' field" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch API key from database
    const FEATHERLESS_API_KEY = await getApiKey();
    if (!FEATHERLESS_API_KEY && shouldCompile) {
      // Skip query compilation if no API key, fall back to raw query
    }

    // Select engines based on preset portfolio optimization
    const engines = requestedEngines.length > 0 ? requestedEngines : selectEngines(preset, []);

    // Compile queries — semantic query compilation
    let queries: string[] = [query];
    if (shouldCompile && FEATHERLESS_API_KEY) {
      queries = await compileQueries(query, preset, useDorks, FEATHERLESS_API_KEY);
    } else if (useDorks) {
      queries = expandQuery(query);
    }

    // Run searches across all engines and queries in parallel
    const allEngineResults: { engine: string; results: SearchResult[] }[] = [];
    const searchPromises: Promise<void>[] = [];

    for (const engineName of engines) {
      const engine = ENGINES[engineName];
      if (!engine) continue;

      // For each engine, search with the primary query (and one expansion if compiled)
      const queriesForEngine = queries.slice(0, 2);
      for (const q of queriesForEngine) {
        searchPromises.push(
          engine.search(q, maxResultsPerEngine).then((results) => {
            allEngineResults.push({ engine: engineName, results });
          }).catch(() => {
            // Engine failure — graceful degradation
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

    return new Response(
      JSON.stringify({
        query,
        queries_used: queries,
        engines_used: engines,
        total_results: finalResults.length,
        preset,
        results: finalResults,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
