import { useState, useMemo } from 'react';
import { ModelInfo } from '../types';
import { ChevronDown, Check, Search, Cpu } from 'lucide-react';

interface ModelSelectorProps {
  models: ModelInfo[];
  selectedModel: string;
  onSelectModel: (model: string) => void;
}

export function ModelSelector({ models, selectedModel, onSelectModel }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    if (!search) return models.slice(0, 50);
    const lower = search.toLowerCase();
    return models.filter((m) => m.id.toLowerCase().includes(lower)).slice(0, 50);
  }, [models, search]);

  const displayName = selectedModel.split('/').pop() ?? selectedModel;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-bg-elevated px-2.5 py-1.5 text-xs text-text-primary transition-colors hover:bg-bg-hover"
      >
        <Cpu size={14} className="text-accent" />
        <span className="hidden lg:inline max-w-[120px] truncate font-mono text-[11px]">{displayName}</span>
        <ChevronDown size={12} className={`text-text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1.5 w-72 rounded-xl border border-border bg-bg-surface shadow-2xl animate-slide-up">
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
              <div className="mt-1.5 text-[10px] text-text-muted">{models.length} models available via Featherless</div>
            </div>
            <div className="max-h-56 overflow-y-auto p-1.5">
              {filtered.length === 0 ? (
                <div className="py-5 text-center text-xs text-text-muted">No models found</div>
              ) : (
                filtered.map((model) => (
                  <button
                    key={model.id}
                    onClick={() => { onSelectModel(model.id); setOpen(false); setSearch(''); }}
                    className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                      selectedModel === model.id ? 'bg-accent-subtle text-accent' : 'text-text-secondary hover:bg-bg-hover'
                    }`}
                  >
                    <div className="flex flex-col min-w-0">
                      <span className="truncate font-medium text-[11px]">{model.name ?? model.id}</span>
                      <span className="text-[10px] text-text-muted truncate font-mono">{model.context_length.toLocaleString()} ctx</span>
                    </div>
                    {selectedModel === model.id && <Check size={14} className="flex-shrink-0" />}
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
