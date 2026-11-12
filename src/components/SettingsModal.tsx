import { ResearchPreset } from '../types';
import { supabase } from '../lib/supabase';
import { X, Layers, Cpu, Globe, Shield, Key, Check, AlertCircle } from 'lucide-react';
import { useState, useEffect } from 'react';

interface SettingsModalProps {
  presets: ResearchPreset[];
  selectedPreset: string;
  onSelectPreset: (preset: string) => void;
  onClose: () => void;
}

const ENGINE_DESCRIPTIONS: Record<string, string> = {
  duckduckgo: 'General web search with privacy focus',
  wikipedia: 'Encyclopedia and entity background',
  arxiv: 'Scientific preprints and academic papers',
  github: 'Code repositories and technical documentation',
  brave: 'Independent privacy-focused web search',
  openalex: 'Scholarly works and research metadata',
};

export function SettingsModal({ presets, selectedPreset, onSelectPreset, onClose }: SettingsModalProps) {
  const current = presets.find((p) => p.name === selectedPreset);
  const [apiKey, setApiKey] = useState('');
  const [keySaved, setKeySaved] = useState(false);
  const [keyError, setKeyError] = useState('');
  const [keyConfigured, setKeyConfigured] = useState(false);

  useEffect(() => {
    supabase.from('app_config').select('featherless_api_key').eq('id', 1).maybeSingle()
      .then(({ data }) => {
        if (data?.featherless_api_key) {
          setKeyConfigured(true);
          setApiKey(data.featherless_api_key);
        }
      });
  }, []);

  const handleSaveKey = async () => {
    setKeyError('');
    if (!apiKey.trim()) {
      setKeyError('API key cannot be empty');
      return;
    }
    const { error } = await supabase
      .from('app_config')
      .upsert({ id: 1, featherless_api_key: apiKey.trim() });

    if (error) {
      // Row might not exist yet — try insert
      const { error: insertError } = await supabase
        .from('app_config')
        .insert({ id: 1, featherless_api_key: apiKey.trim() });
      if (insertError) {
        setKeyError(insertError.message);
        return;
      }
    }
    setKeySaved(true);
    setKeyConfigured(true);
    setTimeout(() => setKeySaved(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-lg rounded-2xl border border-border bg-bg-surface shadow-2xl animate-slide-up">
        <div className="flex items-center justify-between border-b border-border-subtle p-4">
          <div className="flex items-center gap-2">
            <Layers size={18} className="text-accent" />
            <h2 className="text-base font-semibold text-text-primary">Research Configuration</h2>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-5 p-4 max-h-[70vh] overflow-y-auto">
          {/* API Key Section */}
          <div>
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-text-muted">
              Featherless API Key
            </label>
            <div className="rounded-lg border border-border-subtle bg-bg-elevated p-3">
              <div className="flex items-center gap-2 mb-2">
                <Key size={14} className={keyConfigured ? 'text-olive' : 'text-warning'} />
                <span className="text-xs font-medium text-text-primary">
                  {keyConfigured ? 'API key configured' : 'API key required'}
                </span>
              </div>
              <p className="text-[11px] text-text-muted mb-2.5">
                Enter your Featherless.ai API key to power AI chat and search. Get a key from the Featherless dashboard. The key is stored securely in the database and used server-side only.
              </p>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => { setApiKey(e.target.value); setKeySaved(false); }}
                  placeholder="rc_..."
                  className="flex-1 rounded-lg border border-border bg-bg-base px-3 py-2 text-xs text-text-primary placeholder-text-muted outline-none focus:border-accent/40 font-mono"
                />
                <button
                  onClick={handleSaveKey}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                    keySaved ? 'bg-olive text-bg-base' : 'bg-accent text-bg-base hover:bg-accent-hover'
                  }`}
                >
                  {keySaved ? <><Check size={13} /> Saved</> : 'Save Key'}
                </button>
              </div>
              {keyError && (
                <div className="mt-2 flex items-center gap-1.5 text-[11px] text-error">
                  <AlertCircle size={12} />
                  <span>{keyError}</span>
                </div>
              )}
            </div>
          </div>

          {/* Active Preset */}
          <div>
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-text-muted">Active Preset</label>
            <div className="rounded-lg border border-border-subtle bg-bg-elevated p-3">
              <div className="flex items-center gap-2 mb-1">
                <Shield size={14} className="text-olive" />
                <span className="text-sm font-medium text-text-primary capitalize">{(current?.name ?? selectedPreset).replace(/-/g, ' ')}</span>
              </div>
              <p className="text-xs text-text-secondary">{current?.description ?? 'Custom configuration'}</p>
            </div>
          </div>

          {/* Preset Selection */}
          <div>
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-text-muted">Change Preset</label>
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {presets.map((p) => (
                <button
                  key={p.id}
                  onClick={() => onSelectPreset(p.name)}
                  className={`flex w-full items-center justify-between rounded-lg border p-2.5 text-left transition-colors ${
                    selectedPreset === p.name
                      ? 'border-accent/30 bg-accent-subtle'
                      : 'border-border-subtle bg-bg-elevated hover:bg-bg-hover'
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-text-primary capitalize">{p.name.replace(/-/g, ' ')}</span>
                      {p.is_legacy && <span className="text-[9px] text-text-muted uppercase bg-bg-hover px-1 rounded">legacy</span>}
                    </div>
                    <span className="text-[11px] text-text-muted truncate block">{p.description}</span>
                  </div>
                  <span className="flex-shrink-0 ml-2 text-[9px] text-text-muted uppercase">{p.category}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Engine Info */}
          {current?.config.engines && (
            <div>
              <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-text-muted">Search Engines</label>
              <div className="space-y-1.5">
                {current.config.engines.map((engine) => (
                  <div key={engine} className="flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-elevated p-2.5">
                    <Globe size={13} className="text-olive flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-text-primary capitalize">{engine}</div>
                      <div className="text-[10px] text-text-muted">{ENGINE_DESCRIPTIONS[engine] ?? 'Search provider'}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Config Details */}
          {current?.config && (
            <div>
              <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-text-muted">Configuration</label>
              <div className="grid grid-cols-2 gap-2">
                <ConfigItem label="Max Iterations" value={String(current.config.max_iterations ?? 2)} />
                <ConfigItem label="Max Results" value={String(current.config.max_results ?? 5)} />
                <ConfigItem label="Evidence Required" value={current.config.evidence_required ? 'Yes' : 'No'} />
                <ConfigItem label="Dork Operators" value={current.config.use_dorks ? 'Enabled' : 'Disabled'} />
              </div>
            </div>
          )}

          {/* Provider Info */}
          <div className="rounded-lg border border-border-subtle bg-bg-elevated p-3">
            <div className="flex items-center gap-2 mb-1">
              <Cpu size={14} className="text-accent" />
              <span className="text-xs font-medium text-text-primary">Inference Provider</span>
            </div>
            <p className="text-[11px] text-text-muted">Featherless.ai — OpenAI-compatible API with 24,000+ models. Select any model from the top bar dropdown.</p>
          </div>
        </div>

        <div className="flex justify-end border-t border-border-subtle p-4">
          <button onClick={onClose} className="rounded-lg bg-accent px-4 py-2 text-xs font-medium text-bg-base hover:bg-accent-hover transition-colors">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfigItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-elevated p-2.5">
      <div className="text-[10px] text-text-muted uppercase tracking-wider">{label}</div>
      <div className="mt-0.5 text-sm font-medium text-text-primary">{value}</div>
    </div>
  );
}
