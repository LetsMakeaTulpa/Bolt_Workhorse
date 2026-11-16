import { Message, Source } from '../types';
import { MessageBubble } from './MessageBubble';
import { SearchBar } from './SearchBar';
import { EngineKeyRow } from './EngineKeyRow';
import { WelcomeScreen } from './WelcomeScreen';
import { useState } from 'react';
import { Globe, Loader2, AlertTriangle, Filter, ChevronDown } from 'lucide-react';
import { ENGINE_LABELS } from '../lib/engines';
import type { EngineIssue } from '../lib/engines';
import { laneContribution, summarizeLaneYield } from '../lib/fusion';
import type { LaneYield } from '../lib/fusion';

interface ChatAreaProps {
  messages: Message[];
  isStreaming: boolean;
  streamingContent: string;
  onSendMessage: (content: string) => void;
  searchEnabled: boolean;
  isSearching: boolean;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  presetName: string;
  onSearch: (query: string) => void;
  onRunLane?: (lane: string, target: string) => void;
  searchLabel?: string;
  /** engines that could not answer, shown so an empty result list explains itself */
  engineIssues?: EngineIssue[];
  /** what each engine returned last run, and what the relevance gate threw away */
  laneYield?: LaneYield[];
  /** the relevance gate kept nothing, so the closest results were shown anyway */
  relaxedGate?: boolean;
  rawOnly?: boolean;
  onRawOnlyChange?: (value: boolean) => void;
  engines: string[];
  onEnginesChange: (engines: string[]) => void;
  useDorks: boolean;
  onUseDorksChange: (value: boolean) => void;
  /** stop the running search, keeping whatever it has already collected */
  onCancelSearch?: () => void;
  /** secret names this account has stored — names only, never values */
  storedKeyNames?: string[];
  /** secret names the deployment holds; null when the function could not be asked */
  deploymentKeyNames?: string[] | null;
  /** the per-account keys table is missing from the project */
  keysUnavailable?: boolean;
  onOpenSettings?: () => void;
  onRetrySearch?: (query: string) => void;
  onSaveResults?: (query: string, results: Source[]) => Promise<number>;
  onFollowUp?: (question: string) => void;
}

