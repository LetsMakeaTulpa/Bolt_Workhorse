import { useMemo, useState } from 'react';
import { Message, Source } from '../types';
import { User, Compass, Globe, ExternalLink, Search, Copy, Check, Share2, Bookmark, RotateCw, ArrowUpRight, ChevronDown, FileText, ShieldAlert, Layers, CalendarDays } from 'lucide-react';
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
import { describeUnverified, isUnverifiedAnswer } from '../lib/verification';
import { checkGrounding } from '../lib/grounding';
import { summarizeMachine, usedSources } from '../lib/machineTrace';
import { freshnessOf } from '../lib/freshness';
import { unansweredKind } from '../lib/turnDecision';
import { blufOf, sameQuery } from '../lib/blufQuery';

interface MessageBubbleProps {
  message: Message;
  isStreaming: boolean;
  /** the user turn this answer belongs to, so retry re-runs the right query */
  query?: string;
  onRetrySearch?: (query: string) => void;
  /** ask the same question again as a fresh turn, for a turn that ended without an answer */
  onRetryTurn?: (query: string) => void;
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

/** A marked sentence has to stay short enough to read in a strip this size. */
function shorten(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean;
}

export function MessageBubble({ message, isStreaming, query, onRetrySearch, onRetryTurn, onSaveResults, onFollowUp, onRunLane }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const [lanePickerOpen, setLanePickerOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shared, setShared] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'known'>('idle');
  const [groundingOpen, setGroundingOpen] = useState(false);

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

  // what the machine did for this answer: which pages were opened and read, and what the model
  // searched on its own when the first pass was thin
  const machine = useMemo(() => summarizeMachine(message), [message]);
  // the date window of what the prompt carried: a recency question answered from old pages is the
  // one case where the transcript should say so before the reader clicks through
  const freshness = useMemo(
    () => (isUser || isStreaming ? null : freshnessOf(usedSources(message), query ?? '')),
    [message, query, isUser, isStreaming],
  );

  // the answer's bottom line, as a query and as next questions. A post that ends with nothing to
  // press is a dead end, and the model's own FOLLOW-UPS section arrives often enough to rely on but
  // not often enough to trust alone.
  const bluf = useMemo(
    () => (isUser || isStreaming ? { lead: '', subject: '', query: '', followUps: [] } : blufOf(prose)),
    [isUser, isStreaming, prose],
  );

  // the model's own extra searches are already offered as buttons under "Searched again". When the
  // bottom line reduces to one of them, the same search would appear twice under two labels, so the
  // model's phrasing keeps the chip and the derived one steps aside.
  const blufAlreadySearched = bluf.query !== '' && machine.extraSearches.some((query) => sameQuery(query, bluf.query));
  const showBlufQuery = bluf.query !== '' && !blufAlreadySearched;

  // A turn can end with no answer at all: the search was stopped, a newer question replaced it, or
  // the request failed. In every one of those the reader is left looking at a question with nothing
  // usable under it, and until now the only way to try again was to type it out. The sources block
  // that owns the Retry control never renders on these turns, because there are no sources.
  //
  // `unansweredContent` is what the message *is* — no answer to audit, nothing to verify;
  // `unanswered` adds the one thing Retry needs on top, which is a question to ask again.
  const unansweredContent = useMemo(() => {
    if (isUser || isStreaming) return null;
    const kind = unansweredKind(message.content);
    if (kind) return kind;
    return /^Error:/.test(message.content.trim()) ? ('failed' as const) : null;
  }, [isUser, isStreaming, message.content]);
  const unanswered = unansweredContent && query ? unansweredContent : null;

  // the anti-fabrication promise applied to the answer itself: a citation ID must be one of this
  // answer's sources, and the figures and names in a sentence must appear in the pages it cites
  // nothing to check on a turn that never answered: the note is not a claim, and running the
  // citation audit over it produced "1 sentence with figures or names not found" under a stopped
  // search, which reads as a verdict on an answer that does not exist
  const grounding = useMemo(
    () => (isUser || isStreaming || unansweredContent ? null : checkGrounding(prose, message.search_results ?? [], query ?? '')),
    [isUser, isStreaming, unansweredContent, prose, message.search_results, query],
  );

  // the model's own questions are better than any frame around its lead, so they win when present
  const nextQuestions = followUps.length > 0 ? followUps : bluf.followUps;

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
        {/* a gap report already says it found nothing, and an unanswered turn is not an answer that
            failed verification, so the badge is only for answers that talk past a real search */}
        {isUnverifiedAnswer(message) && !isGapReport(message.content) && !unansweredContent && (
          <span
            title={describeUnverified().detail}
            className="flex items-center gap-1 rounded-md border border-warning/30 bg-warning-subtle px-1.5 py-0.5 text-[10px] font-medium text-warning"
          >
            <ShieldAlert size={10} className="flex-shrink-0" />
            {describeUnverified().label}
          </span>
        )}
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

        {unanswered && (
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => query && onRetryTurn?.(query)}
              disabled={!onRetryTurn || !query}
              title={
                unanswered === 'superseded'
                  ? `Ask this again — a newer question replaced it: “${shorten(query ?? '', 90)}”`
                  : `Retry — search and answer “${shorten(query ?? '', 90)}” again`
              }
              className="flex items-center gap-1 rounded-md border border-accent/30 bg-accent-subtle px-2 py-1 text-[10px] text-accent transition-colors hover:bg-accent hover:text-bg-base disabled:cursor-not-allowed disabled:opacity-30"
            >
              <RotateCw size={10} />
              Retry
            </button>
            <span className="text-[10px] text-text-muted">
              Runs the question again, search and answer, as a fresh turn
            </span>
          </div>
        )}

