import { useState, useRef, useEffect } from 'react';
import { Sparkles, ArrowUp, ChevronDown, Check, Loader2, Globe, SlidersHorizontal, Square, FileText, Paperclip, X } from 'lucide-react';
import { ANSWER_BUDGET_WORDS, type PromptVariantStatus } from '../lib/promptVariant';
import { DORK_ENGINE_NOTE, DORK_OPERATORS, DORK_TEMPLATES } from '../lib/dorks';
import { ENGINE_CATALOG, ENGINE_GROUPS, SEARCH_SCOPES, matchScope, type EngineIssue } from '../lib/engines';
import { engineKeyStatus, type KeyState } from '../lib/engineKeyStatus';

/**
 * Key state inside the picker, so an engine can be judged before it is selected. The row under the
 * composer only covers what is already selected; this is the same status, one click earlier.
 */
const KEY_TEXT_TONE: Record<KeyState, string> = {
  ready: 'text-olive',
  deployment: 'text-olive',
  keyless: 'text-text-muted',
  optional: 'text-text-muted',
  unknown: 'text-text-muted',
  partial: 'text-warning',
  missing: 'text-warning',
  rejected: 'text-warning',
  unused: 'text-accent',
};

const KEY_DOT_TONE: Record<KeyState, string> = {
  ready: 'bg-olive',
  deployment: 'bg-olive/60',
  keyless: 'bg-text-muted/30',
  optional: 'bg-text-muted/40',
  unknown: 'bg-text-muted/70',
  partial: 'bg-warning',
  missing: 'bg-warning',
  rejected: 'bg-warning',
  unused: 'bg-accent',
};

/** States worth spelling out in a row this narrow; the rest speak through the dot and tooltip. */
const KEY_SHOW_TEXT = new Set<KeyState>(['ready', 'deployment', 'optional', 'partial', 'missing', 'rejected', 'unused']);

/** A file's text travels inside the message, so a long one is cut rather than silently refused. */
const ATTACH_CHARS = 32_000;

interface Attachment {
  name: string;
  text: string;
}

export const SEARCH_ENGINES = ENGINE_CATALOG.map((engine) => ({
  id: engine.id,
  label: engine.label,
  client: engine.runtime === 'browser',
  group: engine.group,
  needsSetup: Boolean(engine.needsSetup),
  note: engine.note,
}));

interface SearchBarProps {
  onSearch: (query: string) => void;
  onRunLane?: (lane: string, target: string) => void;
  engines: string[];
  onEnginesChange: (engines: string[]) => void;
  useDorks: boolean;
  onUseDorksChange: (value: boolean) => void;
  rawOnly?: boolean;
  onRawOnlyChange?: (value: boolean) => void;
  /** true while the model streams: the composer cannot take a new question then */
  disabled: boolean;
  /** a search is running; the box stays usable so a new query can replace it */
  searching?: boolean;
  /** stop the running search without starting another one */
  onCancel?: () => void;
  /** secret names this account has stored — names only, never values */
  storedKeys?: string[];
  /** the last run's engine status: the only evidence about deployment-level secrets */
  issues?: EngineIssue[];
  /** secret names the deployment reported holding; null when it could not be asked */
  deploymentSecrets?: string[] | null;
  /** which system prompt the next turn sends — a variant answers differently, so it is named here */
  promptStatus?: PromptVariantStatus;
  /** a query pressed elsewhere in the page (a dork in an answer), waiting to become the draft */
  draftQuery?: string | null;
  /** the draft was taken into the box; the page clears its copy so a later press is not swallowed */
  onDraftUsed?: () => void;
}