export function ChatArea({
  messages,
  isStreaming,
  onSendMessage,
  searchEnabled,
  isSearching,
  messagesEndRef,
  presetName,
  onSearch,
  onRunLane,
  searchLabel,
  engineIssues,
  laneYield,
  relaxedGate,
  rawOnly,
  onRawOnlyChange,
  engines,
  onEnginesChange,
  useDorks,
  onUseDorksChange,
  onCancelSearch,
  storedKeyNames,
  deploymentKeyNames,
  keysUnavailable,
  onOpenSettings,
  onRetrySearch,
  onSaveResults,
  onFollowUp,
}: ChatAreaProps) {
  // an engine that failed for its own reason is named by the issue strip; counting it as dead here
  // would flag the same engine twice for two different causes
  const explained = (engineIssues ?? [])
    .filter((issue) => issue.severity === 'warning')
    .map((issue) => issue.engine);
  const { dead: deadLanes, wasted: offTopicLanes } = laneContribution(
    summarizeLaneYield(laneYield ?? []),
    explained,
  );
  /** the engine whose dropped results are listed, if any: the count alone is not judgeable */
  const [openDropped, setOpenDropped] = useState<string | null>(null);
  const droppedRow = offTopicLanes.find((row) => row.engine === openDropped);
  const droppedList = [...(droppedRow?.dropped ?? [])].sort((a, b) => a.rel - b.rel);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <WelcomeScreen onSendMessage={onSendMessage} />
        ) : (
          <div className="mx-auto max-w-3xl px-6 py-6">
            {messages.map((msg, index) => {
              const asked = [...messages.slice(0, index)].reverse().find((entry) => entry.role === 'user');
              return (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  query={asked?.content}
                  isStreaming={isStreaming && msg.id === messages[messages.length - 1]?.id && msg.role === 'assistant'}
                  onRetrySearch={onRetrySearch}
                  onSaveResults={onSaveResults}
                  onFollowUp={onFollowUp}
                />
              );
            })}
            {isSearching && (
              <div className="mb-4 flex items-center gap-2 rounded-lg border border-olive/30 bg-olive-subtle px-4 py-2.5 text-xs text-olive animate-fade-in">
                <Loader2 size={14} className="animate-spin" />
                <span>{searchLabel || 'Searching across multiple engines with semantic query compilation and RRF ranking...'}</span>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      <div className="border-t border-border-subtle bg-bg-surface px-6 py-4">
        <div className="mx-auto max-w-3xl">
          <SearchBar
            onSearch={onSearch}
            onRunLane={onRunLane}
            rawOnly={rawOnly}
            onRawOnlyChange={onRawOnlyChange}
            engines={engines}
            onEnginesChange={onEnginesChange}
            useDorks={useDorks}
            onUseDorksChange={onUseDorksChange}
            disabled={isStreaming}
            searching={isSearching || isStreaming}
            onCancel={onCancelSearch}
            storedKeys={storedKeyNames ?? []}
            issues={engineIssues}
            deploymentSecrets={deploymentKeyNames ?? null}
          />
          <EngineKeyRow
            engines={engines}
            storedKeys={storedKeyNames ?? []}
            issues={engineIssues}
            deploymentSecrets={deploymentKeyNames ?? null}
            unavailable={keysUnavailable}
            onOpenSettings={onOpenSettings}
          />
          {engineIssues && engineIssues.length > 0 && (
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
              <AlertTriangle size={11} className="text-warning" />
              {engineIssues.map((issue) => (
                <span
                  key={`${issue.engine}:${issue.status}`}
                  title={issue.detail}
                  className={`flex items-center gap-1 rounded border px-1.5 py-0.5 ${
                    issue.severity === 'warning'
                      ? 'border-warning/30 bg-warning-subtle text-warning'
                      : 'border-border-subtle bg-bg-elevated text-text-muted'
                  }`}
                >
                  <span className="font-medium">{issue.name}</span>
                  <span className="opacity-80">{issue.label}</span>
                </span>
              ))}
            </div>
          )}
          {relaxedGate && (
            <div className="mb-1.5 flex items-center gap-1.5 text-[10px] text-warning">
              <Filter size={11} />
              <span>Nothing matched the query closely — showing the closest results anyway</span>
            </div>
          )}
          {(deadLanes.length > 0 || offTopicLanes.length > 0) && (
            <div className="mb-1.5">
              <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-text-muted">
              <Filter size={11} className="text-text-muted" />
              <span className="opacity-80">Lane yield</span>
              {deadLanes.map((row) => {
                const label = ENGINE_LABELS.get(row.engine) ?? row.engine;
                return (
                  <span
                    key={`dead:${row.engine}`}
                    title={`${label} answered this query with no results at all`}
                    className="flex items-center gap-1 rounded border border-border-subtle bg-bg-elevated px-1.5 py-0.5 text-text-muted"
                  >
                    <span className="font-medium">{label}</span>
                    <span className="opacity-80">no results</span>
                  </span>
                );
              })}
              {offTopicLanes.map((row) => {
                const label = ENGINE_LABELS.get(row.engine) ?? row.engine;
                const open = openDropped === row.engine;
                return (
                  <button
                    type="button"
                    key={row.engine}
                    onClick={() => setOpenDropped(open ? null : row.engine)}
                    aria-expanded={open}
                    title={`${row.offTopic} of ${row.returned} results from ${label} were dropped by the relevance gate as off-topic — click to list them`}
                    className="flex items-center gap-1 rounded border border-warning/30 bg-warning-subtle px-1.5 py-0.5 text-warning transition-colors hover:border-warning/60"
                  >
                    <span className="font-medium">{label}</span>
                    <span className="opacity-80">
                      {row.kept}/{row.returned}
                    </span>
                    <ChevronDown size={9} className={`opacity-70 transition-transform ${open ? 'rotate-180' : ''}`} />
                  </button>
                );
              })}
              </div>
              {droppedRow && (
                <ul className="mt-1 space-y-0.5 rounded border border-border-subtle bg-bg-elevated px-2 py-1.5 text-[10px]">
                  <li className="text-text-muted opacity-70">
                    {ENGINE_LABELS.get(droppedRow.engine) ?? droppedRow.engine} — dropped by the gate, lowest coverage first
                  </li>
                  {droppedList.length === 0 && (
                    <li className="text-text-muted opacity-60">No titles recorded for this run.</li>
                  )}
                  {droppedList.map((item, index) => (
                    <li key={`${droppedRow.engine}:${index}`} className="flex items-baseline gap-1.5">
                      <span className="tabular-nums text-text-muted opacity-60">{item.rel.toFixed(2)}</span>
                      <span className="truncate text-text-secondary" title={item.title}>
                        {item.title}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {searchEnabled && (
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-olive">
              <Globe size={11} />
              <span>
                Search on <span className="capitalize">{presetName}</span> preset —{' '}
                {engines.length > 0 ? `${engines.length} engines` : 'preset engines'} · RRF ranking
                {useDorks ? ' · dorks on' : ''}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
