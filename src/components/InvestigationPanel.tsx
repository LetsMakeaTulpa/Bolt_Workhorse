import { Source, Finding, ActivityLog, SourceRecord, type PromptCoverage } from '../types';
import { queryIntent } from '../lib/fusion';
import { describeIntent, rankSources, readScoreTerms } from '../lib/rankExplain';
import { modelSearchOrigin } from '../lib/machineTrace';
import { coverageCount, coverageSentence, matchesCoverageFilter, summarizeCoverage, type CoverageFilter } from '../lib/sourceCoverage';
import { SourceCard, type CardSource } from './SourceCard';
import { NoSourcesCard } from './NoSourcesCard';
import { Search, Bookmark, Share2, Trash2, Loader2, Globe, Activity, FileText, Shield, ChevronRight, PanelRightClose, Radar, RotateCw } from 'lucide-react';
import { SearchMap } from './SearchMap';
import type { LucideIcon } from 'lucide-react';
import { useState } from 'react';

interface InvestigationPanelProps {
  searchResults: Source[];
  /**
   * url → whether the prompt carried it, recorded on the saved answers. The panel's own rows are
   * written before the prompt exists, so without this every result looks equally model-visible.
   */
  promptCoverage?: Map<string, PromptCoverage>;
  /** the searches the model ran on its own this conversation, so a stored row can name its origin */
  modelSearches?: string[];
  /** the last run forced the freshness multiplier on, so a badge must not claim dates were ignored */
  forcedRecency?: boolean;
  /** the queries the function actually ran: a rewritten question is shown, not hidden */
  queriesUsed?: string[];
  /** run one of those queries again, exactly as it was written */
  onRunQuery?: (query: string) => void;
  /** the citation selected here or in the answer, shared by both so one press lights both */
  focusedCitation?: string | null;
  onFocusCitation?: (id: string | null) => void;
  isSearching: boolean;
  findings: Finding[];
  onUpdateFindingStatus: (id: string, status: 'saved' | 'shared' | 'discarded') => void;
  onRetrySearch: (query: string) => void;
  activityLogs: ActivityLog[];
  sources: SourceRecord[];
  /** query behind the current results, used to explain the ranking */
  query?: string;
  /** the gaps behind an empty run, listed in the panel rather than only in the answer */
  gaps?: string[];
  tab: PanelTab;
  onTabChange: (tab: PanelTab) => void;
  onCollapse: () => void;
}

export type PanelTab = 'map' | 'activity' | 'sources' | 'evidence';

export function InvestigationPanel({
  searchResults,
  promptCoverage,
  modelSearches = [],
  forcedRecency,
  queriesUsed,
  onRunQuery,
  focusedCitation,
  onFocusCitation,
  isSearching,
  findings,
  onUpdateFindingStatus,
  onRetrySearch,
  activityLogs,
  sources,
  query,
  gaps,
  tab,
  onTabChange,
  onCollapse,
}: InvestigationPanelProps) {
  return (
    <aside className="flex w-80 flex-col overflow-hidden rounded-xl border border-border-subtle bg-bg-deep">
      {/* the way out of the panel, said in words: an unlabelled chevron among the tabs was invisible */}
      <div className="flex items-center justify-between gap-2 border-b border-border-subtle px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">Investigation</span>
        <button
          type="button"
          onClick={onCollapse}
          title="Collapse panel"
          aria-label="Collapse panel"
          className="flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:border-accent/40 hover:bg-bg-hover hover:text-text-primary"
        >
          <PanelRightClose size={13} />
          <span>Collapse</span>
        </button>
      </div>

      <div className="flex items-center border-b border-border-subtle">
        <TabButton active={tab === 'map'} onClick={() => onTabChange('map')} icon={Radar} label="Map" count={searchResults.length} />
        <TabButton active={tab === 'activity'} onClick={() => onTabChange('activity')} icon={Activity} label="Activity" count={activityLogs.length} />
        <TabButton active={tab === 'sources'} onClick={() => onTabChange('sources')} icon={Globe} label="Sources" count={sources.length} />
        <TabButton active={tab === 'evidence'} onClick={() => onTabChange('evidence')} icon={Shield} label="Findings" count={findings.length} />
      </div>

      <div className={`flex-1 overflow-y-auto ${tab === 'map' ? '' : 'p-3'}`}>
        {tab === 'map' && <SearchMap results={searchResults} isSearching={isSearching} />}
        {tab === 'activity' && <ActivityTab logs={activityLogs} isSearching={isSearching} />}
        {tab === 'sources' && (
          <SourcesTab
            results={searchResults}
            sources={sources}
            isSearching={isSearching}
            query={query}
            gaps={gaps}
            promptCoverage={promptCoverage}
            modelSearches={modelSearches}
            forcedRecency={forcedRecency}
            queriesUsed={queriesUsed}
            onRunQuery={onRunQuery}
            focusedCitation={focusedCitation}
            onFocusCitation={onFocusCitation}
            onRetrySearch={onRetrySearch}
          />
        )}
        {tab === 'evidence' && <FindingsTab findings={findings} onUpdateStatus={onUpdateFindingStatus} onRetrySearch={onRetrySearch} />}
      </div>
    </aside>
  );
}

