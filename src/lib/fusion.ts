import type { Source } from '../types';

/**
 * Multi-engine fusion.
 *
 * Findings from experiments/fusion-v3.mjs on real queries:
 *  - keyless engines barely overlap (0-9% Jaccard), so raw reciprocal-rank fusion lets a
 *    niche engine's rank-1 noise outrank a general engine's rank-2 answer;
 *  - relevance must be IDF-weighted, otherwise common words ("postgres") carry useless hits;
 *  - the same paper arrives from arXiv/Crossref/OpenAlex under different URLs, so identity
 *    resolution has to work on DOI + title, not URL alone;
 *  - engines have intents: academic engines are noise on "postgres index bloat", Stack
 *    Overflow is noise on "crispr off-target prediction".
 *
 * Pipeline: canonicalise -> IDF relevance -> intent-weighted RRF -> entity resolution ->
 * agreement boost -> per-domain diversity -> per-engine coverage quota -> tail fill.
 */

const STOP = new Set(
  'the a an of in to for and or on with how what why is are was vs my me it that this does do can using use about from by at as if then than'.split(
    ' ',
  ),
);

/**
 * Dork queries are operators plus a target, not prose. Scoring relevance against
 * `site:tesla.com filetype:pdf` would demand the words "site" and "filetype" in every page,
 * so operators are stripped before the relevance pass and only the target/content words count.
 */
const DORK_OPERATOR = /\b(?:site|inurl|intitle|allintitle|intext|filetype|ext|related|link|cache|before|after):\S+/gi;

export function stripDorkOperators(query: string): string {
  return String(query ?? '')
    .replace(DORK_OPERATOR, ' ')
    .replace(/\b(?:OR|AND)\b/gi, ' ')
    .replace(/[-()"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const tokens = (value: string): string[] =>
  String(value ?? '')
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9.+#_-]{1,}/g)
    ?.filter((token) => !STOP.has(token))
    // `tesla.com` is one regex token but no page contains that literal string, so a domain
    // also contributes its labels and still matches pages that only say "Tesla"
    .flatMap((token) => (token.includes('.') ? [token, ...token.split('.').filter((part) => part.length > 1)] : [token])) ??
  [];

export function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'fbclid', 'gclid'].forEach((param) =>
      parsed.searchParams.delete(param),
    );
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    let path = parsed.pathname.replace(/\/+$/, '');
    if (host === 'arxiv.org' && path.startsWith('/abs/')) path = path.replace('/abs/', '/pdf/');
    const query = [...parsed.searchParams]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
    return `${host}${path}${query ? `?${query}` : ''}`;
  } catch {
    return String(url ?? '').toLowerCase();
  }
}

