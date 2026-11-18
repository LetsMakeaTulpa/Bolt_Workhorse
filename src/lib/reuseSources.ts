/**
 * Re-answering a question whose sources are already retrieved.
 *
 * A turn can fail after its search succeeded: the provider errors, the stream dies, the model never
 * answers. Retrying that turn used to run every engine again — paying for results the conversation
 * already has, and risking a different set of sources, so the second attempt could not be compared
 * with the first. The rows that run wrote are the record of what it found; answering from them
 * again is fast, cheap and reproducible: same sources, same citation numbers, no engine contacted.
 *
 * Two copies of those sources exist, and they are not equally good. The run that just failed still
 * holds its fused list in memory, page text and all — that is what the model should read. The stored
 * rows are the fallback, and the only copy that outlives the turn; they carry the snippet, not the
 * page.
 */
import type { Source, SourceRecord } from '../types';

const normalize = (query: string): string => query.trim().replace(/\s+/g, ' ').toLowerCase();

/** The number a row was stored under, so a regenerated prompt numbers its sources identically. */
function citationNumber(row: SourceRecord): number {
  const match = /\d{1,3}/.exec(row.citation_id ?? '');
  const value = match ? Number(match[0]) : Number.NaN;
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

/**
 * Stored rows as the sources an answer was produced from.
 *
 * Ordered by citation number rather than by insertion, because the citation ids are what the answer's
 * markers point at: row 10 must stay `[10]` even if the list is rebuilt in a different order.
 */
export function sourcesFromRows(
  rows: SourceRecord[],
  { question, conversationId }: { question?: string; conversationId?: string } = {},
): Source[] {
  const asked = question === undefined ? null : normalize(question);
  return rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => {
      if (!row.url) return false;
      if (conversationId !== undefined && row.conversation_id !== conversationId) return false;
      if (asked !== null && normalize(row.original_query ?? '') !== asked) return false;
      return true;
    })
    .sort((a, b) => citationNumber(a.row) - citationNumber(b.row) || a.index - b.index)
    .map(({ row }) => ({
      title: row.title,
      url: row.url,
      snippet: row.snippet ?? '',
      source_engine: row.provider ?? '',
      citation_id: row.citation_id || undefined,
      relevance_score: row.relevance_score ?? undefined,
      published: row.publication_date || undefined,
    }));
}

/**
 * What a retry should answer from, or null when there is nothing to reuse and the question has to be
 * searched again. The live list wins when it answers the same question, because it is the same run.
 */
export function reuseForRetry({
  question,
  conversationId,
  lastQuery,
  live,
  rows,
}: {
  question: string;
  conversationId?: string;
  lastQuery: string | null | undefined;
  live: Source[];
  rows: SourceRecord[];
}): Source[] | null {
  const asked = normalize(question);
  if (live.length > 0 && lastQuery && normalize(lastQuery) === asked) return live;
  const stored = sourcesFromRows(rows, { question, conversationId });
  return stored.length > 0 ? stored : null;
}
