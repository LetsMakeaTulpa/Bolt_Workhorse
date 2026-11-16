import { Source, Finding, ActivityLog, SourceRecord } from '../types';
import { queryIntent } from '../lib/fusion';
import { describeIntent, intentBadge, recencyBadge } from '../lib/rankExplain';
import { Search, ExternalLink, Bookmark, Share2, Trash2, Loader2, Globe, Activity, FileText, Shield, ChevronRight, PanelRightClose, Radar, Clock, Sparkles } from 'lucide-react';
import { SearchMap } from './SearchMap';
import type { LucideIcon } from 'lucide-react';
import { useState } from 'react';

interface InvestigationPanelProps {
  searchResults: Source[];
  isSearching: boolean;
  findings: Finding[];
  onUpdateFindingStatus: (id: string, status: 'saved' | 'shared' | 'discarded') => void;
  onRetrySearch: (query: string) => void;
  activityLogs: ActivityLog[];
  sources: SourceRecord[];
  /** query behind the current results, used to explain the ranking */
  query?: string;
  tab: PanelTab;
  onTabChange: (tab: PanelTab) => void;
  onCollapse: () => void;
}

export type PanelTab = 'map' | 'activity' | 'sources' | 'evidence';

export function InvestigationPanel({
  searchResults,
  isSearching,
  findings,
  onUpdateFindingStatus,
  onRetrySearch,
  activityLogs,
  sources,
  query,
  tab,
  onTabChange,
  onCollapse,
}: InvestigationPanelProps) {
  return (
    <aside className="flex w-80 flex-col border-l border-border-subtle bg-bg-deep">
      <div className="flex items-center border-b border-border-subtle">
        <TabButton active={tab === 'map'} onClick={() => onTabChange('map')} icon={Radar} label="Map" count={searchResults.length} />
        <TabButton active={tab === 'activity'} onClick={() => onTabChange('activity')} icon={Activity} label="Activity" count={activityLogs.length} />
        <TabButton active={tab === 'sources'} onClick={() => onTabChange('sources')} icon={Globe} label="Sources" count={sources.length} />
        <TabButton active={tab === 'evidence'} onClick={() => onTabChange('evidence')} icon={Shield} label="Findings" count={findings.length} />
        <button
          onClick={onCollapse}
          className="px-2 self-stretch text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
          title="Collapse panel"
          aria-label="Collapse panel"
        >
          <PanelRightClose size={14} />
        </button>
      </div>

      <div className={`flex-1 overflow-y-auto ${tab === 'map' ? '' : 'p-3'}`}>
        {tab === 'map' && <SearchMap results={searchResults} isSearching={isSearching} />}
        {tab === 'activity' && <ActivityTab logs={activityLogs} isSearching={isSearching} />}
        {tab === 'sources' && (
          <SourcesTab results={searchResults} sources={sources} isSearching={isSearching} query={query} />
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

interface CardSource {
  title: string;
  url: string;
  snippet: string;
  source_engine: string;
  citation_id?: string;
  relevance_score?: number;
  published?: string;
  /** the query this source answered, kept per row so a reloaded list still explains itself */
  query?: string;
}

function SourcesTab({
  results,
  sources,
  isSearching,
  query,
}: {
  results: Source[];
  sources: SourceRecord[];
  isSearching: boolean;
  query?: string;
}) {
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
      }))
    : results.map((r) => ({ ...r, citation_id: r.citation_id ?? '', relevance_score: r.relevance_score ?? 0, query }));

  if (displaySources.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10">
        <Globe size={28} className="text-text-muted mb-2" />
        <p className="text-xs text-text-secondary">No sources retrieved yet</p>
        <p className="text-[11px] text-text-muted mt-0.5">Send a question with search enabled</p>
      </div>
    );
  }

  // Group by provider
  const grouped: Record<string, typeof displaySources> = {};
  for (const s of displaySources) {
    const engine = s.source_engine;
    if (!grouped[engine]) grouped[engine] = [];
    grouped[engine].push(s);
  }

  const intent = describeIntent(queryIntent(query || displaySources[0]?.query || ''));

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border-subtle bg-bg-surface px-2.5 py-1.5">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">Ranking</span>
          <span className="rounded bg-bg-hover px-1.5 text-[10px] text-text-primary">{intent.label}</span>
        </div>
        <p className="mt-0.5 text-[9px] leading-tight text-text-muted">{intent.detail}</p>
      </div>
      <EngineSummary results={displaySources} />
      {Object.entries(grouped).map(([engine, items]) => (
        <div key={engine}>
          <div className="mb-1.5 flex items-center gap-1.5">
            <Globe size={10} className="text-olive" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">{engine.split('+').join(' + ')}</span>
            <span className="text-[10px] text-text-muted">({items.length})</span>
          </div>
          <div className="space-y-1.5">
            {items.map((r, i) => (
              <SourceCard key={`${engine}-${i}`} source={r} />
            ))}
          </div>
        </div>
      ))}
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

function SourceCard({ source }: { source: CardSource }) {
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
          <button onClick={handleRetry} className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-olive transition-colors" title="Retry search">
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
