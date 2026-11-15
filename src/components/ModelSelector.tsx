import { useState, useMemo, useEffect } from 'react';
import { ModelInfo } from '../types';
import { ChevronDown, Check, Search, Cpu } from 'lucide-react';
import { getModelHealth, type ModelHealth } from '../lib/api';

interface ModelSelectorProps {
  models: ModelInfo[];
  selectedModel: string;
  onSelectModel: (model: string) => void;
}

type Lane = 'refusal-free' | 'all';

function LaneTab({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded-md px-2 py-1 text-[10px] font-medium transition-colors ${
        active ? 'bg-accent-subtle text-accent' : 'text-text-muted hover:bg-bg-hover hover:text-text-secondary'
      }`}
    >
      {label}
    </button>
  );
}

export function ModelSelector({ models, selectedModel, onSelectModel }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [lane, setLane] = useState<Lane>('refusal-free');
  // what this browser has actually seen answer or fail, refreshed each time the picker opens
  const [health, setHealth] = useState<Record<string, ModelHealth>>({});

  useEffect(() => {
    setHealth(getModelHealth());
  }, [open]);

  const refusalFree = useMemo(() => models.filter((m) => m.lane === 'refusal-free'), [models]);
  const effectiveLane: Lane = lane === 'refusal-free' && refusalFree.length === 0 ? 'all' : lane;

  const filtered = useMemo(() => {
    const pool = effectiveLane === 'refusal-free' ? refusalFree : models;
    if (!search) return pool.slice(0, 60);
    const lower = search.toLowerCase();
    return pool.filter((m) => m.id.toLowerCase().includes(lower)).slice(0, 60);
  }, [effectiveLane, models, refusalFree, search]);

  const displayName = selectedModel.split('/').pop() ?? selectedModel;
  const selectedHealth = health[selectedModel];

  const healthBadge = (h: ModelHealth | undefined) => {
    if (!h || (h.ok === 0 && h.fail === 0)) return null;
    const detail = [
      `${h.ok} answered`,
      h.fail ? `${h.fail} failed` : null,
      h.lastOk ? `last answer ${new Date(h.lastOk).toLocaleTimeString()}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    return (
      <span
        title={`On this machine: ${detail}`}
        className="flex flex-shrink-0 items-center gap-1.5 font-mono text-[9px] leading-none"
      >
        {h.ok > 0 && <span className="text-success">{h.ok}✓</span>}
        {h.fail > 0 && <span className="text-error">{h.fail}✕</span>}
      </span>
    );
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-bg-elevated px-2.5 py-1.5 text-xs text-text-primary transition-colors hover:bg-bg-hover"
      >
        <Cpu size={14} className="text-accent" />
        <span className="hidden lg:inline max-w-[120px] truncate font-mono text-[11px]">{displayName}</span>
        {selectedHealth && healthBadge({ ...selectedHealth, fail: selectedHealth.ok > 0 ? 0 : selectedHealth.fail })}
        <ChevronDown size={12} className={`text-text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1.5 w-80 rounded-xl border border-border bg-bg-surface shadow-2xl animate-slide-up">
            <div className="border-b border-border-subtle p-2.5">
              <div className="flex items-center gap-2 rounded-lg bg-bg-elevated px-2.5 py-1.5">
                <Search size={13} className="text-text-muted" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search models..."
                  className="flex-1 bg-transparent text-xs text-text-primary placeholder-text-muted outline-none"
                  autoFocus
                />
              </div>
              <div className="mt-2 flex items-center gap-1">
                <LaneTab
                  active={effectiveLane === 'refusal-free'}
                  onClick={() => setLane('refusal-free')}
                  label={`Refusal-free (${refusalFree.length})`}
                />
                <LaneTab active={effectiveLane === 'all'} onClick={() => setLane('all')} label={`All (${models.length})`} />
              </div>
            </div>
            <div className="border-b border-border-subtle px-2.5 py-1.5 text-[9px] text-text-muted">
              Plan limit: 4 model switches per minute — stay on one model while researching.
            </div>
            <div className="max-h-64 overflow-y-auto p-1.5">
              {filtered.length === 0 ? (
                <div className="py-5 text-center text-xs text-text-muted">No models found</div>
              ) : (
                [
                  { label: 'XORTRON', items: filtered.filter((m) => /xortron/i.test(m.id)) },
                  { label: 'Other models', items: filtered.filter((m) => !/xortron/i.test(m.id)) },
                ].map((section) =>
                  section.items.length === 0 ? null : (
                    <div key={section.label}>
                      <div className="px-1 pb-0.5 pt-1.5 text-[9px] font-semibold uppercase tracking-wider text-text-muted">
                        {section.label}
                      </div>
                      {section.items.map((model) => (
                        <button
                          key={model.id}
                          onClick={() => {
                            onSelectModel(model.id);
                            setOpen(false);
                            setSearch('');
                          }}
                          className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                            selectedModel === model.id ? 'bg-accent-subtle text-accent' : 'text-text-secondary hover:bg-bg-hover'
                          }`}
                        >
                          <div className="flex flex-col min-w-0">
                            <span className="truncate font-medium text-[11px]">{model.name ?? model.id}</span>
                            <span className="text-[10px] text-text-muted truncate font-mono">
                              {model.lane === 'refusal-free' && <span className="text-accent font-semibold">RF</span>}
                              {model.lane === 'refusal-free' ? ' · ' : ''}
                              {model.context_length.toLocaleString()} ctx
                            </span>
                          </div>
                          {healthBadge(health[model.id])}
                          {selectedModel === model.id && <Check size={14} className="flex-shrink-0" />}
                        </button>
                      ))}
                    </div>
                  ),
                )
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