export function SearchBar({
  onSearch,
  onRunLane,
  engines,
  onEnginesChange,
  useDorks,
  onUseDorksChange,
  rawOnly,
  onRawOnlyChange,
  promptStatus,
  disabled,
  searching = false,
  onCancel,
  storedKeys = [],
  issues = [],
  deploymentSecrets = null,
  draftQuery,
  onDraftUsed,
}: SearchBarProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [dorksOpen, setDorksOpen] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  /** the attachment whose text is open under the box, by index */
  const [preview, setPreview] = useState<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // the box grows with the question instead of hiding the end of it
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [query]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        setDorksOpen(false);
      }
      // every turn starts here: one keystroke back to the message box from anywhere
      const typing = /^(input|textarea)$/i.test((event.target as HTMLElement | null)?.tagName ?? '');
      if (!typing && (event.key === '/' || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k'))) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // A dork pressed in an answer arrives here rather than being searched on the spot: the reader
  // gets to edit it first, and sending it is still their press. Dorks were what it was written as,
  // so the dork switch goes on with it instead of silently compiling the operators away.
  useEffect(() => {
    if (!draftQuery) return;
    setQuery(draftQuery);
    if (!useDorks) onUseDorksChange(true);
    onDraftUsed?.();
    window.setTimeout(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(draftQuery.length, draftQuery.length);
    }, 0);
  }, [draftQuery, useDorks, onUseDorksChange, onDraftUsed]);

  const toggleEngine = (id: string) => {
    onEnginesChange(engines.includes(id) ? engines.filter((e) => e !== id) : [...engines, id]);
  };

  const activeScope = matchScope(engines);

  const attachFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const added: Attachment[] = [];
    for (const file of Array.from(files)) {
      const text = await file.text();
      added.push({
        name: file.name,
        text: text.length > ATTACH_CHARS ? `${text.slice(0, ATTACH_CHARS)}\n… (truncated)` : text,
      });
    }
    setAttachments((current) => [...current, ...added]);
  };

  const submit = () => {
    const asked = query.trim();
    if (!asked || disabled) return;
    const attached = attachments.map((file) => `--- ${file.name} ---\n${file.text}`).join('\n\n');
    onSearch(attached ? `${asked}\n\n${attached}` : asked);
    // a sent message leaves the box: the next turn starts with nothing in it
    setQuery('');
    setAttachments([]);
    setPreview(null);
  };

  const applyDork = (pattern: string) => {
    const hasTarget = Boolean(query.trim());
    const target = hasTarget ? query.trim() : '{target}';
    const next = pattern.replace('{target}', target);
    setQuery(next);
    if (!useDorks) onUseDorksChange(true);
    setDorksOpen(false);
    // With no target typed yet, select the placeholder so typing replaces it directly.
    window.setTimeout(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      const start = next.indexOf('{target}');
      if (!hasTarget && start >= 0) input.setSelectionRange(start, start + '{target}'.length);
      else input.setSelectionRange(next.length, next.length);
    }, 0);
  };

  const insertOperator = (snippet: string) => {
    setQuery((current) => (current.trim() ? `${current.trim()} ${snippet}` : snippet));
    if (!useDorks) onUseDorksChange(true);
    inputRef.current?.focus();
  };

  const templateGroups = [...new Set(DORK_TEMPLATES.map((t) => t.group))];
  const stored = new Set(storedKeys);
  const deployment = deploymentSecrets ? new Set(deploymentSecrets) : null;

  return (
    <div className="mb-1">
      <div className="rounded-2xl border border-border bg-bg-elevated px-3 py-1.5 shadow-sm transition-colors focus-within:border-accent/50">
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            {attachments.map((file, index) => (
              <span
                key={`${file.name}-${index}`}
                className="flex items-center gap-1 rounded-full border border-border-subtle bg-bg-surface py-0.5 pl-2 pr-1 text-[10px] text-text-secondary"
              >
                <FileText size={10} className="flex-shrink-0 text-olive" />
                <button
                  type="button"
                  onClick={() => setPreview(preview === index ? null : index)}
                  title={`Preview ${file.name}`}
                  aria-expanded={preview === index}
                  className="max-w-[12rem] truncate transition-colors hover:text-text-primary"
                >
                  {file.name}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAttachments((current) => current.filter((_, i) => i !== index));
                    setPreview(null);
                  }}
                  aria-label={`Remove ${file.name}`}
                  className="flex-shrink-0 rounded-full p-0.5 text-text-muted transition-colors hover:text-warning"
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="flex-shrink-0 text-text-muted" />
          <textarea
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends and Shift+Enter starts a new line, like every other chat box
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder="Ask a question — the web is searched behind the answer…"
            disabled={disabled}
            className="max-h-[168px] w-full min-w-0 flex-1 resize-none bg-transparent py-2 text-sm leading-relaxed text-text-primary placeholder-text-muted outline-none disabled:opacity-40"
            aria-label="Ask a question"
            />
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".txt,.md,.markdown,.csv,.json,.log,.html,.xml,.yml,.yaml,text/*"
            className="hidden"
            onChange={(e) => {
              void attachFiles(e.target.files);
              // so picking the same file again still counts as a change
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={disabled}
            title="Attach text files — their contents are sent with the question"
            aria-label="Attach files"
            className="flex-shrink-0 text-text-muted transition-colors hover:text-text-primary disabled:opacity-40"
          >
            <Paperclip size={14} />
          </button>
          {query ? (
            <button
              onClick={() => {
                setQuery('');
                inputRef.current?.focus();
              }}
              className="flex-shrink-0 text-[10px] text-text-muted transition-colors hover:text-text-primary"
            >
              clear
            </button>
          ) : (
            <kbd className="hidden flex-shrink-0 rounded border border-border-subtle px-1.5 py-0.5 font-mono text-[10px] text-text-muted sm:block">
              /
            </kbd>
          )}
          {searching && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              title="Stop the running search — results already collected stay in the panel"
              aria-label="Stop search"
              className="flex flex-shrink-0 items-center gap-1.5 rounded-xl border border-warning/40 bg-warning-subtle px-3 py-2 text-xs font-semibold text-warning transition-colors hover:border-warning/70"
            >
              <Square size={11} strokeWidth={3} />
              <span>Stop</span>
            </button>
          )}
          <button
            onClick={submit}
            disabled={disabled || !query.trim()}
            title={searching ? 'Replace the running answer' : 'Send (Enter)'}
            className="flex flex-shrink-0 items-center gap-1.5 rounded-xl bg-olive px-3.5 py-2 text-xs font-semibold text-bg-deep transition-colors hover:bg-olive-hover disabled:cursor-not-allowed disabled:opacity-30"
          >
            {disabled || searching ? <Loader2 size={13} className={searching ? 'animate-spin' : ''} /> : <ArrowUp size={13} />}
            <span>{rawOnly ? 'Collect' : 'Send'}</span>
          </button>
        </div>
      </div>

      {preview !== null && attachments[preview] && (
        <div className="mt-1 rounded-xl border border-border bg-bg-surface p-2">
          <div className="flex items-center justify-between gap-2 pb-1">
            <span className="flex min-w-0 items-center gap-1 text-[10px] text-text-secondary">
              <FileText size={10} className="flex-shrink-0 text-olive" />
              <span className="truncate">{attachments[preview].name}</span>
            </span>
            <button
              type="button"
              onClick={() => setPreview(null)}
              className="flex-shrink-0 text-[10px] text-text-muted transition-colors hover:text-text-primary"
            >
              close
            </button>
          </div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-text-muted">
            {attachments[preview].text}
          </pre>
        </div>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {SEARCH_SCOPES.map((scope) => {
          const active = activeScope === scope.id;
          return (
            <button
              key={scope.id}
              onClick={() => onEnginesChange(scope.engines)}
              disabled={disabled}
              title={scope.hint}
              aria-pressed={active}
              className={`whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] transition-colors disabled:opacity-40 ${
                active
                  ? 'border-accent/40 bg-accent-subtle text-accent'
                  : 'border-border-subtle text-text-secondary hover:bg-bg-hover hover:text-text-primary'
              }`}
            >
              {scope.label}
            </button>
          );
        })}

        <span className="mx-1 h-4 w-px bg-border-subtle" />

        <div className="relative">
          <button
            onClick={() => {
              setOpen(!open);
              setDorksOpen(false);
            }}
            disabled={disabled}
            className="flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border-subtle px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:bg-bg-hover disabled:opacity-40"
            title="Choose search engines"
          >
            <Globe size={12} className="text-olive" />
            <span>{activeScope ? `${SEARCH_SCOPES.find((s) => s.id === activeScope)?.label} · ${engines.length}` : `${engines.length} engines`}</span>
            <ChevronDown size={10} className={`text-text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>

          {open && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
              <div className="absolute left-0 bottom-full z-50 mb-1.5 max-h-[70vh] w-64 overflow-y-auto rounded-xl border border-border bg-bg-surface p-1.5 shadow-2xl animate-slide-up">
                <div className="px-2 py-1 text-[9px] font-semibold uppercase tracking-wider text-text-muted">
                  Search engines
                </div>
                {ENGINE_GROUPS.map((group) => (
                  <div key={group}>
                    <div className="mt-1.5 px-2 text-[9px] font-semibold uppercase tracking-wider text-text-muted">
                      {group}
                    </div>
                    {SEARCH_ENGINES.filter((engine) => engine.group === group).map((engine) => {
                      const active = engines.includes(engine.id);
                      const keyStatus = engineKeyStatus(engine.id, stored, issues, deployment);
                      return (
                        <button
                          key={engine.id}
                          onClick={() => toggleEngine(engine.id)}
                          title={engine.note}
                          className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11px] text-text-secondary transition-colors hover:bg-bg-hover"
                        >
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className={`truncate ${active ? 'text-text-primary' : ''}`}>{engine.label}</span>
                            {engine.client && (
                              <span className="flex-shrink-0 rounded bg-bg-hover px-1 text-[8px] uppercase tracking-wider text-text-secondary">
                                browser
                              </span>
                            )}
                            {engine.needsSetup && (
                              <span className="flex-shrink-0 rounded bg-olive-subtle px-1 text-[8px] uppercase tracking-wider text-olive">
                                key
                              </span>
                            )}
                          </span>
                          <span className="flex flex-shrink-0 items-center gap-1">
                            {keyStatus && (
                              <span title={keyStatus.detail} className="flex items-center gap-1 whitespace-nowrap">
                                <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${KEY_DOT_TONE[keyStatus.state]}`} />
                                {KEY_SHOW_TEXT.has(keyStatus.state) && (
                                  <span className={`text-[9px] ${KEY_TEXT_TONE[keyStatus.state]}`}>{keyStatus.text}</span>
                                )}
                              </span>
                            )}
                            {active && <Check size={13} className="flex-shrink-0 text-accent" />}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))}
                <div className="mt-1 flex items-center justify-between border-t border-border-subtle px-2 pt-1.5">
                  <button
                    onClick={() => onEnginesChange(SEARCH_ENGINES.filter((engine) => !engine.needsSetup).map((e) => e.id))}
                    className="text-[10px] text-accent hover:underline"
                  >
                    All keyless
                  </button>
                  <button
                    onClick={() => onEnginesChange([])}
                    className="text-[10px] text-text-muted transition-colors hover:text-text-primary"
                  >
                    Clear
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="relative">
          <button
            onClick={() => {
              setDorksOpen(!dorksOpen);
              setOpen(false);
            }}
            disabled={disabled}
            className={`flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] transition-colors disabled:opacity-40 ${
              useDorks
                ? 'border-accent/30 bg-accent-subtle text-accent'
                : 'border-border-subtle text-text-secondary hover:bg-bg-hover'
            }`}
            title="Dork operators, cheat sheet and templates"
            aria-pressed={useDorks}
          >
            <SlidersHorizontal size={11} />
            Dorks {useDorks ? 'on' : 'off'}
          </button>

          {/* A variant changes behaviour, not tone, so it is named where the question is typed. */}
          {promptStatus?.source === 'variant' && (
            <span
              title={`Answers use the variant saved in Settings (${promptStatus.words} words${promptStatus.overBudget ? `, over the ${ANSWER_BUDGET_WORDS}-word budget` : ''}), not the built-in prompt.`}
              className={`flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-1 text-[10px] ${
                promptStatus.overBudget
                  ? 'border-warning/40 bg-warning-subtle text-warning'
                  : 'border-accent/30 bg-accent-subtle text-accent'
              }`}
            >
              <FileText size={10} />
              Custom prompt · {promptStatus.words}w
            </span>
          )}

          {dorksOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setDorksOpen(false)} />
              <div className="absolute left-0 bottom-full z-50 mb-1.5 max-h-[70vh] w-80 overflow-y-auto rounded-xl border border-border bg-bg-surface p-2 shadow-2xl animate-slide-up">
                <div className="flex items-center justify-between rounded-lg bg-bg-elevated px-2.5 py-1.5">
                  <span className="text-[11px] text-text-secondary">Apply dork operators</span>
                  <button
                    onClick={() => onUseDorksChange(!useDorks)}
                    className={`rounded px-2 py-0.5 text-[10px] font-semibold transition-colors ${
                      useDorks ? 'bg-accent-subtle text-accent' : 'bg-bg-hover text-text-secondary'
                    }`}
                  >
                    {useDorks ? 'ON' : 'OFF'}
                  </button>
                </div>
                <p className="mt-1.5 px-1 text-[10px] leading-relaxed text-text-muted">{DORK_ENGINE_NOTE}</p>

                {templateGroups.map((group) => (
                  <div key={group} className="mt-2">
                    <div className="flex items-center justify-between px-1">
                      <span className="text-[9px] font-semibold uppercase tracking-wider text-text-muted">
                        {group}
                      </span>
                      <button
                        onClick={() => {
                          onRunLane?.(group, query.trim());
                          setDorksOpen(false);
                        }}
                        disabled={!query.trim() || disabled || !onRunLane}
                        title={
                          query.trim()
                            ? `Run every ${group} dork against "${query.trim()}"`
                            : 'Type a target in the search box first'
                        }
                        className="rounded px-1.5 py-0.5 text-[9px] font-semibold text-accent transition-colors hover:bg-accent-subtle disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        Run lane
                      </button>
                    </div>
                    {DORK_TEMPLATES.filter((t) => t.group === group).map((template) => (
                      <button
                        key={template.label}
                        onClick={() => applyDork(template.pattern)}
                        title={template.pattern}
                        className="block w-full truncate rounded px-1 py-0.5 text-left text-[10px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
                      >
                        {template.label}
                      </button>
                    ))}
                  </div>
                ))}

                <div className="mt-2 border-t border-border-subtle pt-1.5">
                  <div className="px-1 text-[9px] font-semibold uppercase tracking-wider text-text-muted">
                    Operators
                  </div>
                  {DORK_OPERATORS.map((operator) => (
                    <button
                      key={operator.operator + operator.description}
                      onClick={() => insertOperator(operator.example)}
                      title={operator.example}
                      className="flex w-full items-baseline gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-bg-hover"
                    >
                      <span className="flex-shrink-0 font-mono text-[10px] text-accent">{operator.operator}</span>
                      <span className="truncate text-[10px] text-text-muted">{operator.description}</span>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={() => onRawOnlyChange?.(!rawOnly)}
          disabled={disabled || !onRawOnlyChange}
          aria-pressed={Boolean(rawOnly)}
          title="Sources only — collect and rank them in the panel without asking for an answer"
          className={`flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
            rawOnly
              ? 'border-accent/40 bg-accent-subtle text-accent'
              : 'border-border-subtle text-text-secondary hover:bg-bg-hover'
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${rawOnly ? 'bg-accent' : 'bg-text-muted/50'}`} />
          Sources only
        </button>
      </div>
    </div>
  );
}
