import { Clock, ExternalLink, Eye, EyeOff, Sparkles } from 'lucide-react';
import { queryIntent } from '../lib/fusion';
import { citationIdOf } from '../lib/citationFocus';
import type { PromptCoverage } from '../types';
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
   * whether the prompt carried this source and why it did or did not. Absent when no saved answer
   * recorded a verdict — unknown, not "never shown".
   */
  prompt?: PromptCoverage;
}

/**
 * What the chip says about one source, and the sentence behind it.
 *
 * "Left out" has causes that are not interchangeable: a follow-up search only offers its first
 * eight sources, a turn can build no prompt at all, and a source that is in the prompt can still
 * have had its page text cut at the cap. Saying "the model never saw it" for all of them hides
 * which one applies.
 */
function promptMark(prompt: PromptCoverage): { label: string; detail: string; carried: boolean } {
  if (prompt.inPrompt) {
    return prompt.reason === 'trimmed'
      ? {
          label: 'in prompt · text cut',
          detail: 'The prompt carried this page only up to the per-source character cap; the rest of it was never read',
          carried: true,
        }
      : { label: 'in prompt', detail: 'The saved answer carried this source to the model', carried: true };
  }
  if (prompt.reason === 'capped') {
    return {
      label: 'over the cap',
      detail: 'A follow-up search offers the model its first eight sources; this one stayed in the panel',
      carried: false,
    };
  }
  if (prompt.reason === 'no-prompt') {
    return {
      label: 'no prompt',
      detail: 'This turn built no prompt from its sources, so none of them reached the model',
      carried: false,
    };
  }
  return { label: 'panel only', detail: 'The saved answer left this source out of the prompt', carried: false };
}

/**
 * A retrieved source with the badge row that explains its position: the RRF score, what the date
 * did (or did not) buy, and how this engine was weighted for this query.
 *
 * Both badges come from `rankExplain`, which runs the same `queryIntent` / `engineWeights` the
 * ranking used, so a card cannot claim a multiplier the score did not apply. `rank` is the row's
 * position in the sorted list, so the score and the badges explain why the card is where it is.
 */
export function SourceCard({
  source,
  rank,
  forcedRecency = false,
  focusedCitation,
  onFocusCitation,
}: {
  source: CardSource;
  rank?: number;
  /** the list was ranked with the freshness multiplier forced on, so the badge must say so */
  forcedRecency?: boolean;
  /** the citation the answer has selected, so this card can show the same state */
  focusedCitation?: string | null;
  /** select this card's citation, lighting the sentences that cite it; null clears */
  onFocusCitation?: (id: string | null) => void;
}) {
  const url = source.url;
  const title = source.title;
  const snippet = source.snippet;
  const citationId = source.citation_id ?? '';
  // the same id the answer's markers and rows use, so a press here needs nothing stored
  const answerId = citationIdOf(citationId);
  const active = answerId !== '' && focusedCitation === answerId;
  const selectable = answerId !== '' && Boolean(onFocusCitation);
  const toggle = () => onFocusCitation?.(active ? null : answerId);
  const score = source.relevance_score;
  const intent = queryIntent(source.query ?? '');
  const recency = recencyBadge(source.published, intent, Date.now(), forcedRecency);
  const routing = intentBadge(source.source_engine, source.query ?? '');
  const mark = source.prompt ? promptMark(source.prompt) : null;

  return (
    <div
      className={`group relative block rounded-lg border p-2.5 transition-all ${
        active
          ? 'border-accent/40 bg-accent/15'
          : 'border-border-subtle bg-bg-surface hover:border-accent/25 hover:bg-bg-elevated'
      } ${selectable ? 'cursor-pointer' : ''}`}
      role={selectable ? 'button' : undefined}
      tabIndex={selectable ? 0 : undefined}
      aria-pressed={selectable ? active : undefined}
      title={
        selectable
          ? active
            ? `Stop highlighting the sentences citing ${citationId}`
            : `Highlight the sentences in the answer that cite ${citationId}`
          : undefined
      }
      onClick={selectable ? toggle : undefined}
      onKeyDown={
        selectable
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggle();
              }
            }
          : undefined
      }
    >
      {/* the card is the selection control now, so opening the page needs its own visible target */}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title={`Open ${title}`}
        onClick={(event) => event.stopPropagation()}
        className="absolute right-2 top-2 rounded p-0.5 text-text-muted transition-colors hover:text-accent"
      >
        <ExternalLink size={10} />
      </a>
      <div className="flex items-start justify-between gap-1.5 pr-4">
        <div className="flex items-start gap-1.5 flex-1 min-w-0">
          {citationId && <span className="flex-shrink-0 text-[10px] font-mono text-accent mt-0.5">{citationId}</span>}
          <h4 className="text-[11px] font-medium text-text-primary line-clamp-2 flex-1">{title}</h4>
        </div>
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
        {mark && (
          // the panel lists what the search returned; this says what the prompt did with it, and
          // why, so a panel-only result is not mistaken for evidence behind the answer
          <span
            title={mark.detail}
            className={`flex items-center gap-0.5 rounded border px-1 py-0.5 font-mono ${
              mark.carried
                ? 'border-accent/30 bg-accent-subtle text-accent'
                : 'border-warning/30 bg-warning-subtle text-warning'
            }`}
          >
            {mark.carried ? <Eye size={8} /> : <EyeOff size={8} />}
            {mark.label}
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
    </div>
  );
}