        {!isUser &&
        !isStreaming &&
        (machine.anything || (freshness !== null && (freshness.dated > 0 || freshness.stale))) && (
          <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-text-muted">
            {machine.read.length > 0 && (
              <span className="flex flex-wrap items-center gap-1">
                <FileText size={10} className="flex-shrink-0" />
                <span className="uppercase tracking-wider">Read in full</span>
                {machine.read.map((source) => (
                  <a
                    key={source.url}
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    title={`Page text read by ${source.via} and quoted from, rather than a snippet`}
                    className="flex max-w-[16rem] items-center gap-1 rounded-full border border-border-subtle bg-bg-surface px-2 py-0.5 text-text-secondary transition-colors hover:border-accent/30 hover:text-text-primary"
                  >
                    <span className="font-mono text-text-muted">{source.citation}</span>
                    <span className="truncate">{source.title}</span>
                    <ExternalLink size={8} className="flex-shrink-0" />
                  </a>
                ))}
              </span>
            )}
            {machine.panelOnly > 0 && (
              <span
                className="flex flex-wrap items-center gap-1"
                title={`The prompt carried ${machine.given} of this answer's ${machine.shown} fused sources; the other ${machine.panelOnly} are listed in the panel but were never shown to the model`}
              >
                <Layers size={10} className="flex-shrink-0" />
                <span className="uppercase tracking-wider">Given to the model</span>
                <span className="font-mono text-text-secondary">{`${machine.given} of ${machine.shown}`}</span>
                <span>{`· ${machine.panelOnly} panel-only`}</span>
              </span>
            )}
            {freshness && (freshness.dated > 0 || freshness.stale) && (
              <span
                className="flex flex-wrap items-center gap-1"
                title={
                  freshness.dated === 0
                    ? 'This query asks for recent material, but none of the sources carries a publication date'
                    : freshness.stale
                      ? `This query asks for recent material, and the newest dated source is ${freshness.newestAgeMonths} months old`
                      : 'The publication dates of the sources the answer was given'
                }
              >
                <CalendarDays size={10} className={`flex-shrink-0 ${freshness.stale ? 'text-warning' : ''}`} />
                <span className={`uppercase tracking-wider ${freshness.stale ? 'text-warning' : ''}`}>
                  Sources dated
                </span>
                {freshness.dated > 0 ? (
                  <span className="font-mono text-text-secondary">{`${freshness.oldest} → ${freshness.newest}`}</span>
                ) : (
                  <span className="text-warning">none</span>
                )}
                {freshness.undated > 0 && <span>{`· ${freshness.undated} undated`}</span>}
                {freshness.stale && (
                  <span className="text-warning">
                    {freshness.newestAgeMonths === null
                      ? '· no date to judge recency by'
                      : `· newest is ${freshness.newestAgeMonths}mo old`}
                  </span>
                )}
              </span>
            )}
            {machine.extraSearches.length > 0 && (
              <span className="flex flex-wrap items-center gap-1">
                <Search size={10} className="flex-shrink-0" />
                <span className="uppercase tracking-wider">Searched again</span>
                {machine.extraSearches.map((query) => (
                  <button
                    key={query}
                    type="button"
                    onClick={() => onRetrySearch?.(query)}
                    disabled={!onRetrySearch}
                    title={`Run this search again: ${query}`}
                    className="flex max-w-[16rem] items-center gap-1 rounded-full border border-border-subtle bg-bg-surface px-2 py-0.5 text-text-secondary transition-colors hover:border-accent/30 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <span className="truncate">{query}</span>
                    <RotateCw size={8} className="flex-shrink-0" />
                  </button>
                ))}
              </span>
            )}
          </div>
        )}

