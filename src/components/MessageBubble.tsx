import { useMemo, useState } from 'react';
import { Message, Source } from '../types';
import { User, Compass, Globe, ExternalLink, Search, Copy, Check, Share2, Bookmark, RotateCw, ArrowUpRight, ChevronDown, FileText } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { splitFollowUps } from '../lib/followUps';
import { splitClaimLedger } from '../lib/claimLedger';
import type { LedgerClaim } from '../lib/claimLedger';
import { ClaimLedgerTable } from './ClaimLedgerTable';
import { broadenQuery, isGapReport } from '../lib/emptyResult';
import { DORK_LANES } from '../lib/dorks';
import { FIELDWORK_SYSTEM_PROMPT } from '../lib/systemPrompt';
import { promptWordCount } from '../lib/promptVariant';

interface MessageBubbleProps {
  message: Message;
  isStreaming: boolean;
  /** the user turn this answer belongs to, so retry re-runs the right query */
  query?: string;
  onRetrySearch?: (query: string) => void;
  onSaveResults?: (query: string, results: Source[]) => Promise<number>;
  onFollowUp?: (question: string) => void;
  /** run one dork lane against a target, offered from a gap report */
  onRunLane?: (lane: string, target: string) => void;
}

/**
 * The word count of the custom prompt this answer was produced with, or null when it used the
 * built-in prompt — or when the row predates the column, which is unknown rather than built-in.
 */
function customPromptWords(stored?: string | null): number | null {
  if (!stored || stored === FIELDWORK_SYSTEM_PROMPT) return null;
  return promptWordCount(stored);
}

