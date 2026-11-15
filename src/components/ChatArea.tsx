import { Message, Source } from '../types';
import { MessageBubble } from './MessageBubble';
import { SearchBar } from './SearchBar';
import { WelcomeScreen } from './WelcomeScreen';
import { Globe, Loader2, AlertTriangle } from 'lucide-react';
import type { EngineIssue } from '../lib/engines';

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
  rawOnly?: boolean;
  onRawOnlyChange?: (value: boolean) => void;
  engines: string[];
  onEnginesChange: (engines: string[]) => void;
  useDorks: boolean;
  onUseDorksChange: (value: boolean) => void;
  /** stop the running search, keeping whatever it has already collected */
  onCancelSearch?: () => void;
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
  rawOnly,
  onRawOnlyChange,
  engines,
  onEnginesChange,
  useDorks,
  onUseDorksChange,
  onCancelSearch,
  onRetrySearch,
  onSaveResults,
  onFollowUp,
}: ChatAreaProps) {
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
            searching={isSearching}
            onCancel={onCancelSearch}
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
