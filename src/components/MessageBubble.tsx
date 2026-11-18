import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Message, Source } from '../types';
import { User, Compass, Globe, ExternalLink, Search, Copy, Check, Share2, Bookmark, RotateCw, ArrowUpRight, ChevronDown, FileText, ShieldAlert, Layers, CalendarDays, X } from 'lucide-react';
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
import { describeFreshness, freshnessOf, type Freshness } from '../lib/freshness';
import { unansweredKind } from '../lib/turnDecision';
import { blufOf } from '../lib/blufQuery';
import { CITATION_PREFIX, SENTENCE_PREFIX, citationIdOf, remarkCitations } from '../lib/citationFocus';

/**
 * Whether two queries are the same search: only spelling may differ. A wider query is a different
 * one ("reciprocal rank fusion 2009" asks for more than "reciprocal rank fusion"), so containment
 * is not equality. Callers guard the empty case; the derived chip is only offered with a query.
 */
const sameSearch = (a: string, b: string) =>
  a.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === b.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The publication window behind an answer, shown only when `notable` says it earns the space. The
 * visible line stays short; the hover carries the whole reading, including both dates.
 */
function FreshnessReceipt({
  freshness,
  onSearchRecent,
}: {
  freshness: Freshness;
  /** the receipt's own next move: search again for recent pages, with dates weighted */
  onSearchRecent?: () => void;
}) {
  const tone = freshness.stale ? 'text-warning' : '';
  // a fresh window has nothing to fix, so the control would be noise there
  const actionable = freshness.stale || freshness.newest === null || (freshness.newestAgeMonths ?? 0) >= 12;
  return (
    <span className="flex flex-wrap items-center gap-1" title={describeFreshness(freshness)}>
      <CalendarDays size={10} className={`flex-shrink-0 ${tone}`} />
      <span className={`uppercase tracking-wider ${tone}`}>Sources dated</span>
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
      {onSearchRecent && actionable && (
        <button
          type="button"
          onClick={onSearchRecent}
          title="Search this question again with publication dates weighted and the Recent scope — the engines that carry live pages, newest first"
          className="flex items-center gap-0.5 rounded border border-warning/40 bg-warning-subtle px-1.5 py-0.5 text-[9px] text-warning transition-colors hover:border-warning/70"
        >
          <Search size={8} className="flex-shrink-0" />
          Search recent
        </button>
      )}
    </span>
  );
}