export function MessageBubble({ message, isStreaming, query, onRetrySearch, onSaveResults, onFollowUp, onRunLane }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const [lanePickerOpen, setLanePickerOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shared, setShared] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'known'>('idle');

  const results = message.search_results ?? [];
  const { body, followUps } = useMemo(
    () => (isUser ? { body: message.content, followUps: [] as string[] } : splitFollowUps(message.content)),
    [isUser, message.content],
  );
  // the ledger is lifted out of the prose so it can be drawn as a table instead of whatever
  // markdown the model happened to write; `body` keeps it, so copy and share still take it along
  const { body: prose, claims } = useMemo(
    () => (isUser ? { body, claims: [] as LedgerClaim[] } : splitClaimLedger(body)),
    [isUser, body],
  );
  const promptWords = isUser ? null : customPromptWords(message.system_prompt);

  const sourceText = () =>
    results
      .map((source, index) => `${source.citation_id ?? `[${index + 1}]`} ${source.title}\n${source.url}`)
      .join('\n\n');

  const flash = (setter: (value: boolean) => void) => {
    setter(true);
    window.setTimeout(() => setter(false), 2000);
  };

  const handleCopy = async () => {
    const text = results.length > 0 ? `${query ?? message.content}\n\n${sourceText()}` : body;
    try {
      await navigator.clipboard.writeText(text);
      flash(setCopied);
    } catch {
      /* clipboard blocked — leave the button unflashed rather than lying about it */
    }
  };

  const handleShare = async () => {
    const text = results.length > 0 ? `${results.length} sources for "${query ?? 'this search'}"\n\n${sourceText()}` : body;
    try {
      if (navigator.share) await navigator.share({ title: 'Fieldwork search', text });
      else await navigator.clipboard.writeText(text);
      flash(setShared);
    } catch {
      /* share sheet dismissed */
    }
  };

  const handleSave = async () => {
    if (!onSaveResults || !query || results.length === 0 || saveState === 'saving') return;
    setSaveState('saving');
    const saved = await onSaveResults(query, results);
    setSaveState(saved > 0 ? 'saved' : 'known');
  };

  return (
    <div className={`mb-6 flex gap-3 animate-slide-up ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      <div className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg ${
        isUser ? 'bg-bg-elevated border border-border-subtle' : 'bg-gradient-to-br from-accent to-accent-hover'
      }`}>
        {isUser ? <User size={14} className="text-text-secondary" /> : <Compass size={14} className="text-bg-base" />}
      </div>

      <div className={`flex flex-col gap-1.5 ${isUser ? 'items-end' : 'items-start'} max-w-[80%]`}>
        {message.search_enabled && results.length > 0 && (
          <div className="mb-0.5 w-full rounded-lg border border-border-subtle bg-bg-surface p-2.5">
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-olive">
              <Search size={11} />
              <span>Retrieved {results.length} sources via RRF</span>
            </div>
            <div className="space-y-1">
              {results.slice(0, 4).map((r, i) => (
                <a
                  key={i}
                  href={r.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-start gap-1.5 text-[11px] text-text-secondary hover:text-text-primary transition-colors group"
                >
                  <span className="flex-shrink-0 text-text-muted font-mono">{r.citation_id ?? `[${i+1}]`}</span>
                  <span className="flex-1 truncate group-hover:underline">{r.title}</span>
                  <ExternalLink size={9} className="flex-shrink-0 opacity-0 group-hover:opacity-100 mt-0.5" />
                </a>
              ))}
              {results.length > 4 && (
                <div className="text-[11px] text-text-muted">+ {results.length - 4} more sources</div>
              )}
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-border-subtle pt-2">
              <ActionButton icon={copied ? Check : Copy} label={copied ? 'Copied' : 'Copy'} onClick={handleCopy} active={copied} />
              <ActionButton icon={shared ? Check : Share2} label={shared ? 'Shared' : 'Share'} onClick={handleShare} active={shared} />
              <ActionButton
                icon={Bookmark}
                label={saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'known' ? 'In findings' : 'Save'}
                onClick={handleSave}
                active={saveState === 'saved' || saveState === 'known'}
                disabled={!onSaveResults || saveState === 'saving'}
              />
              <ActionButton
                icon={RotateCw}
                label="Retry"
                onClick={() => query && onRetrySearch?.(query)}
                disabled={!onRetrySearch || !query}
              />
            </div>
          </div>
        )}

        <div className={`rounded-xl px-3.5 py-2.5 ${
          isUser
            ? 'bg-accent text-bg-base'
            : 'bg-bg-surface text-text-primary border border-border-subtle'
        }`}>
          {isStreaming && !message.content ? (
            <div className="flex items-center gap-1 py-1">
              <span className="thinking-dot"></span>
              <span className="thinking-dot"></span>
              <span className="thinking-dot"></span>
            </div>
          ) : isUser ? (
            <p className="text-sm whitespace-pre-wrap">{message.content}</p>
          ) : (
            <>
              <div className="markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{prose}</ReactMarkdown>
              </div>
              {claims.length > 0 && <ClaimLedgerTable claims={claims} />}
              {/* a gap report ends in advice; the advice is worth more as the action itself */}
              {!isUser && !isStreaming && isGapReport(message.content) && query && (
                <div className="mt-2 border-t border-border-subtle pt-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onRetrySearch?.(broadenQuery(query))}
                      disabled={!onRetrySearch}
                      title={`Search again for “${broadenQuery(query)}” — operators and the most specific words removed`}
                      className="flex items-center gap-1 rounded-md border border-accent/30 bg-accent-subtle px-2 py-1 text-[10px] text-accent transition-colors hover:bg-accent hover:text-bg-base disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      <Search size={10} />
                      Broader: “{broadenQuery(query)}”
                    </button>
                    <button
                      type="button"
                      onClick={() => setLanePickerOpen((open) => !open)}
                      aria-expanded={lanePickerOpen}
                      disabled={!onRunLane}
                      className="flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-[10px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      Run a lane
                      <ChevronDown size={10} className={`transition-transform ${lanePickerOpen ? 'rotate-180' : ''}`} />
                    </button>
                  </div>
                  {lanePickerOpen && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {DORK_LANES.map((lane) => (
                        <button
                          key={lane}
                          type="button"
                          onClick={() => {
                            onRunLane?.(lane, query);
                            setLanePickerOpen(false);
                          }}
                          title={`Run every ${lane} dork against “${query}”`}
                          className="rounded-full border border-border-subtle bg-bg-elevated px-2 py-0.5 text-[10px] text-text-secondary transition-colors hover:border-accent/30 hover:text-text-primary"
                        >
                          {lane}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {!isUser && followUps.length > 0 && !isStreaming && (
          <div className="flex w-full flex-wrap items-center gap-1.5 pt-0.5">
            <span className="text-[10px] uppercase tracking-wider text-text-muted">Keep digging</span>
            {followUps.map((question) => (
              <button
                key={question}
                onClick={() => onFollowUp?.(question)}
                disabled={!onFollowUp}
                title={question}
                className="group flex max-w-full items-center gap-1 rounded-full border border-border-subtle bg-bg-surface px-2.5 py-1 text-left text-[11px] text-text-secondary transition-colors hover:border-accent/30 hover:bg-bg-elevated hover:text-text-primary disabled:opacity-40"
              >
                <span className="truncate">{question}</span>
                <ArrowUpRight size={10} className="flex-shrink-0 text-text-muted group-hover:text-accent" />
              </button>
            ))}
          </div>
        )}

        {!isUser && message.model && message.content && (
          <div className="flex items-center gap-1.5 text-[10px] text-text-muted">
            {message.search_enabled && <Globe size={9} />}
            <span className="font-mono">{message.model.split('/').pop()}</span>
            {promptWords !== null && (
              <span
                title={`Answered with a custom system prompt (${promptWords} words) that was saved with this message, not the built-in one.`}
                className="flex items-center gap-0.5 rounded border border-accent/30 bg-accent-subtle px-1 py-0.5 text-accent"
              >
                <FileText size={8} />
                custom prompt
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ActionButton({
  icon: Icon,
  label,
  onClick,
  active,
  disabled,
}: {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
        active ? 'bg-accent-subtle text-accent' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
      }`}
    >
      <Icon size={11} />
      {label}
    </button>
  );
}
