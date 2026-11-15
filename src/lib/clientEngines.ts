import type { Source } from '../types';

/**
 * Browser-side engines. They call public, keyless, CORS-open APIs, so no credential ever
 * reaches the client and no new Supabase function deploy is needed to widen coverage.
 */
export interface ClientEngine {
  id: string;
  label: string;
  note: string;
  search: (query: string, limit: number, signal?: AbortSignal) => Promise<Source[]>;
}

const TIMEOUT_MS = 8000;

/**
 * One request, two reasons to stop: the engine's own timeout, and a caller that has moved on.
 * Cancelling from the caller must end the network work, not just ignore the reply, otherwise a
 * superseded search keeps burning rate limit for an answer nobody will use.
 */
async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
  const forward = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', forward, { once: true });
  }
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toPlainText(html: string, max = 260): string {
  if (!html) return '';
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const plain = (parsed.body.textContent ?? '').replace(/\s+/g, ' ').trim();
  return plain.length > max ? `${plain.slice(0, max)}…` : plain;
}

const hnEngine: ClientEngine = {
  id: 'hn',
  label: 'Hacker News',
  note: 'Algolia index of stories and comments',
  async search(query, limit, signal) {
    const data = (await fetchJson(
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${limit}`,
      signal,
    )) as { hits?: Record<string, unknown>[] } | null;
    const hits = Array.isArray(data?.hits) ? data!.hits : [];
    return hits.map((hit) => {
      const objectId = text(hit.objectID);
      const title = text(hit.title) || text(hit.story_title) || `HN item ${objectId}`;
      const url = text(hit.url) || text(hit.story_url) || `https://news.ycombinator.com/item?id=${objectId}`;
      const points = typeof hit.points === 'number' ? hit.points : 0;
      const comments = typeof hit.num_comments === 'number' ? hit.num_comments : 0;
      const body = toPlainText(text(hit.story_text) || text(hit.comment_text), 200);
      return {
        title,
        url,
        snippet: body || `${points} points · ${comments} comments · by ${text(hit.author) || 'unknown'}`,
        source_engine: 'hn',
      } satisfies Source;
    });
  },
};

const stackExchangeEngine: ClientEngine = {
  id: 'stackexchange',
  label: 'Stack Overflow',
  note: 'Stack Exchange network, answered technical questions',
  async search(query, limit, signal) {
    const data = (await fetchJson(
      `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(
        query,
      )}&site=stackoverflow&pagesize=${limit}&filter=withbody`,
      signal,
    )) as { items?: Record<string, unknown>[] } | null;
    const items = Array.isArray(data?.items) ? data!.items : [];
    return items.map((item) => {
      const link = text(item.link);
      const score = typeof item.score === 'number' ? item.score : 0;
      const answers = typeof item.answer_count === 'number' ? item.answer_count : 0;
      const tags = Array.isArray(item.tags) ? item.tags.map((t) => text(t)).join(', ') : '';
      return {
        title: toPlainText(text(item.title), 160) || link,
        url: link,
        snippet: `${toPlainText(text(item.body), 200)} · score ${score} · ${answers} answers${tags ? ` · ${tags}` : ''}`,
        source_engine: 'stackexchange',
      } satisfies Source;
    });
  },
};

const crossrefEngine: ClientEngine = {
  id: 'crossref',
  label: 'Crossref',
  note: 'DOI registry across scholarly publishers',
  async search(query, limit, signal) {
    const data = (await fetchJson(
      `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${limit}&select=title,URL,DOI,abstract,container-title,issued,author`,
      signal,
    )) as { message?: { items?: Record<string, unknown>[] } } | null;
    const items = Array.isArray(data?.message?.items) ? data!.message!.items! : [];
    return items.map((item) => {
      const title = Array.isArray(item.title) ? text(item.title[0]) : text(item.title);
      const container = Array.isArray(item.container_title) ? text(item.container_title[0]) : text(item.container_title);
      const doi = text(item.DOI);
      const year = (() => {
        const issued = item.issued as { 'date-parts'?: number[][] } | undefined;
        const parts = issued?.['date-parts']?.[0];
        return Array.isArray(parts) && parts.length > 0 ? String(parts[0]) : '';
      })();
      const author = (() => {
        const authors = Array.isArray(item.author) ? item.author : [];
        const first = authors[0] as { family?: string } | undefined;
        return text(first?.family);
      })();
      const abstract = toPlainText(text(item.abstract), 200);
      const meta = [author, container, year].filter(Boolean).join(' · ');
      // fusion can only rank on recency when the engine hands over a date
      const parts = (item.issued as { 'date-parts'?: number[][] } | undefined)?.['date-parts']?.[0];
      const published = Array.isArray(parts) && parts[0]
        ? `${parts[0]}-${String(parts[1] ?? 1).padStart(2, '0')}-${String(parts[2] ?? 1).padStart(2, '0')}`
        : undefined;
      return {
        title: title || doi || 'Untitled work',
        url: text(item.URL) || (doi ? `https://doi.org/${doi}` : ''),
        snippet: abstract || meta || `DOI ${doi}`,
        source_engine: 'crossref',
        ...(published ? { published } : {}),
      } satisfies Source;
    });
  },
};

