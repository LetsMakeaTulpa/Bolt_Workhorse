/**
 * Turning ranked sources into the text the model reads.
 *
 * A snippet is the search engine's summary of a page. When the function has fetched and extracted
 * the page, the model should read that instead — the sentence with the answer is usually further
 * down than a snippet reaches — so the page text is given after the snippet, capped so one long
 * article cannot crowd out the other sources.
 */
import type { Source } from '../types';

/** Characters of page text handed to the model per source. */
export const PROMPT_CONTENT_CHARS = 4000;

export interface SourceContextOptions {
  /** how much of each page's text to include */
  contentChars?: number;
  /** how many sources to include; the rest are already in the panel, not in the prompt */
  limit?: number;
}

/**
 * One source as the model sees it: identity and provenance first, then the snippet, then the page
 * text when there is one. A source with no extracted text looks exactly as it did before — the
 * stage adds, it does not change how snippets are presented.
 */
export function formatSource(source: Source, options: SourceContextOptions = {}): string {
  const contentChars = options.contentChars ?? PROMPT_CONTENT_CHARS;
  const lines = [
    `${source.citation_id ?? ''} ${source.title}`.trim(),
    `URL: ${source.url}`,
    `Provider: ${source.source_engine}`,
    `Snippet: ${source.snippet}`,
  ];
  const pageText = (source.content ?? '').trim();
  if (pageText) {
    const capped = pageText.length > contentChars
      ? `${pageText.slice(0, contentChars).replace(/\s+\S*$/, '')}…`
      : pageText;
    lines.push(`Page text (extracted from the page):\n${capped}`);
  }
  return lines.join('\n');
}

/** How many of these sources the model will read page text for — used for the honest notice. */
export function countWithPageText(results: Source[]): number {
  return results.filter((source) => (source.content ?? '').trim().length > 0).length;
}

/** The whole ranked list as one block, in rank order. */
export function formatSourceContext(results: Source[], options: SourceContextOptions = {}): string {
  const limit = options.limit ?? results.length;
  return results
    .slice(0, Math.max(0, limit))
    .map((source) => formatSource(source, options))
    .join('\n\n');
}