        {grounding && grounding.checked > 0 && (
          <div
            className={`w-full rounded-lg border px-2.5 py-1.5 text-[10px] ${
              grounding.flagged.length > 0
                ? 'border-warning/30 bg-warning-subtle'
                : 'border-border-subtle bg-bg-surface'
            }`}
          >
            <button
              type="button"
              onClick={() => setGroundingOpen((open) => !open)}
              aria-expanded={groundingOpen}
              title="Every citation must exist, and every figure or name in a sentence must appear in the page that sentence cites"
              className="flex w-full items-center gap-1.5 text-left"
            >
              <ShieldAlert
                size={10}
                className={`flex-shrink-0 ${grounding.flagged.length > 0 ? 'text-warning' : 'text-text-muted'}`}
              />
              <span className={`flex-1 ${grounding.flagged.length > 0 ? 'text-warning' : 'text-text-secondary'}`}>
                Grounding: {grounding.summary}
              </span>
              <ChevronDown
                size={10}
                className={`flex-shrink-0 text-text-muted transition-transform ${groundingOpen ? 'rotate-180' : ''}`}
              />
            </button>

            {groundingOpen && (
              <ul className="mt-1.5 space-y-1 border-t border-border-subtle pt-1.5">
                {grounding.flagged.map((sentence, index) => (
                  <li key={`${index}-${sentence.text}`} className="text-text-secondary">
                    <span className="text-warning">
                      {sentence.status === 'unknown-citation' ? 'Citation that does not exist' : 'Not in the cited page'}:
                    </span>{' '}
                    <span className="italic">“{shorten(sentence.text)}”</span>
                    {sentence.missing.length > 0 && (
                      <span className="text-text-muted"> — missing {sentence.missing.join(', ')}</span>
                    )}
                  </li>
                ))}
                {grounding.unchecked.map((sentence, index) => (
                  <li key={`unchecked-${index}-${sentence.text}`} className="text-text-muted">
                    Could not check — the cited source came back as a snippet, not a page:{' '}
                    <span className="italic">“{shorten(sentence.text)}”</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {!isUser &&
          !isStreaming &&
          !unansweredContent &&
          !isGapReport(message.content) &&
          (showBlufQuery || nextQuestions.length > 0) && (
            <div className="flex w-full flex-wrap items-center gap-1.5 pt-0.5">
              <span className="text-[10px] uppercase tracking-wider text-text-muted">Keep digging</span>
              {/* the bottom line as a query, so the lead can be searched without retyping it */}
              {showBlufQuery && (
                <button
                  type="button"
                  onClick={() => onRetrySearch?.(bluf.query)}
                  disabled={!onRetrySearch}
                  title={`The bottom line of this answer as a query — runs it across the selected engines: ${bluf.query}`}
                  className="flex max-w-full items-center gap-1 rounded-full border border-accent/30 bg-accent-subtle px-2.5 py-1 text-left text-[11px] text-accent transition-colors hover:bg-accent hover:text-bg-base disabled:opacity-40"
                >
                  <Search size={10} className="flex-shrink-0" />
                  <span className="truncate">{bluf.query}</span>
                </button>
              )}
              {nextQuestions.map((question) => (
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
