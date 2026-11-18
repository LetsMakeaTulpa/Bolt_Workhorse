import { Clock, ExternalLink, Eye, EyeOff, Sparkles } from 'lucide-react';
import { queryIntent } from '../lib/fusion';
import { intentBadge, recencyBadge } from '../lib/rankExplain';

/** One row of the Sources panel: what was retrieved, and how the ranking treated it. */
export interface CardSource {
  title: string;
  url: string;
  snippet: string;
  source_engine: string;
  citation_id?: string;
  relevance_score?: number;
  published?: string;
  /** the query this source answered, kept per row so a reloaded list still explains itself */
  query?: string;
  /**
   * whether the prompt carried this source: true = the model could read it, false = panel only.
   * Absent when no saved answer recorded a verdict — unknown, not "never shown".
   */
  in_prompt?: boolean;
}

/**
 * A retrieved source with the badge row that explains its position: the RRF score, what the date
 * did (or did not) buy, and how this engine was weighted for this query.
 *
 * Both badges come from `rankExplain`, which runs the same `queryIntent` / `engineWeights` the
 * ranking used, so a card cannot claim a multiplier the score did not apply. `rank` is the row's
 * position in the sorted list, so the score and the badges explain why the card is where it is.
 */
export function SourceCard({ source, rank }: { source: CardSource; rank?: number }) {
  const url = source.url;
  const title = source.title;
  const snippet = source.snippet;
  const citationId = source.citation_id ?? '';
  const score = source.relevance_score;
  const intent = queryIntent(source.query ?? '');
  const recency = recencyBadge(source.published, intent);
  const routing = intentBadge(source.source_engine, source.query ?? '');

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="block rounded-lg border border-border-subtle bg-bg-surface p-2.5 transition-all hover:border-accent/25 hover:bg-bg-elevated group"
    >
      <div className="flex items-start justify-between gap-1.5">
        <div className="flex items-start gap-1.5 flex-1 min-w-0">
          {citationId && <span className="flex-shrink-0 text-[10px] font-mono text-accent mt-0.5">{citationId}</span>}
          <h4 className="text-[11px] font-medium text-text-primary line-clamp-2 flex-1">{title}</h4>
        </div>
        <ExternalLink size={10} className="flex-shrink-0 text-text-muted opacity-0 group-hover:opacity-100 mt-0.5" />
      </div>
      <p className="mt-1 text-[10px] text-text-muted line-clamp-2">{snippet}</p>
      <div className="mt-1 truncate text-[10px] text-accent/70">{url}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1 text-[9px]">
        {rank !== undefined && (
          <span
            className="rounded border border-border-subtle bg-bg-hover px-1 py-0.5 font-mono font-semibold text-text-primary"
            title={`Position ${rank} in this list, highest fusion score first`}
          >
            #{rank}
          </span>
        )}
        {typeof source.in_prompt === 'boolean' && (
          // the panel lists what the search returned; this says which of it the model ever read,
          // so a panel-only result is not mistaken for evidence behind the answer
          <span
            title={
              source.in_prompt
                ? 'The saved answer carried this source to the model'
                : 'Retrieved and listed here, but left out of the prompt — the model never saw it'
            }
            className={`flex items-center gap-0.5 rounded border px-1 py-0.5 font-mono ${
              source.in_prompt
                ? 'border-accent/30 bg-accent-subtle text-accent'
                : 'border-warning/30 bg-warning-subtle text-warning'
            }`}
          >
            {source.in_prompt ? <Eye size={8} /> : <EyeOff size={8} />}
            {source.in_prompt ? 'in prompt' : 'panel only'}
          </span>
        )}
        {score !== undefined && score > 0 && (
          <span className="font-mono text-text-muted" title="Reciprocal-rank-fusion score for this source">
            RRF {score.toFixed(4)}
          </span>
        )}
        <span
          title={recency.detail}
          className={`flex items-center gap-0.5 rounded border px-1 py-0.5 font-mono ${
            recency.tier === 'fresh'
              ? 'border-olive/30 bg-olive-subtle text-olive'
              : 'border-border-subtle text-text-muted'
          }`}
        >
          <Clock size={8} />
          {recency.tier === 'undated'
            ? 'no date'
            : `${recency.published!.slice(0, 10)} ${recency.tier === 'ignored' ? 'ignored' : `×${recency.multiplier.toFixed(2)}`}`}
        </span>
        {routing && (
          <span
            title={routing.detail}
            className={`flex items-center gap-0.5 rounded border px-1 py-0.5 ${
              routing.delta > 0.001
                ? 'border-accent/30 bg-accent-subtle text-accent'
                : routing.delta < -0.001
                  ? 'border-warning/30 bg-warning-subtle text-warning'
                  : 'border-border-subtle text-text-muted'
            }`}
          >
            <Sparkles size={8} />
            {routing.intent} · {routing.engine} ×{routing.weight.toFixed(2)}
          </span>
        )}
      </div>
    </a>
  );
}