function TabButton({ active, onClick, icon: Icon, label, count }: { active: boolean; onClick: () => void; icon: React.ElementType; label: string; count: number }) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-1.5 px-2 py-2.5 text-[11px] font-medium transition-colors ${
        active ? 'border-b-2 border-accent text-text-primary' : 'text-text-secondary hover:text-text-primary border-b-2 border-transparent'
      }`}
    >
      <Icon size={13} />
      <span>{label}</span>
      {count > 0 && <span className="text-text-muted">({count})</span>}
    </button>
  );
}

function ActivityTab({ logs, isSearching }: { logs: ActivityLog[]; isSearching: boolean }) {
  if (logs.length === 0 && !isSearching) {
    return (
      <div className="flex flex-col items-center justify-center py-10">
        <Activity size={28} className="text-text-muted mb-2" />
        <p className="text-xs text-text-secondary">No activity yet</p>
        <p className="text-[11px] text-text-muted mt-0.5">Agent actions will appear here</p>
      </div>
    );
  }

  const iconForType: Record<string, LucideIcon> = {
    search: Search, analyze: Activity, synthesize: FileText, plan: Activity,
    followup: ChevronRight, compile: FileText, rank: Globe, deduplicate: Globe,
  };

  return (
    <div className="space-y-1.5">
      {isSearching && (
        <div className="flex items-center gap-2 rounded-lg border border-olive/30 bg-olive-subtle px-3 py-2 text-[11px] text-olive animate-fade-in">
          <Loader2 size={12} className="animate-spin" />
          <span>Searching across engines...</span>
        </div>
      )}
      {logs.map((log) => {
        const Icon = iconForType[log.activity_type] ?? Activity;
        return (
          <div key={log.id} className="rounded-lg border border-border-subtle bg-bg-surface p-2.5 animate-slide-right">
            <div className="flex items-start gap-2">
              <div className={`mt-0.5 ${log.status === 'failed' ? 'text-error' : log.status === 'running' ? 'text-olive' : 'text-text-muted'}`}>
                {log.status === 'running' ? <Loader2 size={12} className="animate-spin" /> : <Icon size={12} />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-medium text-text-primary">{log.description}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-text-muted">
                  <span className="uppercase">{log.activity_type}</span>
                  <span>·</span>
                  <span>{new Date(log.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  {log.status === 'failed' && <span className="text-error">· failed</span>}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SourcesTab({
  results,
  sources,
  isSearching,
  query,
  gaps,
  promptCoverage,
  modelSearches = [],
  forcedRecency,
  queriesUsed = [],
  onRunQuery,
  focusedCitation,
  onFocusCitation,
  onRetrySearch,
}: {
  results: Source[];
  sources: SourceRecord[];
  isSearching: boolean;
  query?: string;
  /** url → whether the prompt carried it and why; absent when no saved answer recorded a verdict */
  promptCoverage?: Map<string, PromptCoverage>;
  /** the run behind these rows weighted dates regardless of the query's intent */
  forcedRecency?: boolean;
  /** what the function really searched for; empty when the run did not report it */
  queriesUsed?: string[];
  /** run one of those queries again, uncompiled */
  onRunQuery?: (query: string) => void;
  /** the citation selected in the answer, so its card can show the same state */
  focusedCitation?: string | null;
  /** select a citation from a card, lighting the sentences in the answer that cite it */
  onFocusCitation?: (id: string | null) => void;
  /** the searches the model ran on its own this conversation, so a stored row can name its origin */
  modelSearches?: string[];
  /** the gap lines the empty run recorded, so an empty page still explains itself */
  gaps?: string[];
  onRetrySearch?: (query: string) => void;
}) {
  // declared before the early returns: the tab can go from searching to listing between renders
  const [coverageFilter, setCoverageFilter] = useState<CoverageFilter>('all');

  if (isSearching) {
    return (
      <div className="flex flex-col items-center justify-center py-10">
        <Loader2 size={20} className="animate-spin text-olive mb-2" />
        <p className="text-xs text-text-secondary">Retrieving sources...</p>
      </div>
    );
  }

  const displaySources: CardSource[] = sources.length > 0
    ? sources.map((s) => ({
        title: s.title,
        url: s.url,
        snippet: s.snippet,
        source_engine: s.provider,
        citation_id: s.citation_id,
        relevance_score: s.relevance_score,
        published: s.publication_date || undefined,
        query: s.original_query || query,
        found_by: modelSearchOrigin(s.original_query, modelSearches) ?? undefined,
        // the score's components are stored in the row's metadata; a row saved before fusion
        // recorded them yields nothing, and the card then says the components are unknown
        score_terms: readScoreTerms(s.metadata) ?? undefined,
        coverage_quota: s.metadata?.coverage_quota === true ? true : undefined,
        // a stored row cannot carry this itself: it is saved before the prompt is built
        prompt: promptCoverage?.get(s.url),
      }))
    : results.map((r) => ({
        ...r,
        citation_id: r.citation_id ?? '',
        relevance_score: r.relevance_score ?? 0,
        query,
        prompt: promptCoverage?.get(r.url),
      }));

  if (displaySources.length === 0) {
    // never a blank panel: after a run that found nothing it names the gaps and offers the next move
    return <NoSourcesCard query={query} gaps={gaps} onRetrySearch={onRetrySearch} />;
  }

  // One order instead of a section per provider: a rank is only worth showing if it matches where
  // the row sits, and grouping by engine would put a lower-scored source above a higher one.
  const ranked = rankSources(displaySources);
  const coverage = summarizeCoverage(displaySources);
  // a filter whose bucket emptied (a new run, a reloaded answer) falls back rather than hiding the list
  const activeFilter: CoverageFilter = coverageFilter === 'all' || coverageCount(coverage, coverageFilter) > 0 ? coverageFilter : 'all';
  const visible = ranked.filter((source) => matchesCoverageFilter(source, activeFilter));
  const filters = (
    [
      { value: 'all', label: 'All' },
      { value: 'reached', label: 'In prompt' },
      { value: 'left-out', label: 'Left out' },
      { value: 'unrecorded', label: 'Unrecorded' },
    ] as const
  ).filter(({ value }) => value === 'all' || coverageCount(coverage, value) > 0);

  const intent = describeIntent(queryIntent(query || displaySources[0]?.query || ''));

  return (
    <div className="space-y-3">
      {/* The rows each carry a chip, but the tab's real question is what the answer had in front of
          it. One sentence answers that for the whole list, and the filter lets the reader see only
          what did or did not get through. */}
      <div className="rounded-lg border border-border-subtle bg-bg-surface p-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">Prompt coverage</span>
          <span className="font-mono text-[10px] text-text-muted">
            {coverage.reached}/{coverage.total}
          </span>
        </div>
        <p className="mt-1 text-[10px] leading-tight text-text-secondary">{coverageSentence(coverage)}</p>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {filters.map(({ value, label }) => {
            const active = activeFilter === value;
            const count = coverageCount(coverage, value);
            return (
              <button
                key={value}
                type="button"
                onClick={() => setCoverageFilter(value)}
                aria-pressed={active}
                title={`Show ${count} ${count === 1 ? 'row' : 'rows'}: ${label.toLowerCase()}`}
                className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                  active
                    ? 'border-accent/40 bg-accent/15 text-text-primary'
                    : 'border-border-subtle bg-bg-elevated text-text-secondary hover:border-accent/30 hover:text-text-primary'
                }`}
              >
                {label}
                <span className="font-mono text-text-muted">{count}</span>
              </button>
            );
          })}
        </div>
        {coverage.withheld > 0 && (
          <p className="mt-1 text-[9px] leading-tight text-text-muted">
            Only what the prompt carried can support the answer; the rows left out are listed for you, not for the model.
          </p>
        )}
      </div>
      {/* A rewritten question looks like odd results unless the words that were actually sent are
          shown. Each chip re-runs its query exactly as written, without the compiler touching it. */}
      {queriesUsed.length > 0 && (
        <div className="rounded-lg border border-border-subtle bg-bg-surface p-2.5">
          <div className="flex items-baseline justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">Queries sent</span>
            <span className="font-mono text-[10px] text-text-muted">{queriesUsed.length}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {queriesUsed.map((expanded) => (
              <button
                key={expanded}
                type="button"
                onClick={() => onRunQuery?.(expanded)}
                disabled={!onRunQuery}
                title={`Search “${expanded}” again, exactly as it was sent — no rewriting`}
                className="flex max-w-full items-center gap-1 rounded-full border border-border-subtle bg-bg-elevated px-2 py-0.5 text-[10px] text-text-secondary transition-colors hover:border-accent/30 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
              >
                <span className="truncate">{expanded}</span>
                <RotateCw size={8} className="flex-shrink-0" />
              </button>
            ))}
          </div>
          <p className="mt-1 text-[9px] leading-tight text-text-muted">
            The queries the search function ran. When they differ from what you typed, the question was rewritten
            before any engine saw it.
          </p>
        </div>
      )}
      <div className="rounded-lg border border-border-subtle bg-bg-surface px-2.5 py-1.5">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">Ranking</span>
          <span className="rounded bg-bg-hover px-1.5 text-[10px] text-text-primary">{intent.label}</span>
        </div>
        <p className="mt-0.5 text-[9px] leading-tight text-text-muted">{intent.detail}</p>
      </div>
      <EngineSummary results={displaySources} />
      <div className="space-y-1.5">
        {visible.map((source) => (
          <SourceCard
            key={`${source.rank}-${source.url}`}
            source={source}
            rank={source.rank}
            forcedRecency={forcedRecency}
            focusedCitation={focusedCitation}
            onFocusCitation={onFocusCitation}
          />
        ))}
      </div>
    </div>
  );
}

