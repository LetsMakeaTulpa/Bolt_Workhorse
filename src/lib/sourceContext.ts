/**
 * Turning ranked sources into the text the model reads.
 *
 * A snippet is the search engine's summary of a page. When the function has fetched and extracted
 * the page, the model should read that instead — the sentence with the answer is usually further
 * down than a snippet reaches — so the page text is given after the snippet, capped so one long
 * article cannot crowd out the other sources.
 */
import type { PromptReason, Source } from '../types';

/** Characters of page text handed to the model per source. */
export const PROMPT_CONTENT_CHARS = 4000;

/** The same cap for a search the model asked for itself, where several pages share the budget. */
export const FOLLOW_UP_CONTENT_CHARS = 3000;

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
  const pageText = pageTextForPrompt(source, contentChars);
  if (pageText) lines.push(`Page text (extracted from the page):\n${pageText}`);
  return lines.join('\n');
}

/**
 * The page text exactly as `formatSource` puts it in the prompt: trimmed, capped at the same
 * character count, and cut at a word boundary so the model never starts reading half a number.
 *
 * Exported because the transcript shows the model's own reading: "was this figure in the text it
 * saw?" can only be answered with the text it saw, not with the longer page the row stored.
 */
export function pageTextForPrompt(source: Pick<Source, 'content'>, contentChars: number = PROMPT_CONTENT_CHARS): string {
  const pageText = (source.content ?? '').trim();
  if (!pageText) return '';
  return pageText.length > contentChars
    ? `${pageText.slice(0, contentChars).replace(/\s+\S*$/, '')}…`
    : pageText;
}

/**
 * Why the prompt carried this source, or why it stayed in the panel.
 *
 * `cap` is the character budget the prompt gave this source, and is undefined when the turn did not
 * put it in front of the model: either a follow-up search's tail (over the cap) or a turn that built
 * no prompt at all. A source inside the prompt whose page text ran past the cap was read only up to
 * the cap, which is its own answer — "in the prompt" alone would imply the whole page.
 */
export function promptReasonFor(source: Source, cap: number | undefined, overCap = false): PromptReason {
  if (cap === undefined) return overCap ? 'capped' : 'no-prompt';
  return (source.content ?? '').trim().length > cap ? 'trimmed' : 'given';
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