const openLibraryEngine: ClientEngine = {
  id: 'openlibrary',
  label: 'Open Library',
  note: 'books, editions and authors',
  async search(query, limit, signal) {
    const data = (await fetchJson(
      `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=${limit}&fields=title,key,author_name,first_publish_year,subject`,
      signal,
    )) as { docs?: Record<string, unknown>[] } | null;
    return (Array.isArray(data?.docs) ? data!.docs : []).map((doc) => {
      const key = text(doc.key);
      const authors = Array.isArray(doc.author_name) ? doc.author_name.slice(0, 2).map((a) => text(a)).join(', ') : '';
      const year = doc.first_publish_year ? String(doc.first_publish_year) : '';
      return {
        title: text(doc.title) || key,
        url: key ? `https://openlibrary.org${key}` : '',
        snippet: [authors, year].filter(Boolean).join(' · ') || 'Open Library record',
        source_engine: 'openlibrary',
      } satisfies Source;
    });
  },
};

const europePmcEngine: ClientEngine = {
  id: 'europepmc',
  label: 'Europe PMC',
  note: 'biomedical literature and preprints',
  async search(query, limit, signal) {
    const data = (await fetchJson(
      `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}&format=json&pageSize=${limit}`,
      signal,
    )) as { resultList?: { result?: Record<string, unknown>[] } } | null;
    return (data?.resultList?.result ?? []).map((item) => {
      const doi = text(item.doi);
      const source = text(item.source) || 'MED';
      const id = text(item.id);
      return {
        title: toPlainText(text(item.title), 160) || doi || id,
        url: doi ? `https://doi.org/${doi}` : `https://europepmc.org/article/${source}/${id}`,
        snippet: [text(item.journalTitle), text(item.pubYear), toPlainText(text(item.abstractText), 170)]
          .filter(Boolean)
          .join(' · '),
        source_engine: 'europepmc',
        ...(text(item.firstPublicationDate) ? { published: text(item.firstPublicationDate) } : {}),
      } satisfies Source;
    });
  },
};

const internetArchiveEngine: ClientEngine = {
  id: 'archiveorg',
  label: 'Internet Archive',
  note: 'archived texts, media and pages',
  async search(query, limit, signal) {
    const params = new URLSearchParams({ q: query, rows: String(limit), output: 'json' });
    params.append('fl[]', 'identifier');
    params.append('fl[]', 'title');
    params.append('fl[]', 'year');
    params.append('fl[]', 'description');
    const data = (await fetchJson(`https://archive.org/advancedsearch.php?${params.toString()}`, signal)) as {
      response?: { docs?: Record<string, unknown>[] };
    } | null;
    return (data?.response?.docs ?? []).map((doc) => {
      const identifier = text(doc.identifier);
      const description = Array.isArray(doc.description) ? text(doc.description[0]) : text(doc.description);
      return {
        title: toPlainText(text(doc.title), 150) || identifier,
        url: identifier ? `https://archive.org/details/${identifier}` : '',
        snippet: [doc.year ? String(doc.year) : '', toPlainText(description, 170)].filter(Boolean).join(' · '),
        source_engine: 'archiveorg',
      } satisfies Source;
    });
  },
};

const lemmyEngine: ClientEngine = {
  id: 'lemmy',
  label: 'Lemmy',
  note: 'federated, lightly moderated discussion',
  async search(query, limit, signal) {
    const data = (await fetchJson(
      `https://lemmy.world/api/v3/search?q=${encodeURIComponent(query)}&type_=Posts&limit=${limit}`,
      signal,
    )) as { posts?: { post?: Record<string, unknown> }[] } | null;
    return (data?.posts ?? []).map(({ post }) => {
      const name = text(post?.name);
      const url = text(post?.url) || (post?.id ? `https://lemmy.world/post/${String(post.id)}` : '');
      return {
        title: name || url,
        url,
        snippet: toPlainText(text(post?.body), 200) || 'Lemmy post',
        source_engine: 'lemmy',
      } satisfies Source;
    });
  },
};