interface EngineContribution {
  engine: string;
  count: number;
  share: number;
}

/**
 * Fusion labels a merged hit with every engine that supplied it (`exa+tavily`), so contribution
 * counts split on `+` — otherwise the summary would report "exa+tavily: 4" and hide the fact that
 * a lane contributed nothing.
 */
function summarizeContributions(results: { source_engine: string }[]): EngineContribution[] {
  const counts = new Map<string, number>();
  for (const result of results) {
    const engines = new Set(
      String(result.source_engine ?? '')
        .split('+')
        .map((engine) => engine.trim())
        .filter(Boolean),
    );
    for (const engine of engines) counts.set(engine, (counts.get(engine) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([engine, count]) => ({ engine, count, share: count / Math.max(1, results.length) }))
    .sort((a, b) => b.count - a.count || a.engine.localeCompare(b.engine));
}

function EngineSummary({ results }: { results: { source_engine: string }[] }) {
  const contributions = summarizeContributions(results);
  const merged = results.filter((result) => String(result.source_engine ?? '').includes('+')).length;

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-surface p-2.5">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">Engine contribution</span>
        <span className="text-[10px] text-text-muted font-mono">{contributions.length} engines</span>
      </div>
      <div className="space-y-1">
        {contributions.map(({ engine, count, share }) => (
          <div key={engine} className="flex items-center gap-2" title={`${engine}: ${count} of ${results.length} fused sources`}>
            <span className="w-20 flex-shrink-0 truncate text-[10px] text-text-secondary">{engine}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-hover">
              <div className="h-full rounded-full bg-olive/70" style={{ width: `${Math.max(4, Math.round(share * 100))}%` }} />
            </div>
            <span className="w-6 flex-shrink-0 text-right text-[10px] font-mono text-text-muted">{count}</span>
          </div>
        ))}
      </div>
      <div className="mt-1.5 border-t border-border-subtle pt-1 text-[9px] text-text-muted">
        {results.length} fused {results.length === 1 ? 'source' : 'sources'}
        {merged > 0 && ` · ${merged} confirmed by more than one engine`}
      </div>
    </div>
  );
}

function FindingsTab({
  findings,
  onUpdateStatus,
  onRetrySearch,
}: {
  findings: Finding[];
  onUpdateStatus: (id: string, status: 'saved' | 'shared' | 'discarded') => void;
  onRetrySearch: (query: string) => void;
}) {
  if (findings.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10">
        <Bookmark size={28} className="text-text-muted mb-2" />
        <p className="text-xs text-text-secondary">No saved findings</p>
        <p className="text-[11px] text-text-muted mt-0.5">Search results are saved automatically</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {findings.map((finding) => (
        <FindingCard key={finding.id} finding={finding} onUpdateStatus={onUpdateStatus} onRetrySearch={onRetrySearch} />
      ))}
    </div>
  );
}

function FindingCard({
  finding,
  onUpdateStatus,
  onRetrySearch,
}: {
  finding: Finding;
  onUpdateStatus: (id: string, status: 'saved' | 'shared' | 'discarded') => void;
  onRetrySearch: (query: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const handleShare = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (navigator.share) {
      navigator.share({ title: finding.title, url: finding.url }).catch(() => {});
    } else {
      navigator.clipboard?.writeText(finding.url);
    }
    onUpdateStatus(finding.id, 'shared');
  };

  const handleRetry = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRetrySearch(finding.query);
  };

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-surface p-2.5 transition-all hover:border-border">
      <div className="flex items-start justify-between gap-1.5">
        <button onClick={() => setExpanded(!expanded)} className="flex-1 text-left">
          <h4 className="text-[11px] font-medium text-text-primary line-clamp-2">{finding.title}</h4>
        </button>
        <span className="flex-shrink-0 rounded bg-bg-hover px-1.5 py-0.5 text-[9px] font-medium text-text-muted uppercase">
          {finding.source_engine}
        </span>
      </div>

      <p className={`mt-1 text-[10px] text-text-muted ${expanded ? '' : 'line-clamp-2'}`}>{finding.snippet}</p>

      <div className="mt-1.5 flex items-center justify-between">
        <a href={finding.url} target="_blank" rel="noopener noreferrer" className="truncate text-[10px] text-accent hover:underline flex-1 mr-2">
          {finding.url}
        </a>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            onClick={handleRetry}
            className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-olive transition-colors"
            title="Search only — run this finding's query again; no answer is written"
          >
            <Search size={11} />
          </button>
          <button onClick={handleShare} className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-accent transition-colors" title="Share">
            <Share2 size={11} />
          </button>
          <button onClick={() => onUpdateStatus(finding.id, 'discarded')} className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-error transition-colors" title="Discard">
            <Trash2 size={11} />
          </button>
        </div>
      </div>

      <div className="mt-1 text-[9px] text-text-muted">Query: "{finding.query}"</div>
    </div>
  );
}
