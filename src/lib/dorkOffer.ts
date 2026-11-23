/**
 * The dork an answer wrote out, offered back.
 *
 * A model that answers a thin search often ends on a revised dork — "try `site:example.com ext:env`
 * instead". That is a query, and until now the only way to use it was to retype it out of the post.
 * The offer is drawn from the code spans, because that is where a model puts a query it means to be
 * run; prose that merely names an operator ("the site: operator limits by domain") is not one.
 *
 * The operator list is `dorks.ts`'s, and the whole line has to be a query rather than a sentence
 * around one: a fenced block of code with a quoted string in it is code, not a dork.
 */
const OPERATOR = /\b(?:site|inurl|intitle|allintitle|intext|filetype|ext|related|link|cache|before|after):\S/i;

/** Fenced blocks first, then inline spans, so a fence's own line is never read as a one-line span. */
const CODE_SPAN = /```[^\n]*\n([\s\S]*?)```|`([^`\n]+)`/g;

/** The longest line still worth offering: beyond this it is a script, not a query. */
const MAX_LENGTH = 300;

/**
 * Dorks in the order the answer wrote them, without repeats, capped at `limit`.
 * A repeat is the same query case-insensitively: the reader does not need the same button twice.
 */
export function offeredDorks(markdown: string, limit = 3): string[] {
  const dorks: string[] = [];
  for (const match of String(markdown ?? '').matchAll(CODE_SPAN)) {
    const body = match[1] ?? match[2] ?? '';
    for (const line of body.split(/\r?\n/)) {
      // a prompt marker or a shell prefix is not part of the query
      const text = line.trim().replace(/^[$>]\s+/, '').trim();
      if (!text || text.length > MAX_LENGTH) continue;
      if (!OPERATOR.test(text)) continue;
      if (dorks.some((known) => known.toLowerCase() === text.toLowerCase())) continue;
      dorks.push(text);
      if (dorks.length >= limit) return dorks;
    }
  }
  return dorks;
}
