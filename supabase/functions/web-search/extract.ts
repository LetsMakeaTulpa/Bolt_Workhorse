/**
 * Fetch-and-extract: turn the top ranked sources into page text instead of leaving the model with
 * a search snippet.
 *
 * A snippet is the engine's summary of a page, written by someone else for a different question. It
 * is often enough to rank a result and rarely enough to answer from: the number the question asked
 * for is usually a paragraph further down. So after ranking, the top few pages are fetched and their
 * text extracted, and that text is what reaches the model.
 *
 * Two extractors, in that order:
 *  - a plain fetch and a readable-text pass, which costs nothing and works on most sites;
 *  - Firecrawl's scrape, only when a page answered with too little text and a key exists. Sites that
 *    render their body in JavaScript return an empty shell to a plain fetch, and paying a credit to
 *    scrape one such page is cheaper than answering from a snippet.
 *
 * Nothing here touches Deno APIs, so the whole stage runs under node in tests with an injected
 * fetch. Every failure is a reason string, never a thrown error: a page that will not load must not
 * take down a search that already has results.
 */

export interface ExtractableSource {
  title: string;
  url: string;
  snippet: string;
  [key: string]: unknown;
}

export interface PageText {
  text: string;
  chars: number;
  /** which extractor produced the text */
  source: 'fetch' | 'firecrawl';
}

export interface ExtractionFailure {
  url: string;
  error: string;
}

export interface ExtractionDeps {
  /** injected so tests can run without network; defaults to the platform fetch */
  fetchImpl?: typeof fetch;
  /** Firecrawl key, when the deployment has one; no key means no fallback */
  firecrawlKey?: string;
  /** per-page timeout */
  timeoutMs?: number;
  /** characters kept per page */
  maxChars?: number;
}

/** Only the top of a ranked list is worth a page fetch: the tail is there to be read, not used. */
export const DEFAULT_EXTRACT_LIMIT = 3;
export const DEFAULT_MAX_CHARS = 6000;
export const DEFAULT_TIMEOUT_MS = 8000;
/**
 * Below this a page is an unrendered shell rather than a short page. Kept low on purpose: a table
 * of figures or a one-paragraph abstract is a real page, and paying Firecrawl for it would be waste.
 */
const THIN_PAGE_CHARS = 120;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  copy: '©',
};

/** Named and numeric entities, the ones that appear in prose rather than in scripts. */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Blocks that end a line, so prose does not run into the next paragraph. */
const BLOCK_TAGS = [
  'p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'nav', 'li', 'ul', 'ol',
  'tr', 'td', 'th', 'table', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figure',
  'figcaption', 'dt', 'dd', 'dl', 'br', 'hr', 'form', 'fieldset', 'details', 'summary',
];

/** Lines that are page furniture wherever they appear; dropping them keeps the budget for prose. */
const BOILERPLATE = /^(?:skip to (?:main )?content|accept (?:all )?cookies|cookie (?:policy|settings)|we use cookies.*|sign in|log in|subscribe|newsletter|advertisement|share (?:this|on)\b.*|menu|search|home)$/i;

/**
 * Readable text from an HTML document.
 *
 * Scripts and styles are removed before tags are stripped — leaving them in is the classic way to
 * hand a model a page of minified JavaScript — and block tags become newlines so paragraphs survive
 * as paragraphs. `article`/`main` is preferred when it holds enough prose, because a news page's
 * body lives there and its chrome does not.
 */
export function htmlToText(html: string): string {
  const withoutNoise = String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|canvas|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(script|style|noscript|template|svg|canvas|iframe)\b[^>]*\/?>/gi, ' ')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ');

  const blockPattern = new RegExp(`</?(?:${BLOCK_TAGS.join('|')})\\b[^>]*>`, 'gi');
  const flattened = withoutNoise.replace(blockPattern, '\n');

  const lines = flattened
    .replace(/<[^>]*>/g, ' ')
    .split('\n')
    .map((line) => decodeEntities(line).replace(/[ \t\f\v\u00a0]+/g, ' ').trim())
    .filter((line) => line.length > 0 && !BOILERPLATE.test(line));

  return lines.join('\n');
}

/** The longest slice of page text worth keeping, cut on a word boundary. */
export function capText(text: string, maxChars = DEFAULT_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const cut = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('. '), slice.lastIndexOf(' '));
  return `${(cut > maxChars * 0.6 ? slice.slice(0, cut) : slice).trimEnd()}…`;
}

/** Page text from a fetched document, preferring the article body when there is one. */
export function extractFromHtml(html: string, maxChars = DEFAULT_MAX_CHARS): string {
  const whole = htmlToText(html);
  const body = html.match(/<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)>/i)?.[1];
  if (body) {
    const inner = htmlToText(body);
    if (inner.length >= 400 && inner.length < whole.length) return capText(inner, maxChars);
  }
  return capText(whole, maxChars);
}

