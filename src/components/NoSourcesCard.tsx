import { Globe, RotateCw, Search } from 'lucide-react';
import { broadenQuery } from '../lib/emptyResult';

/**
 * The Sources panel after a search that collected nothing.
 *
 * The panel used to say "No sources retrieved yet — send a question with search enabled" even when a
 * question had just run and every engine came back empty: an empty page with no explanation and
 * nothing to press. This names the gaps the turn recorded and offers the two query-level next steps,
 * so a dead search is still a page that can be acted on rather than a blank one.
 */
export function NoSourcesCard({
  query,
  gaps = [],
  onRetrySearch,
}: {
  /** the query the empty run was for; without one, no search has run yet */
  query?: string;
  gaps?: string[];
  onRetrySearch?: (query: string) => void;
}) {
  if (!query) {
    return (
      <div className="flex flex-col items-center justify-center py-10">
        <Globe size={28} className="text-text-muted mb-2" />
        <p className="text-xs text-text-secondary">No sources retrieved yet</p>
        <p className="text-[11px] text-text-muted mt-0.5">Send a question with search enabled</p>
      </div>
    );
  }

  const wider = broadenQuery(query);

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-surface p-2.5">
      <div className="flex items-center gap-1.5">
        <Globe size={12} className="flex-shrink-0 text-warning" />
        <p className="text-xs font-medium text-text-primary">No usable sources this run</p>
      </div>
      <p className="mt-0.5 truncate text-[10px] text-text-muted" title={query}>
        for “{query}”
      </p>
      {gaps.length > 0 && (
        <ul className="mt-1.5 space-y-1 text-[10px] leading-tight text-text-muted">
          {gaps.map((gap) => (
            <li key={gap} className="flex gap-1">
              <span className="flex-shrink-0 text-warning">•</span>
              <span>{gap}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => onRetrySearch?.(wider)}
          disabled={!onRetrySearch}
          title={`Search again for “${wider}” — operators and the most specific words removed`}
          className="flex items-center gap-1 rounded-md border border-accent/30 bg-accent-subtle px-2 py-1 text-[10px] text-accent transition-colors hover:bg-accent hover:text-bg-base disabled:cursor-not-allowed disabled:opacity-30"
        >
          <Search size={10} />
          Search wider: “{wider}”
        </button>
        <button
          type="button"
          onClick={() => onRetrySearch?.(query)}
          disabled={!onRetrySearch}
          title={`Run “${query}” again`}
          className="flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-[10px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
        >
          <RotateCw size={10} />
          Search again
        </button>
      </div>
    </div>
  );
}
