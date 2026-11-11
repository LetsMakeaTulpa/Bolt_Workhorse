import { SearchResult, Finding } from '../types';
import { Search, ExternalLink, Bookmark, Share2, Trash2, RotateCw, Loader2, Globe } from 'lucide-react';
import { useState } from 'react';

interface SearchPanelProps {
  searchResults: SearchResult[];
  isSearching: boolean;
  findings: Finding[];
  onUpdateFindingStatus: (id: string, status: 'saved' | 'shared' | 'discarded') => void;
  onRetrySearch: (query: string) => void;
}

export function SearchPanel({
  searchResults,
  isSearching,
  findings,
  onUpdateFindingStatus,
  onRetrySearch,
}: SearchPanelProps) {
  const [tab, setTab] = useState<'results' | 'findings'>('results');

  return (
    <aside className="flex w-96 flex-col border-l border-border-subtle bg-bg-surface">
      {/* Tabs */}
      <div className="flex border-b border-border-subtle">
        <button
          onClick={() => setTab('results')}
          className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
            tab === 'results'
              ? 'border-b-2 border-accent text-text-primary'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          Search Results ({searchResults.length})
        </button>
        <button
          onClick={() => setTab('findings')}
          className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
            tab === 'findings'
              ? 'border-b-2 border-accent text-text-primary'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          Saved Findings ({findings.length})
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3">
        {tab === 'results' ? (
          <SearchResultsTab results={searchResults} isSearching={isSearching} onRetrySearch={onRetrySearch} />
        ) : (
          <FindingsTab findings={findings} onUpdateStatus={onUpdateFindingStatus} />
        )}
      </div>
    </aside>
  );
}

function SearchResultsTab({
  results,
  isSearching,
  onRetrySearch,
}: {
  results: SearchResult[];
  isSearching: boolean;
  onRetrySearch: (query: string) => void;
}) {
  if (isSearching) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <Loader2 size={24} className="animate-spin text-accent mb-3" />
        <p className="text-sm text-text-secondary">Searching across multiple engines...</p>
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <Search size={32} className="text-text-muted mb-3" />
        <p className="text-sm text-text-secondary">No search results yet</p>
        <p className="text-xs text-text-muted mt-1">Send a message with search enabled</p>
      </div>
    );
  }

  // Group by engine
  const grouped: Record<string, SearchResult[]> = {};
  for (const r of results) {
    if (!grouped[r.source_engine]) grouped[r.source_engine] = [];
    grouped[r.source_engine].push(r);
  }

  return (
    <div className="space-y-4">
      {Object.entries(grouped).map(([engine, items]) => (
        <div key={engine}>
          <div className="mb-2 flex items-center gap-2">
            <Globe size={12} className="text-accent" />
            <span className="text-xs font-medium uppercase tracking-wider text-text-muted">{engine}</span>
            <span className="text-xs text-text-muted">({items.length})</span>
          </div>
          <div className="space-y-2">
            {items.map((r, i) => (
              <SearchResultCard key={`${engine}-${i}`} result={r} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function SearchResultCard({ result }: { result: SearchResult }) {
  return (
    <a
      href={result.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block rounded-lg border border-border-subtle bg-bg-elevated p-3 transition-all hover:border-accent/30 hover:bg-bg-hover group"
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-sm font-medium text-text-primary line-clamp-2 flex-1">{result.title}</h4>
        <ExternalLink size={12} className="flex-shrink-0 text-text-muted opacity-0 group-hover:opacity-100 mt-0.5" />
      </div>
      <p className="mt-1.5 text-xs text-text-muted line-clamp-2">{result.snippet}</p>
      <div className="mt-2 truncate text-xs text-accent">{result.url}</div>
    </a>
  );
}

function FindingsTab({
  findings,
  onUpdateStatus,
}: {
  findings: Finding[];
  onUpdateStatus: (id: string, status: 'saved' | 'shared' | 'discarded') => void;
}) {
  if (findings.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <Bookmark size={32} className="text-text-muted mb-3" />
        <p className="text-sm text-text-secondary">No saved findings</p>
        <p className="text-xs text-text-muted mt-1">Search results are saved automatically</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {findings.map((finding) => (
        <FindingCard key={finding.id} finding={finding} onUpdateStatus={onUpdateStatus} />
      ))}
    </div>
  );
}

function FindingCard({
  finding,
  onUpdateStatus,
}: {
  finding: Finding;
  onUpdateStatus: (id: string, status: 'saved' | 'shared' | 'discarded') => void;
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

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-elevated p-3 transition-all hover:border-border">
      <div className="flex items-start justify-between gap-2">
        <button onClick={() => setExpanded(!expanded)} className="flex-1 text-left">
          <h4 className="text-sm font-medium text-text-primary line-clamp-2">{finding.title}</h4>
        </button>
        <span className="flex-shrink-0 rounded-md bg-bg-hover px-1.5 py-0.5 text-[10px] font-medium text-text-muted uppercase">
          {finding.source_engine}
        </span>
      </div>

      <p className={`mt-1.5 text-xs text-text-muted ${expanded ? '' : 'line-clamp-2'}`}>{finding.snippet}</p>

      <div className="mt-2 flex items-center justify-between">
        <a
          href={finding.url}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate text-xs text-accent hover:underline flex-1 mr-2"
        >
          {finding.url}
        </a>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={handleShare}
            className="rounded-md p-1.5 text-text-muted hover:bg-bg-hover hover:text-accent transition-colors"
            title="Share"
          >
            <Share2 size={13} />
          </button>
          <button
            onClick={() => onUpdateStatus(finding.id, 'discarded')}
            className="rounded-md p-1.5 text-text-muted hover:bg-bg-hover hover:text-error transition-colors"
            title="Discard"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      <div className="mt-1.5 text-[10px] text-text-muted">
        Query: "{finding.query}"
      </div>
    </div>
  );
}
