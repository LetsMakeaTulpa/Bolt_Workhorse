import { useState } from 'react';
import { ChevronDown, Clock, ExternalLink, Eye, EyeOff, Layers, Search, Sparkles } from 'lucide-react';
import { queryIntent } from '../lib/fusion';
import { citationIdOf } from '../lib/citationFocus';
import type { PromptCoverage, ScoreTerms } from '../types';
import { intentBadge, recencyBadge, scoreTermRows } from '../lib/rankExplain';

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
  /** the model's own extra search that brought this row in, when one did */
  found_by?: string;
  /**
   * whether the prompt carried this source and why it did or did not. Absent when no saved answer
   * recorded a verdict — unknown, not "never shown".
   */
  prompt?: PromptCoverage;
  /** the components of the fusion score, when the row recorded them */
  score_terms?: ScoreTerms;
  /** the row is here because the coverage quota kept its engine represented, not for its score */
  coverage_quota?: boolean;
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
  /** the breakdown is a disclosure: the badge row stays the summary it was */
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const terms = source.score_terms;
  const breakdownRows = terms ? scoreTermRows(terms) : [];
  const canExplain = Boolean(terms) || (typeof score === 'number' && score > 0) || source.coverage_quota === true;
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
        {source.found_by && (
          // the chip strip under the answer names the searches; this says which of them produced
          // this row, so the panel can be read on its own
          <span
            title={`Brought in by the model's own search “${source.found_by}”, not by the question you asked`}
            className="flex items-center gap-0.5 rounded border border-accent/30 bg-accent-subtle px-1 py-0.5 font-mono text-accent"
          >
            <Search size={8} />
            <span className="max-w-[9rem] truncate">via “{source.found_by}”</span>
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
        {source.coverage_quota && (
          <span
            title="Kept by the coverage quota: this row is in the list because its engine would otherwise be missing, not because its score reached the cut"
            className="flex items-center gap-0.5 rounded border border-border-subtle bg-bg-hover px-1 py-0.5 font-mono text-text-muted"
          >
            <Layers size={8} />
            coverage quota
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

      {/* Why this row sits here: the score's factors, with the arithmetic, so the order can be
          checked rather than taken on trust. A row saved before the terms were recorded says so. */}
      {canExplain && (
        <div className="mt-1">
          <button
            type="button"
            data-score-breakdown={url}
            aria-expanded={breakdownOpen}
            onClick={(event) => {
              event.stopPropagation();
              setBreakdownOpen((open) => !open);
            }}
            onKeyDown={(event) => event.stopPropagation()}
            title={
              terms
                ? 'Show the engine weight, rank term, coverage, freshness and agreement that produced this score'
                : 'Show what was recorded about this score'
            }
            className="flex items-center gap-0.5 rounded px-0.5 text-[9px] text-text-muted transition-colors hover:text-text-primary"
          >
            <ChevronDown
              size={9}
              className={`flex-shrink-0 transition-transform ${breakdownOpen ? 'rotate-180' : ''}`}
            />
            Why this rank
          </button>
          {breakdownOpen &&
            (terms ? (
              <dl
                data-score-terms={url}
                className="mt-1 space-y-0.5 rounded border border-border-subtle bg-bg-deep px-2 py-1.5 text-[9px]"
              >
                {breakdownRows.map((row) => (
                  <div key={row.label} title={row.detail} className="flex items-baseline justify-between gap-2">
                    <dt className="text-text-muted">{row.label}</dt>
                    <dd className="flex-shrink-0 font-mono text-text-secondary">{row.value}</dd>
                  </div>
                ))}
                {source.coverage_quota && (
                  <p className="border-t border-border-subtle pt-1 text-warning">
                    In this list via the coverage quota: its engine&rsquo;s best result scored below the cut.
                  </p>
                )}
              </dl>
            ) : (
              <div className="mt-1 rounded border border-border-subtle bg-bg-deep px-2 py-1.5 text-[9px]">
                <p className="text-text-muted">
                  This row was saved with its total score only — the components behind it were not recorded.
                </p>
                {/* the placement is known from the row itself even when the score behind it is not */}
                {source.coverage_quota && (
                  <p className="mt-1 border-t border-border-subtle pt-1 text-warning">
                    In this list via the coverage quota: its engine&rsquo;s best result scored below the cut.
                  </p>
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