/** Pages that can be fetched by a plain GET: http(s) only, no onion services or local addresses. */
export function isExtractableUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (/\.onion$/i.test(url.hostname)) return false;
    if (/^(?:localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(url.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Which results get a page fetch: the first `limit` by rank that a plain GET can reach. Skipping
 * the unfetchable ones rather than stopping at them means one onion result does not cost the next
 * page its text.
 */
export function pickExtractionTargets<T extends { url: string }>(results: T[], limit = DEFAULT_EXTRACT_LIMIT): T[] {
  const targets: T[] = [];
  for (const result of results) {
    if (targets.length >= limit) break;
    if (isExtractableUrl(result.url)) targets.push(result);
  }
  return targets;
}

const withTimeout = async <T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
};

const describe = (err: unknown): string => {
  const message = String((err as Error)?.message ?? err ?? '');
  if (/abort/i.test(message)) return 'timed out';
  return message.slice(0, 120) || 'unknown error';
};

/** Firecrawl renders the page; used only when a plain fetch could not read it. */
async function scrapeWithFirecrawl(url: string, fetchImpl: typeof fetch, key: string, maxChars: number, timeoutMs: number): Promise<PageText> {
  const resp = await withTimeout(
    (signal) => fetchImpl('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
      signal,
    }),
    timeoutMs,
  );
  if (!resp.ok) throw new Error(`firecrawl http ${resp.status}`);
  const data = (await resp.json()) as { data?: { markdown?: string; content?: string } };
  const text = String(data?.data?.markdown ?? data?.data?.content ?? '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) throw new Error('firecrawl returned no text');
  const kept = capText(text, maxChars);
  return { text: kept, chars: kept.length, source: 'firecrawl' };
}

/**
 * Fetch one page and return its text.
 *
 * An HTML page goes through the readable-text pass; a plain-text or markdown page is kept as it is
 * (an arxiv API page, a raw README); anything else — a PDF, an image — is reported as unreadable
 * rather than decoded into noise.
 */
export async function fetchPageText(url: string, deps: ExtractionDeps = {}): Promise<PageText> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxChars = deps.maxChars ?? DEFAULT_MAX_CHARS;

  const readWithFetch = async (): Promise<PageText> => {
    const resp = await withTimeout(
      (signal) => fetchImpl(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; FieldworkBot/1.0)',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
        },
        redirect: 'follow',
        signal,
      }),
      timeoutMs,
    );
    if (!resp.ok) throw new Error(`http ${resp.status}`);
    const type = (resp.headers.get('content-type') ?? '').toLowerCase();
    if (type.includes('pdf') || type.startsWith('image/') || type.includes('octet-stream')) {
      throw new Error(`unreadable content type ${type.split(';')[0]}`);
    }
    const body = await resp.text();
    const text = type.includes('html') || /<html|<body|<p\b/i.test(body)
      ? extractFromHtml(body, maxChars)
      : capText(body.replace(/\r\n/g, '\n').trim(), maxChars);
    if (text.length < THIN_PAGE_CHARS) throw new Error(`page text too thin (${text.length} chars)`);
    return { text, chars: text.length, source: 'fetch' };
  };

  let fetchError = '';
  try {
    return await readWithFetch();
  } catch (err) {
    fetchError = describe(err);
  }

  if (deps.firecrawlKey) {
    try {
      return await scrapeWithFirecrawl(url, fetchImpl, deps.firecrawlKey, maxChars, timeoutMs);
    } catch (err) {
      throw new Error(`${fetchError}; firecrawl: ${describe(err)}`);
    }
  }
  throw new Error(fetchError);
}

/**
 * Extract page text for the top results, in place of nothing.
 *
 * Results are returned in their original order with `content` added where a page was read; the
 * summary says what was attempted and why anything failed, so an answer written without full text
 * can be explained rather than guessed at.
 */
export async function extractTopSources<T extends ExtractableSource>(
  results: T[],
  deps: ExtractionDeps & { limit?: number } = {},
): Promise<{ results: (T & { content?: string; content_source?: string })[]; summary: ExtractionSummary }> {
  const limit = deps.limit ?? DEFAULT_EXTRACT_LIMIT;
  const targets = pickExtractionTargets(results, limit);
  const extracted: Record<string, string> = {};
  const bySource: Record<string, string> = {};
  const failures: ExtractionFailure[] = [];

  await Promise.all(
    targets.map(async (target) => {
      try {
        const page = await fetchPageText(target.url, deps);
        extracted[target.url] = page.text;
        bySource[target.url] = page.source;
      } catch (err) {
        failures.push({ url: target.url, error: describe(err) });
      }
    }),
  );

  return {
    results: results.map((result) =>
      extracted[result.url]
        ? { ...result, content: extracted[result.url], content_source: bySource[result.url] }
        : result,
    ),
    summary: {
      limit,
      requested: targets.length,
      extracted: targets.length - failures.length,
      chars: Object.values(extracted).reduce((total, text) => total + text.length, 0),
      failures,
    },
  };
}

export interface ExtractionSummary {
  limit: number;
  requested: number;
  extracted: number;
  chars: number;
  failures: ExtractionFailure[];
}
