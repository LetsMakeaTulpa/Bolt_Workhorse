import { useState } from 'react';
import { ResearchPreset } from '../types';
import { ChevronDown, Check, Layers } from 'lucide-react';

interface PresetSelectorProps {
  presets: ResearchPreset[];
  selectedPreset: string;
  onSelectPreset: (preset: string) => void;
}

export function PresetSelector({ presets, selectedPreset, onSelectPreset }: PresetSelectorProps) {
  const [open, setOpen] = useState(false);

  const current = presets.find((p) => p.name === selectedPreset);
  const displayName = current ? current.name.replace(/-/g, ' ') : selectedPreset;

  const grouped: Record<string, ResearchPreset[]> = {};
  for (const p of presets) {
    if (!grouped[p.category]) grouped[p.category] = [];
    grouped[p.category].push(p);
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-bg-elevated px-2.5 py-1.5 text-xs text-text-primary transition-colors hover:bg-bg-hover"
      >
        <Layers size={14} className="text-olive" />
        <span className="hidden md:inline capitalize">{displayName}</span>
        <ChevronDown size={12} className={`text-text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1.5 w-72 rounded-xl border border-border bg-bg-surface shadow-2xl animate-slide-up">
            <div className="border-b border-border-subtle px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
              Research Presets
            </div>
            <div className="max-h-64 overflow-y-auto p-1.5">
              {Object.entries(grouped).map(([category, items]) => (
                <div key={category}>
                  <div className="px-2 py-1 text-[9px] font-semibold uppercase tracking-wider text-text-muted">{category}</div>
                  {items.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => { onSelectPreset(p.name); setOpen(false); }}
                      className={`flex w-full items-start justify-between rounded-lg px-2.5 py-2 text-left transition-colors ${
                        selectedPreset === p.name ? 'bg-olive-subtle text-olive' : 'text-text-secondary hover:bg-bg-hover'
                      }`}
                    >
                      <div className="flex flex-col min-w-0 flex-1">
                        <span className="text-[11px] font-medium capitalize">{p.name.replace(/-/g, ' ')}</span>
                        <span className="text-[10px] text-text-muted truncate">{p.description}</span>
                        {p.config.engines && (
                          <span className="mt-0.5 text-[9px] text-text-muted font-mono">{p.config.engines.length} engines · {p.config.max_iterations ?? 2} iterations</span>
                        )}
                      </div>
                      {selectedPreset === p.name && <Check size={14} className="flex-shrink-0 mt-0.5" />}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
