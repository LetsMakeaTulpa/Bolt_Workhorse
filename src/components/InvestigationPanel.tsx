import { Source, Finding, ActivityLog, SourceRecord } from '../types';
import { Search, ExternalLink, Bookmark, Share2, Trash2, Loader2, Globe, Activity, FileText, Shield, ChevronRight } from 'lucide-react';
import { useState } from 'react';

interface InvestigationPanelProps {
  searchResults: Source[];
  isSearching: boolean;
  findings: Finding[];
  onUpdateFindingStatus: (id: string, status: 'saved' | 'shared' | 'discarded') => void;
  onRetrySearch: (query: string) => void;
  activityLogs: ActivityLog[];
  sources: SourceRecord[];
}

type Tab = 'activity' | 'sources' | 'evidence';

export function InvestigationPanel({
  searchResults,
  isSearching,
  findings,
  onUpdateFindingStatus,
  onRetrySearch,
  activityLogs,
  sources,
}: InvestigationPanelProps) {
  const [tab, setTab] = useState<Tab>('activity');

  return (
    <aside className="flex w-80 flex-col border-l border-border-subtle bg-bg-deep">
      <div className="flex border-b border-border-subtle">
        <TabButton active={tab === 'activity'} onClick={() => setTab('activity')} icon={Activity} label="Activity" count={activityLogs.length} />
        <TabButton active={tab === 'sources'} onClick={() => setTab('sources')} icon={Globe} label="Sources" count={sources.length} />
        <TabButton active={tab === 'evidence'} onClick={() => setTab('evidence')} icon={Shield} label="Findings" count={findings.length} />
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {tab === 'activity' && <ActivityTab logs={activityLogs} isSearching={isSearching} />}
        {tab === 'sources' && <SourcesTab results={searchResults} sources={sources} isSearching={isSearching} />}
        {tab === 'evidence' && <FindingsTab findings={findings} onUpdateStatus={onUpdateFindingStatus} onRetrySearch={onRetrySearch} />}
      </div>
    </aside>
  );
}

function TabButton({ active, onClick, icon: Icon, label, count }: { active: boolean; onClick: () => void; icon: React.ComponentType<{ size?: number; className?: string }>; label: string; count: number }) {
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

  const iconForType: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
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

function SourcesTab({ results, sources, isSearching }: { results: Source[]; sources: SourceRecord[]; isSearching: boolean }) {
  if (isSearching) {
    return (
      <div className="flex flex-col items-center justify-center py-10">
        <Loader2 size={20} className="animate-spin text-olive mb-2" />
        <p className="text-xs text-text-secondary">Retrieving sources...</p>
      </div>
    );
  }

  const displaySources = sources.length > 0
    ? sources.map((s) => ({ title: s.title, url: s.url, snippet: s.snippet, source_engine: s.provider, citation_id: s.citation_id, relevance_score: s.relevance_score }))
    : results;

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

  return (
    <div className="space-y-3">
      {Object.entries(grouped).map(([engine, items]) => (
        <div key={engine}>
          <div className="mb-1.5 flex items-center gap-1.5">
            <Globe size={10} className="text-olive" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">{engine}</span>
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

function SourceCard({ source }: { source: Source | SourceRecord }) {
  const url = 'url' in source ? source.url : '';
  const title = 'title' in source ? source.title : '';
  const snippet = 'snippet' in source ? source.snippet : '';
  const citationId = 'citation_id' in source ? source.citation_id : '';
  const score = 'relevance_score' in source ? source.relevance_score : undefined;

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
      {score !== undefined && score > 0 && (
        <div className="mt-0.5 text-[9px] text-text-muted font-mono">RRF score: {score.toFixed(4)}</div>
      )}
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