const wikidataEngine: ClientEngine = {
  id: 'wikidata',
  label: 'Wikidata',
  note: 'entity graph: people, orgs, events',
  async search(query, limit, signal) {
    const data = (await fetchJson(
      `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(
        query,
      )}&language=en&uselang=en&limit=${limit}&format=json&origin=*`,
      signal,
    )) as { search?: Record<string, unknown>[] } | null;
    return (data?.search ?? []).map((entity) => {
      const id = text(entity.id);
      return {
        title: text(entity.label) || id,
        url: id ? `https://www.wikidata.org/wiki/${id}` : '',
        snippet: text(entity.description) || 'Wikidata entity',
        source_engine: 'wikidata',
      } satisfies Source;
    });
  },
};

const crtShEngine: ClientEngine = {
  id: 'crtsh',
  label: 'crt.sh (CT logs)',
  note: 'certificate transparency: subdomains and infrastructure',
  async search(query, limit, signal) {
    const domain = query.trim().match(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/i)?.[0];
    if (!domain) return [];
    const data = (await fetchJson(`https://crt.sh/?q=${encodeURIComponent(domain)}&output=json`, signal)) as
      | Record<string, unknown>[]
      | null;
    if (!Array.isArray(data)) return [];
    const seen = new Set<string>();
    const results: Source[] = [];
    for (const cert of data) {
      const name = text(cert.common_name);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const names = text(cert.name_value)
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 4)
        .join(', ');
      results.push({
        title: `Certificate: ${name}`,
        url: `https://crt.sh/?q=${encodeURIComponent(name)}`,
        snippet: [names, text(cert.issuer_name)].filter(Boolean).join(' · ').slice(0, 240),
        source_engine: 'crtsh',
      });
      if (results.length >= limit) break;
    }
    return results;
  },
};

export const CLIENT_ENGINES: ClientEngine[] = [
  hnEngine,
  stackExchangeEngine,
  crossrefEngine,
  openLibraryEngine,
  europePmcEngine,
  internetArchiveEngine,
  lemmyEngine,
  wikidataEngine,
  crtShEngine,
];
export const CLIENT_ENGINE_IDS = new Set(CLIENT_ENGINES.map((engine) => engine.id));

export async function searchClientEngines(
  query: string,
  engineIds: string[],
  limit: number,
  onEngineResults?: (engineId: string, results: Source[]) => void,
  signal?: AbortSignal,
): Promise<Source[]> {
  const selected = CLIENT_ENGINES.filter((engine) => engineIds.includes(engine.id));
  if (selected.length === 0 || signal?.aborted) return [];
  const lists = await Promise.all(
    selected.map(async (engine) => {
      if (signal?.aborted) return [];
      try {
        const results = (await engine.search(query, Math.max(3, Math.min(limit, 10)), signal)).filter((item) => item.url);
        // stream partials so the cluster map can light up engine by engine — but never for a
        // run that has already been replaced
        if (results.length > 0 && !signal?.aborted) onEngineResults?.(engine.id, results);
        return results;
      } catch {
        return [];
      }
    }),
  );
  return signal?.aborted ? [] : lists.flat();
}

const urlKey = (url: string) =>
  url
    .replace(/[#?].*$/, '')
    .replace(/\/$/, '')
    .toLowerCase();

/** Reciprocal-rank merge across the server's RRF results and the browser engines. */
export function mergeSearchResults(server: Source[], client: Source[]): Source[] {
  const merged = new Map<string, Source>();

  const add = (source: Source, rank: number) => {
    const key = urlKey(source.url);
    if (!key) return;
    const score = source.relevance_score && source.relevance_score > 0 ? source.relevance_score : 1 / (60 + rank + 1);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...source, relevance_score: score });
      return;
    }
    existing.relevance_score = Math.max(existing.relevance_score ?? 0, score);
    if (!existing.snippet && source.snippet) existing.snippet = source.snippet;
    if (!existing.source_engine.includes(source.source_engine)) {
      existing.source_engine = `${existing.source_engine}+${source.source_engine}`;
    }
  };

  server.forEach((source, index) => add(source, index));
  client.forEach((source, index) => add(source, index));

  return [...merged.values()]
    .sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0))
    .slice(0, 60)
    .map((source, index) => ({ ...source, citation_id: `[${index + 1}]` }));
}