const doiOf = (url: string): string | null => {
  const match = String(url ?? '').match(/10\.\d{4,9}\/[^\s?#&]+/i);
  return match ? match[0].toLowerCase().replace(/[.,;]$/, '') : null;
};

const jaccard = (a: Set<string>, b: Set<string>): number => {
  const intersection = [...a].filter((item) => b.has(item)).length;
  const union = new Set([...a, ...b]).size || 1;
  return intersection / union;
};

/**
 * What kind of answer the query wants. Exa and Tavily are both general engines, but they are
 * good at different things: Exa's embeddings win on conceptual questions and lose on exact
 * identifiers, Tavily's indexed crawl wins on "what changed recently" and adds nothing to a
 * definitional question an encyclopaedia already answers.
 */
export interface QueryIntent {
  /** 0-1: the answer is time-sensitive ("latest", "2026", "this week") */
  fresh: number;
  /** 0-1: the answer is timeless ("history of", "definition") */
  evergreen: number;
  /** 0-1: the query is conceptual prose rather than a keyword list */
  semantic: number;
  /** 0-1: the query wants one exact page (quoted phrase, CVE, IP, domain, `site:`) */
  navigational: number;
}

const FRESH_WORDS = new Set(
  'latest newest recent recently today tonight yesterday news breaking current currently live update updated release released launched launch changelog roadmap price pricing funding outage incident election'.split(
    ' ',
  ),
);
const EVERGREEN_WORDS = new Set(
  'history historical origin origins definition define meaning theory classic fundamental fundamentals biography ancient medieval century'.split(' '),
);
const SEMANTIC_WORDS = new Set(
  'why how compare comparison versus relationship relate related difference between explain influence impact effect trend landscape overview state'.split(' '),
);

const clamp = (value: number, lo = 0.25, hi = 1.6) => Math.max(lo, Math.min(hi, value));

export function queryIntent(query: string, now = Date.now()): QueryIntent {
  const raw = String(query ?? '');
  const lower = raw.toLowerCase();
  const words = new Set(tokens(lower));
  const anyWord = (list: Set<string>) => [...words].some((word) => list.has(word));

  const year = Number((lower.match(/\b(20\d{2})\b/) ?? [])[1] ?? 0);
  const currentYear = new Date(now).getFullYear();

  const quoted = /"[^"]+"/.test(raw);
  const identifier =
    /\b(?:cve-\d{4}-\d+|ipv[46]|\d{1,3}(?:\.\d{1,3}){3})\b/i.test(raw) ||
    /\b(?:site|inurl|intitle|filetype|ext|before|after):/i.test(raw) ||
    /\b[a-z0-9-]+\.[a-z]{2,6}\b/i.test(lower) ||
    /\(\)|\w+_\w+/.test(raw);

  // A year inside an identifier (`CVE-2024-3094`, `before:2025`) dates the *thing*, it does not ask
  // for fresh material, so identifier-shaped queries never earn the year bonus.
  const datedYear = year >= currentYear - 2 && !identifier;

  const fresh = Math.min(
    1,
    (anyWord(FRESH_WORDS) ? 0.7 : 0) +
      (datedYear ? 0.5 : 0) +
      (/\b(?:this|last|past)\s+(?:week|month|year)\b/.test(lower) ? 0.4 : 0),
  );
  const evergreen = anyWord(EVERGREEN_WORDS) ? 1 : 0;
  const semantic = Math.min(
    1,
    (anyWord(SEMANTIC_WORDS) ? 0.6 : 0) +
      (raw.trim().split(/\s+/).length >= 8 ? 0.4 : 0) +
      (/^(?:why|how|what|when|which|who|does|is|are|can|should|would)\b/i.test(raw.trim()) ? 0.3 : 0),
  );
  const navigational = Math.min(1, (quoted ? 0.5 : 0) + (identifier ? 0.7 : 0));

  return { fresh, evergreen, semantic, navigational };
}

const DAY = 86_400_000;

/**
 * Freshness of one result for a freshness-seeking query, 0-1. Undated results get 0: adding
 * nothing is honest, inventing a date is not.
 */
export function recencyWeight(published: string | undefined, freshness: number, now = Date.now()): number {
  if (!freshness || !published) return 0;
  const at = Date.parse(published);
  if (!Number.isFinite(at)) return 0;
  const ageDays = Math.max(0, (now - at) / DAY);
  const decay = ageDays <= 30 ? 1 : ageDays <= 180 ? 0.65 : ageDays <= 730 ? 0.35 : 0.12;
  return freshness * decay;
}

const TECH = 'python rust javascript typescript sql postgres postgresql docker kubernetes api regex library npm pip function bug c++ java linux git css react node'.split(' ');
const BIO = 'protein gene cell clinical patient disease drug crispr mrna cancer antibody assay virus genome'.split(' ');
const SCHOLAR = 'paper study dataset benchmark thesis journal survey citation doi arxiv literature review algorithm model'.split(' ');
const INTEL = 'cve vulnerability exploit breach leak shodan osint dork subdomain malware ransomware exposed scan'.split(' ');
const ENCYCLOPEDIC = 'what who when where history define definition meaning'.split(' ');

/** Per-engine trust, routed by query intent. */
export function engineWeights(
  query: string,
  now = Date.now(),
  options: { character?: boolean } = {},
): Record<string, number> {
  const lower = query.toLowerCase();
  const words = new Set(tokens(query));
  const has = (list: string[]) => list.some((term) => lower.includes(term) || words.has(term));
  const intent = queryIntent(query, now);

  const weights: Record<string, number> = {
    duckduckgo: 1.25,
    wikipedia: has(ENCYCLOPEDIC) ? 1.3 : 0.7,
    hn: 0.85,
    stackexchange: 0.9,
    github: 0.85,
    arxiv: 0.8,
    openalex: 0.7,
    crossref: 0.7,
    brave: 1.1,
    google: 1.2,
    exa: 1.2,
    tavily: 1.1,
    searxng: 1.0,
    firecrawl: 0.9,
    europepmc: 0.9,
    openlibrary: 0.55,
    archiveorg: 0.7,
    lemmy: 0.55,
    wikidata: 0.55,
    crtsh: 0.5,
    ahmia: 0.8,
    shodan: 0.8,
    urlscan: 0.75,
    grepapp: 1.0,
  };
  if (has(TECH)) {
    weights.stackexchange = 1.5;
    weights.github = 1.35;
    weights.grepapp = 1.3;
    weights.hn = 1.1;
    weights.arxiv = 0.9;
  }
  if (has(BIO)) {
    weights.openalex = 1.0;
    weights.crossref = 0.9;
    weights.europepmc = 1.5;
  }
  if (has(SCHOLAR)) {
    weights.arxiv = 1.3;
    weights.openalex = 1.25;
    weights.crossref = 1.15;
  }
  if (has(INTEL)) {
    weights.duckduckgo = 1.4;
    weights.github = 1.25;
    weights.hn = 1.05;
  }

  // engine character, not engine brand: semantic retrieval for prose, keyword retrieval for
  // exact identifiers, recency for "what changed" and nothing extra for timeless questions.
  // `character: false` reproduces the pre-intent weighting, which the ranking harness uses as
  // its baseline.
  if (options.character === false) return weights;
  weights.exa = clamp(
    weights.exa + 0.45 * intent.semantic - 0.5 * intent.navigational - 0.2 * intent.fresh,
  );
  weights.tavily = clamp(
    weights.tavily + 0.45 * intent.fresh - 0.25 * intent.evergreen + 0.1 * intent.semantic - 0.1 * intent.navigational,
  );
  weights.google = clamp((weights.google ?? 1.2) + 0.15 * intent.fresh);
  weights.brave = clamp((weights.brave ?? 1.1) + 0.1 * intent.fresh);
  weights.arxiv = clamp((weights.arxiv ?? 0.8) - 0.15 * intent.fresh);
  weights.openalex = clamp((weights.openalex ?? 0.7) - 0.1 * intent.fresh);

  return weights;
}

type Candidate = Source & {
  engine: string;
  key: string;
  doi: string | null;
  rank: number;
  weight: number;
  rel: number;
  /** freshness bonus, already scaled by how time-sensitive the query is */
  recency: number;
  score: number;
};

interface Entity {
  rep: Candidate;
  members: Candidate[];
  engines: Set<string>;
  keys: Set<string>;
  set?: Set<string>;
  doi: string | null;
  rel: number;
  score: number;
}

export interface FusionOptions {
  limit?: number;
  perDomain?: number;
  relativeGate?: number;
  agreement?: number;
  k?: number;
  perEngine?: number;
  /** injected clock so freshness ranking is deterministic in tests */
  now?: number;
  /** override the computed weights (used to replay a previous configuration) */
  weights?: Record<string, number>;
  /** set false to disable the freshness multiplier */
  recency?: boolean;
}

/** IDF-weighted term coverage of the title/snippet by the query. */
function relevance(query: string, item: Source, df: Map<string, number>, total: number): number {
  const queryTokens = tokens(query);
  if (queryTokens.length === 0) return 0.5;
  const title = String(item.title ?? '').toLowerCase();
  const haystack = `${title} ${String(item.snippet ?? '').toLowerCase()}`;
  const idf = (token: string) => Math.log(1 + total / (1 + (df.get(token) ?? 0)));
  let matched = 0;
  let available = 0;
  for (const token of queryTokens) {
    const weight = idf(token);
    available += weight;
    if (haystack.includes(token)) matched += weight * (title.includes(token) ? 1.15 : 0.85);
  }
  return available ? Math.min(1, matched / available) : 0;
}

function resolveEntities(items: Candidate[]): Entity[] {
  const entities: Entity[] = [];
  for (const item of items) {
    const set = new Set(tokens(item.title).filter((token) => token.length > 2));
    if (set.size >= 3) {
      const match = entities.find(
        (entity) =>
          (item.doi && entity.doi && item.doi === entity.doi) ||
          // the same page from two engines is one source, whatever each engine called it
          entity.keys.has(item.key) ||
          (entity.set && jaccard(set, entity.set) >= 0.6),
      );
      if (match) {
        match.members.push(item);
        match.engines.add(item.engine);
        match.keys.add(item.key);
        match.doi = match.doi ?? item.doi;
        match.rel = Math.max(match.rel, item.rel);
        continue;
      }
      entities.push({ rep: item, members: [item], engines: new Set([item.engine]), keys: new Set([item.key]), set, doi: item.doi, rel: item.rel, score: 0 });
      continue;
    }
    entities.push({ rep: item, members: [item], engines: new Set([item.engine]), keys: new Set([item.key]), doi: item.doi, rel: item.rel, score: 0 });
  }
  return entities;
}

/**
 * Fuse per-engine result lists into one ranked, de-duplicated source list.
 * `lists` maps engine id -> its results in the order that engine ranked them.
 */
export function fuseResults(
  query: string,
  lists: Record<string, Source[]>,
  options: FusionOptions = {},
): Source[] {
  const { limit = 40, perDomain = 2, relativeGate = 0.35, agreement = 0.02, k = 60, perEngine = 10, now = Date.now() } =
    options;
  const relevanceQuery = stripDorkOperators(query) || query;
  const intent = queryIntent(query, now);
  // Weights and intent are read from the query as typed: stripping operators is only about term
  // matching, and doing it earlier turned `CVE-2024-3094` into `CVE 2024 3094`, which no longer
  // looks like an identifier, so the navigational intent that disables semantic retrieval was lost.
  const weights = options.weights ?? engineWeights(query, now);
  const useRecency = options.recency !== false;
  // a `site:` lane is *meant* to be one domain; the diversity cap would flatten it to a
  // couple of sources, so scoped queries get a much higher per-domain allowance
  const siteScoped = /\bsite:/i.test(query);
  const domainCap = siteScoped ? Math.max(perDomain, 12) : perDomain;

  const all: Candidate[] = [];
  for (const [engine, results] of Object.entries(lists)) {
    results.slice(0, perEngine).forEach((result, index) => {
      const key = canonicalUrl(result.url);
      if (!key) return;
      all.push({
        ...result,
        engine,
        key,
        doi: doiOf(result.url),
        rank: index,
        // batch runs key lists as `engine·q3` so agreement across dork queries survives;
        // the weight still comes from the underlying engine
        weight: weights[engine] ?? weights[engine.split('·')[0]] ?? 0.7,
        rel: 0,
        recency: 0,
        score: 0,
      });
    });
  }
  if (all.length === 0) return [];

  const df = new Map<string, number>();
  for (const item of all) {
    for (const token of new Set(tokens(`${item.title} ${item.snippet}`))) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }

  for (const item of all) {
    item.rel = relevance(relevanceQuery, item, df, all.length);
    // a freshness-seeking query lifts dated recent results; a timeless one ignores dates
    item.recency = useRecency ? recencyWeight(item.published, intent.fresh, now) : 0;
    item.score = (item.weight / (k + item.rank + 1)) * item.rel ** 1.5 * (1 + 0.6 * item.recency);
  }

  const best = Math.max(...all.map((item) => item.rel));
  const kept = all.filter((item) => item.rel >= Math.max(0.1, relativeGate * best));
  const strong = kept.filter((item) => item.rel >= 0.5);
  const tail = kept.filter((item) => item.rel < 0.5);

  const entities = resolveEntities(strong.length >= 6 ? strong : kept);
  for (const entity of entities) {
    const base = Math.max(...entity.members.map((member) => member.score));
    const corroboration = Math.min(3, entity.engines.size);
    entity.score = base * (1 + agreement * (corroboration - 1)) * (1 + 0.15 * (entity.members.length - 1));
  }
  entities.sort((a, b) => b.score - a.score);

  const chosen: Entity[] = [];
  const chosenKeys = new Set<string>();
  const domains = new Map<string, number>();
  const take = (entity: Entity): boolean => {
    // the tail pass resolves entities a second time, so a URL already placed must not come back
    if ([...entity.keys].some((key) => chosenKeys.has(key))) return false;
    const domain = entity.rep.key.split('/')[0];
    const used = domains.get(domain) ?? 0;
    if (used >= domainCap) return false;
    domains.set(domain, used + 1);
    for (const key of entity.keys) chosenKeys.add(key);
    chosen.push(entity);
    return true;
  };

  // coverage pass: guarantee every contributing engine appears before score-filling
  for (const engine of Object.keys(lists)) {
    if (chosen.length >= limit) break;
    const entity = entities.find((candidate) => !chosen.includes(candidate) && candidate.engines.has(engine));
    if (entity) take(entity);
  }
  for (const entity of entities) {
    if (chosen.length >= limit) break;
    if (!chosen.includes(entity)) take(entity);
  }
  if (chosen.length < limit && tail.length > 0) {
    const tailEntities = resolveEntities(tail).sort((a, b) => b.rel - a.rel);
    for (const entity of tailEntities) {
      if (chosen.length >= limit) break;
      if (!chosen.includes(entity)) take(entity);
    }
  }

  // Coverage decides *who* is included; score decides *where*. Without this the first selected
  // engine's result always led, which made the intent weights barely visible in the top slots.
  chosen.sort((a, b) => b.score - a.score);

  return chosen.map((entity, index) => {
    const engines = [...entity.engines];
    const mergedSnippet = entity.members.map((member) => member.snippet).find((snippet) => snippet && snippet.length > 0);
    return {
      ...entity.rep,
      engines,
      relevance: Number(entity.rel.toFixed(3)),
      relevance_score: entity.score,
      source_engine: engines.join('+'),
      snippet: mergedSnippet ?? entity.rep.snippet,
      citation_id: `[${index + 1}]`,
    };
  });
}
