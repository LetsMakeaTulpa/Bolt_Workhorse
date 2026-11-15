import { useState, useRef, useEffect } from 'react';
import { Search, ChevronDown, Check, Loader2, Globe, SlidersHorizontal } from 'lucide-react';
import { DORK_ENGINE_NOTE, DORK_OPERATORS, DORK_TEMPLATES } from '../lib/dorks';
import { ENGINE_CATALOG, ENGINE_GROUPS, SEARCH_SCOPES, matchScope } from '../lib/engines';

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
  disabled: boolean;
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
  disabled,
}: SearchBarProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [dorksOpen, setDorksOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        setDorksOpen(false);
      }
      // the search box is the product: one keystroke back to it from anywhere
      const typing = /^(input|textarea)$/i.test((event.target as HTMLElement | null)?.tagName ?? '');
      if (!typing && (event.key === '/' || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k'))) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const toggleEngine = (id: string) => {
    onEnginesChange(engines.includes(id) ? engines.filter((e) => e !== id) : [...engines, id]);
  };

  const activeScope = matchScope(engines);

  const submit = () => {
    if (!query.trim() || disabled) return;
    onSearch(query.trim());
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

  return (
    <div className="mb-1">
      <div className="flex items-center gap-2 rounded-2xl border border-border bg-bg-elevated px-3 py-1.5 shadow-sm transition-colors focus-within:border-accent/50">
        <Search size={16} className="flex-shrink-0 text-text-muted" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Search the open, deep and dark web…"
          disabled={disabled}
          className="w-full min-w-0 flex-1 bg-transparent py-2 text-sm text-text-primary placeholder-text-muted outline-none disabled:opacity-40"
          aria-label="Search query"
        />
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
        <button
          onClick={submit}
          disabled={disabled || !query.trim()}
          className="flex flex-shrink-0 items-center gap-1.5 rounded-xl bg-olive px-3.5 py-2 text-xs font-semibold text-bg-deep transition-colors hover:bg-olive-hover disabled:cursor-not-allowed disabled:opacity-30"
        >
          {disabled ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
          <span>{rawOnly ? 'Collect' : 'Search'}</span>
        </button>
      </div>

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
                          {active && <Check size={13} className="flex-shrink-0 text-accent" />}
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
          title="Raw results only — collect and rank sources in the panel without asking the model"
          className={`flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
            rawOnly
              ? 'border-accent/40 bg-accent-subtle text-accent'
              : 'border-border-subtle text-text-secondary hover:bg-bg-hover'
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${rawOnly ? 'bg-accent' : 'bg-text-muted/50'}`} />
          Raw
        </button>
      </div>
    </div>
  );
}