interface MessageBubbleProps {
  message: Message;
  isStreaming: boolean;
  /** the user turn this answer belongs to, so retry re-runs the right query */
  query?: string;
  /** run a search on its own; the post it came from is told what the run changed */
  onRetrySearch?: (query: string, options?: { messageId?: string }) => void;
  /** the last search-only re-run started from this post */
  rerun?: { query: string; results: Source[]; note?: string };
  /** re-run this question with publication dates weighted and the Recent scope applied */
  onSearchRecent?: (query: string, options?: { messageId?: string }) => void;
  /** write a new answer from a re-run's sources, without searching */
  onAnswerWithSources?: (query: string, sources: Source[]) => void;
  /** ask the same question again as a fresh turn, for a turn that ended without an answer */
  onRetryTurn?: (query: string, options?: { reuseSources?: boolean; messageId?: string }) => void;
  /** the later turn that retried this one, so a replaced attempt can point forward to it */
  retriedBy?: string;
  onSaveResults?: (query: string, results: Source[]) => Promise<number>;
  onFollowUp?: (question: string) => void;
  /** run one dork lane against a target, offered from a gap report */
  onRunLane?: (lane: string, target: string) => void;
  /** the citation the Sources panel has selected; absent when the bubble owns the selection */
  focusedCitation?: string | null;
  /** tell the page about a selection made here, so a card in the panel can show it too */
  onCitationFocus?: (id: string | null) => void;
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

export function MessageBubble({ message, isStreaming, query, onRetrySearch, onRetryTurn, onSaveResults, onFollowUp, onRunLane, rerun, onAnswerWithSources, onSearchRecent, retriedBy, focusedCitation, onCitationFocus }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const [lanePickerOpen, setLanePickerOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shared, setShared] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'known'>('idle');
  const [groundingOpen, setGroundingOpen] = useState(false);
  /** the citation id both directions of the mapping light up, or null when nothing is selected */
  const [localFocused, setLocalFocused] = useState<string | null>(null);
  // One id, two places: a marker press and a Sources-panel card press light the same sentences, so
  // the page may own the selection (`focusedCitation`) and a bubble rendered on its own still works.
  const focused = focusedCitation === undefined ? localFocused : focusedCitation;
  /** Pressing the selected id again clears it; pressing another moves the selection. */
  const select = useCallback(
    (id: string) => {
      const next = focused === id ? null : id;
      setLocalFocused(next);
      onCitationFocus?.(next);
    },
    [focused, onCitationFocus],
  );
  /** the read-in-full entry whose page text is open, by url */
  const [openRead, setOpenRead] = useState<string | null>(null);

  const results = message.search_results ?? [];
  /** why this turn found nothing; the Sources panel shows the same lines, but it can be collapsed */
  const gaps = message.gaps ?? [];

  // A citation marker and a source row are two views of one id, and `checkGrounding` already
  // decides which sentences carry which ids — so selecting either direction needs no new data. The
  // markers and the sentences arrive here as links from `remarkCitations`; this turns them into a
  // button and a highlightable span instead, and leaves a real link a real link.
  const markdownComponents = useMemo(() => {
    const AnswerLink = ({ href, children }: { href?: string; children?: ReactNode }) => {
      if (href && href.startsWith(CITATION_PREFIX)) {
        const id = href.slice(CITATION_PREFIX.length);
        const active = focused === id;
        return (
          <button
            type="button"
            data-citation={id}
            aria-pressed={active}
            onClick={() => select(id)}
            title={
              active
                ? `Stop highlighting the sentences citing [${id}]`
                : `Highlight the sentences citing [${id}] and its source`
            }
            className={`rounded px-0.5 font-mono text-[0.8em] transition-colors ${
              active ? 'bg-accent text-bg-base' : 'text-accent hover:bg-accent-subtle'
            }`}
          >
            {children}
          </button>
        );
      }
      if (href && href.startsWith(SENTENCE_PREFIX)) {
        const cites = href.slice(SENTENCE_PREFIX.length).split('.').filter(Boolean);
        const active = focused !== null && cites.includes(focused);
        return (
          <span data-cites={cites.join(',')} className={active ? 'rounded-sm bg-accent/15 text-text-primary' : undefined}>
            {children}
          </span>
        );
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
        >
          {children}
        </a>
      );
    };
    return { a: AnswerLink };
  }, [focused, select]);
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
  /** the page text the prompt carried for the entry that is open, if any */
  const openSource = machine.read.find((entry) => entry.url === openRead) ?? null;
  /** what a search-only re-run found that this answer did not already have */
  const rerunFresh = rerun
    ? rerun.results.filter((found) => !results.some((known) => known.url === found.url))
    : [];
  // the date window of what the prompt carried: a recency question answered from old pages is the
  // one case where the transcript should say so before the reader clicks through
  const freshness = useMemo(
    () => (isUser || isStreaming ? null : freshnessOf(usedSources(message), query ?? '')),
    [message, query, isUser, isStreaming],
  );

  // the answer's bottom line, as a query and as next questions. A post that ends with nothing to
  // press is a dead end, and the model's own FOLLOW-UPS section arrives often enough to rely on but
  // not often enough to trust alone. The questions are told what the post knows about its own
  // evidence, so a window of old pages cannot be asked what changed in the past year while the
  // receipt above it says otherwise.
  const bluf = useMemo(
    () =>
      blufOf(isUser || isStreaming ? '' : prose, {
        newest: freshness?.newest ?? null,
        newestAgeMonths: freshness?.newestAgeMonths ?? null,
        dated: freshness?.dated ?? 0,
        undated: freshness?.undated ?? 0,
        contested: claims.some((claim) => claim.verdict === 'contested'),
      }),
    [isUser, isStreaming, prose, freshness, claims],
  );

  // the model's own extra searches are already offered as buttons under "Searched again". When the
  // bottom line reduces to one of them, the same search would appear twice under two labels, so the
  // model's phrasing keeps the chip and the derived one steps aside.
  const showBlufQuery = bluf.query !== '' && !machine.extraSearches.some((query) => sameSearch(query, bluf.query));

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
  /**
   * A failed turn that found nothing has one obvious next move beyond repeating itself: ask
   * something the engines can actually match. Only offered when widening changes the words —
   * a "broader" search that sends the same query is the problem, not the fix.
   */
  const broaderQuery = unanswered === 'failed' && results.length === 0 && query ? broadenQuery(query) : null;
  const showBroader = Boolean(broaderQuery && broaderQuery !== query);

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
    <div
      id={`msg-${message.id}`}
      className={`mb-6 flex scroll-mt-4 gap-3 animate-slide-up ${isUser ? 'flex-row-reverse' : 'flex-row'}`}
    >
      <div className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg ${
        isUser ? 'bg-bg-elevated border border-border-subtle' : 'bg-gradient-to-br from-accent to-accent-hover'
      }`}>
        {isUser ? <User size={14} className="text-text-secondary" /> : <Compass size={14} className="text-bg-base" />}
      </div>

      <div className={`flex flex-col gap-1.5 ${isUser ? 'items-end' : 'items-start'} max-w-[80%]`}>
        {/* A retry is a second attempt at the same question, not a new one: the link is what stops
            it reading as an unrelated answer beside the turn it replaced. */}
        {isUser && message.retry_of && (
          <a
            href={`#msg-${message.retry_of}`}
            title="Asked again after that attempt — the same question, tried a second time"
            className="flex items-center gap-1 text-[10px] text-text-muted transition-colors hover:text-accent"
          >
            <RotateCw size={9} className="flex-shrink-0" />
            Retry of the earlier attempt
          </a>
        )}
        {!isUser && retriedBy && (
          <a
            href={`#msg-${retriedBy}`}
            title="This attempt was replaced by the retry below"
            className="flex items-center gap-1 text-[10px] text-text-muted transition-colors hover:text-accent"
          >
            <RotateCw size={9} className="flex-shrink-0" />
            Retried below
          </a>
        )}
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
              {results.slice(0, 4).map((r, i) => {
                const marker = r.citation_id ?? `[${i + 1}]`;
                const id = citationIdOf(marker);
                const active = id !== '' && focused === id;
                return (
                  <div
                    key={i}
                    className={`-mx-1 flex items-start gap-1.5 rounded px-1 transition-colors ${active ? 'bg-accent/15' : ''}`}
                  >
                    {/* the other direction of the same mapping: a source row lights up every
                        sentence in this answer that cites it */}
                    <button
                      type="button"
                      data-source={id}
                      aria-pressed={active}
                      onClick={() => select(id)}
                      disabled={id === ''}
                      title={
                        active
                          ? `Stop highlighting the sentences citing ${marker}`
                          : `Highlight the sentences in this answer that cite ${marker}`
                      }
                      className="group flex min-w-0 flex-1 items-start gap-1.5 text-left text-[11px] text-text-secondary transition-colors hover:text-text-primary disabled:cursor-default"
                    >
                      <span className={`flex-shrink-0 font-mono ${active ? 'text-accent' : 'text-text-muted'}`}>
                        {marker}
                      </span>
                      <span className="flex-1 truncate group-hover:underline">{r.title}</span>
                    </button>
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`Open ${r.title}`}
                      className="mt-0.5 flex-shrink-0 text-text-muted opacity-0 transition-opacity hover:text-accent group-hover:opacity-100 focus:opacity-100"
                    >
                      <ExternalLink size={9} />
                    </a>
                  </div>
                );
              })}
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
                icon={Search}
                label="Search only"
                title="Runs this search again without rewriting the answer above — the run is reported under the post"
                onClick={() => query && onRetrySearch?.(query, { messageId: message.id })}
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
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkCitations]} components={markdownComponents}>
                  {prose}
                </ReactMarkdown>
              </div>
              {claims.length > 0 && <ClaimLedgerTable claims={claims} />}
              {/* The badge names the outcome; this names the cause. The panel lists the same gaps,
                  but the panel can be collapsed, and the reason a search found nothing belongs
                  where the unverified label is — under the answer it applies to. */}
              {!isUser && !isStreaming && gaps.length > 0 && (
                <div className="mt-2 rounded-md border border-warning/25 bg-warning-subtle px-2.5 py-2">
                  <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-warning">
                    <ShieldAlert size={10} className="flex-shrink-0" />
                    No sources — gaps
                  </p>
                  <ul className="mt-1 space-y-0.5 text-[10px] leading-tight text-text-secondary">
                    {gaps.map((gap) => (
                      <li key={gap} className="flex gap-1">
                        <span className="flex-shrink-0 text-warning">•</span>
                        <span>{gap}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {/* a gap report ends in advice; the advice is worth more as the action itself */}
              {!isUser && !isStreaming && isGapReport(message.content) && query && (
                <div className="mt-2 border-t border-border-subtle pt-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onRetrySearch?.(broadenQuery(query), { messageId: message.id })}
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

        {/* A search-only run never rewrote this answer, so the post says what the run changed
            instead of looking as though it had been updated — and offers the one control that
            would update it. */}
        {rerun && !isStreaming && (
          <div className="flex w-full flex-wrap items-center gap-1.5 rounded-md border border-accent/25 bg-accent-subtle px-2 py-1.5 text-[10px] text-text-secondary">
            <Search size={10} className="flex-shrink-0 text-accent" />
            <span className="uppercase tracking-wider text-accent">Search only</span>
            <span className="min-w-0 truncate" title={rerun.query}>
              “{rerun.query}” returned {rerun.results.length} source{rerun.results.length === 1 ? '' : 's'}
            </span>
            {rerun.results.length > 0 && (
              <span className="font-mono text-text-primary">
                {rerunFresh.length > 0 ? `${rerunFresh.length} not in this answer` : 'nothing new'}
              </span>
            )}
            {rerun.note && <span className="font-mono text-warning">{rerun.note}</span>}
            <span className="text-text-muted">· this answer is unchanged</span>
            {rerun.results.length > 0 && (
              <button
                type="button"
                onClick={() => onAnswerWithSources?.(rerun.query, rerun.results)}
                disabled={!onAnswerWithSources}
                title={`Write a new answer from these ${rerun.results.length} sources — no search runs`}
                className="ml-auto flex items-center gap-1 rounded border border-accent/40 bg-accent px-1.5 py-0.5 text-[10px] text-bg-base transition-colors hover:bg-accent-hover disabled:opacity-40"
              >
                <ArrowUpRight size={9} /> Answer with these
              </button>
            )}
          </div>
        )}

        {unanswered && (
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() =>
                query && onRetryTurn?.(query, { reuseSources: unanswered === 'failed', messageId: message.id })
              }
              disabled={!onRetryTurn || !query}
              title={
                unanswered === 'superseded'
                  ? `Ask again — a newer question replaced it: “${shorten(query ?? '', 90)}”`
                  : unanswered === 'failed' && results.length > 0
                    ? `Ask again without searching — the ${results.length} source${results.length === 1 ? '' : 's'} this turn already retrieved are reused`
                    : `Ask again — search and answer “${shorten(query ?? '', 90)}” again`
              }
              className="flex items-center gap-1 rounded-md border border-accent/30 bg-accent-subtle px-2 py-1 text-[10px] text-accent transition-colors hover:bg-accent hover:text-bg-base disabled:cursor-not-allowed disabled:opacity-30"
            >
              <RotateCw size={10} />
              Ask again
            </button>
            <span className="text-[10px] text-text-muted">
              {unanswered === 'failed' && results.length > 0
                ? `Regenerates the answer from the ${results.length} stored source${results.length === 1 ? '' : 's'} — no search runs`
                : showBroader
                  ? 'Asks the same words again — the wider search is the other option'
                  : 'Runs the question again, search and answer, as a fresh turn'}
            </span>
            {/* The same words that found nothing will usually find nothing again. A zero-source
                turn offers the wider search next to the verbatim one instead of only the verbatim. */}
            {showBroader && broaderQuery && (
              <button
                type="button"
                onClick={() => onRetryTurn?.(broaderQuery, { messageId: message.id })}
                disabled={!onRetryTurn}
                title={`Ask again for a wider search: “${broaderQuery}” — operators and the most specific words removed, so the engines have something to match`}
                className="flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-[10px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
              >
                <Search size={10} />
                Ask broader
              </button>
            )}
          </div>
        )}

        {!isUser &&
        !isStreaming &&
        // a window that says nothing surprising stays out of the strip; the line is a receipt for
        // the cases where the dates change how the answer should be read
        (machine.anything || Boolean(freshness?.notable)) && (
          <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-text-muted">
            {machine.read.length > 0 && (
              <span className="flex flex-wrap items-center gap-1">
                <FileText size={10} className="flex-shrink-0" />
                <span className="uppercase tracking-wider">Read in full</span>
                {machine.read.map((source) => (
                  <button
                    key={source.url}
                    type="button"
                    data-read={source.url}
                    aria-expanded={openRead === source.url}
                    onClick={() => setOpenRead((current) => (current === source.url ? null : source.url))}
                    title={`Open the page text this answer's prompt carried from ${source.title} — ${source.given} characters, read by ${source.via}`}
                    className={`flex max-w-[16rem] items-center gap-1 rounded-full border px-2 py-0.5 transition-colors ${
                      openRead === source.url
                        ? 'border-accent/40 bg-accent-subtle text-text-primary'
                        : 'border-border-subtle bg-bg-surface text-text-secondary hover:border-accent/30 hover:text-text-primary'
                    }`}
                  >
                    <span className="font-mono text-text-muted">{source.citation}</span>
                    <span className="truncate">{source.title}</span>
                    <span className="flex-shrink-0 font-mono text-text-muted">{source.given}</span>
                  </button>
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
            {freshness?.notable && (
              <FreshnessReceipt
                freshness={freshness}
                onSearchRecent={
                  query && onSearchRecent ? () => onSearchRecent(query, { messageId: message.id }) : undefined
                }
              />
            )}
            {machine.extraSearches.length > 0 && (
              <span className="flex flex-wrap items-center gap-1">
                <Search size={10} className="flex-shrink-0" />
                <span className="uppercase tracking-wider">Searched again</span>
                <span className="text-text-muted">· search only</span>
                {machine.extraSearches.map((query) => {
                  // what this search added, when the turn recorded it: a search that found five new
                  // pages and one that found the same three again must not look identical
                  const yielded = machine.searchYields[query];
                  return (
                    <button
                      key={query}
                      type="button"
                      onClick={() => onRetrySearch?.(query, { messageId: message.id })}
                      disabled={!onRetrySearch}
                      title={
                        yielded
                          ? `Search only — run “${query}” again; it returned ${yielded.found} source${
                              yielded.found === 1 ? '' : 's'
                            }, ${yielded.added} new — this answer is not rewritten`
                          : `Search only — run “${query}” again; this answer is not rewritten`
                      }
                      className="flex max-w-[16rem] items-center gap-1 rounded-full border border-border-subtle bg-bg-surface px-2 py-0.5 text-text-secondary transition-colors hover:border-accent/30 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <span className="truncate">{query}</span>
                      {yielded && (
                        <span
                          className={`flex-shrink-0 font-mono ${
                            yielded.added > 0 ? 'text-accent' : 'text-text-muted opacity-70'
                          }`}
                        >
                          {yielded.added > 0 ? `+${yielded.added}` : 'nothing new'}
                        </span>
                      )}
                      <Search size={8} className="flex-shrink-0" />
                    </button>
                  );
                })}
              </span>
            )}
            {/* The extracted page, not the live URL: a figure can only be checked against the text
                the model actually read, and the prompt caps that text. */}
            {openSource && (
              <div className="mt-1 w-full rounded-lg border border-border-subtle bg-bg-surface p-2.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-mono text-accent">{openSource.citation}</span>
                  <span className="min-w-0 flex-1 truncate text-text-primary">{openSource.title}</span>
                  <span className="font-mono text-text-secondary">{openSource.given} chars given</span>
                  {openSource.stored > openSource.given && (
                    <span className="font-mono text-text-muted">{openSource.stored} stored</span>
                  )}
                  <span className="rounded border border-border-subtle px-1 py-0.5 text-text-muted">
                    read by {openSource.via}
                  </span>
                  <a
                    href={openSource.url}
                    target="_blank"
                    rel="noreferrer"
                    title={`Open the live page: ${openSource.url}`}
                    className="flex items-center gap-0.5 text-accent hover:underline"
                  >
                    Page <ExternalLink size={8} />
                  </a>
                  <button
                    type="button"
                    onClick={() => setOpenRead(null)}
                    aria-label="Close the page text"
                    title="Close the page text"
                    className="rounded p-0.5 text-text-muted transition-colors hover:text-text-primary"
                  >
                    <X size={10} />
                  </button>
                </div>
                <p className="mt-1 text-text-muted">
                  The page text this answer's prompt carried, exactly as the model read it — the record a figure in
                  the answer can be checked against.
                </p>
                <div
                  data-page-text={openSource.url}
                  className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-border-subtle bg-bg-deep p-2 font-mono text-[10px] leading-relaxed text-text-secondary"
                >
                  {openSource.text}
                </div>
              </div>
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
                      {sentence.status === 'unknown-citation'
                        ? 'Citation that does not exist'
                        : sentence.status === 'unread-citation'
                          ? 'Citation to a source the prompt did not carry'
                          : 'Not in the cited page'}:
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
                  onClick={() => onRetrySearch?.(bluf.query, { messageId: message.id })}
                  disabled={!onRetrySearch}
                  title={`Search only — the bottom line of this answer as a query, run across the selected engines; this answer is not rewritten: ${bluf.query}`}
                  className="flex max-w-full items-center gap-1 rounded-full border border-accent/30 bg-accent-subtle px-2.5 py-1 text-left text-[11px] text-accent transition-colors hover:bg-accent hover:text-bg-base disabled:opacity-40"
                >
                  <Search size={10} className="flex-shrink-0" />
                  <span className="flex-shrink-0 font-mono text-[9px] uppercase tracking-wider opacity-70">Search</span>
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
  title,
  active,
  disabled,
}: {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
  /** what the control does, for the one-line row where the label has to be short */
  title?: string;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
        active ? 'bg-accent-subtle text-accent' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
      }`}
    >
      <Icon size={11} />
      {label}
    </button>
  );
}
