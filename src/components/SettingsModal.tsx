import { ResearchPreset } from '../types';
import { supabase } from '../lib/supabase';
import { clearModelHealth, modelHealthCount } from '../lib/api';
import { PROVIDER_KEYS, describeKeys, parseProviderKeys } from '../lib/providerKeys';
import {
  ANSWER_BUDGET_WORDS,
  clearPromptVariant,
  describePromptVariant,
  promptWordCount,
  readPromptVariant,
  savePromptVariant,
} from '../lib/promptVariant';
import { describeEmptyResultBlock } from '../lib/emptyResultPref';
import { X, Layers, Cpu, Globe, Shield, Key, RotateCcw, Loader2, Check } from 'lucide-react';
import { useState, useEffect } from 'react';

interface SettingsModalProps {
  presets: ResearchPreset[];
  selectedPreset: string;
  onSelectPreset: (preset: string) => void;
  onClose: () => void;
  /** signed-in account; provider keys are stored per user */
  userId?: string;
  /** whether an unsourced answer's prose must say that it is unsourced */
  emptyResultBlock: boolean;
  onEmptyResultBlockChange: (enabled: boolean) => void;
}

const ENGINE_DESCRIPTIONS: Record<string, string> = {
  duckduckgo: 'General web search with privacy focus',
  wikipedia: 'Encyclopedia and entity background',
  arxiv: 'Scientific preprints and academic papers',
  github: 'Code repositories and technical documentation',
  brave: 'Independent privacy-focused web search',
  openalex: 'Scholarly works and research metadata',
};

export function SettingsModal({
  presets,
  selectedPreset,
  onSelectPreset,
  onClose,
  userId,
  emptyResultBlock,
  onEmptyResultBlockChange,
}: SettingsModalProps) {
  const current = presets.find((p) => p.name === selectedPreset);
  const [keyConfigured, setKeyConfigured] = useState<boolean | null>(null);
  const [defaultModel, setDefaultModel] = useState('');
  const [healthCount, setHealthCount] = useState(0);
  const [healthCleared, setHealthCleared] = useState(false);
  const [keyText, setKeyText] = useState('');
  const [savingKeys, setSavingKeys] = useState(false);
  const [storedKeys, setStoredKeys] = useState<string[]>([]);
  const [keyMessage, setKeyMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [promptText, setPromptText] = useState('');
  const [promptNote, setPromptNote] = useState<string | null>(null);
  const activePrompt = describePromptVariant(readPromptVariant(userId));

  const handleSavePrompt = () => {
    savePromptVariant(userId, promptText);
    const saved = readPromptVariant(userId);
    setPromptText(saved ?? '');
    setPromptNote(saved ? 'Variant saved — your next answer uses it.' : 'Empty, so the built-in prompt is in use.');
  };

  const handleResetPrompt = () => {
    clearPromptVariant(userId);
    setPromptText('');
    setPromptNote('Built-in prompt restored.');
  };

  const loadStoredKeys = async () => {
    if (!userId) return;
    const { data } = await supabase.from('user_engine_keys').select('name');
    setStoredKeys((data ?? []).map((row) => row.name as string));
  };

  useEffect(() => {
    void loadStoredKeys();
    setPromptText(readPromptVariant(userId) ?? '');
  }, [userId]);

  const handleSaveKeys = async () => {
    const { keys, rejected, invalid } = parseProviderKeys(keyText);
    if (!userId) {
      setKeyMessage({ tone: 'error', text: 'Sign in before adding provider keys.' });
      return;
    }
    if (keys.length === 0) {
      const parts = [
        rejected.length ? `not read by this app: ${rejected.join(', ')}` : '',
        invalid.length ? `unusable line: ${invalid.join(', ')}` : '',
      ].filter(Boolean);
      setKeyMessage({ tone: 'error', text: parts.join(' · ') || 'Nothing to save — use NAME=value lines.' });
      return;
    }

    setSavingKeys(true);
    const rows = keys.map((key) => ({ user_id: userId, name: key.name, value: key.value, updated_at: new Date().toISOString() }));
    const { error } = await supabase.from('user_engine_keys').upsert(rows, { onConflict: 'user_id,name' });
    setSavingKeys(false);

    if (error) {
      setKeyMessage({
        tone: 'error',
        text: /relation .*does not exist|user_engine_keys/i.test(error.message)
          ? 'The keys table is not in this project yet — apply migration 20261115160000_user_engine_keys.sql.'
          : error.message,
      });
      return;
    }

    setKeyText('');
    await loadStoredKeys();
    const note = [rejected.length ? `skipped ${rejected.join(', ')}` : ''].filter(Boolean).join(' · ');
    setKeyMessage({ tone: 'ok', text: `Saved ${describeKeys(keys)}${note ? ` (${note})` : ''}` });
  };

  useEffect(() => setHealthCount(modelHealthCount()), []);

  const handleResetHealth = () => {
    clearModelHealth();
    setHealthCount(0);
    setHealthCleared(true);
    setTimeout(() => setHealthCleared(false), 2500);
  };

  // app_config itself is service-role only; the browser sees the keyless public view
  useEffect(() => {
    supabase
      .from('app_config_public')
      .select('has_api_key, default_model')
      .eq('id', 1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) {
          setKeyConfigured(null);
          return;
        }
        setKeyConfigured(Boolean(data?.has_api_key));
        setDefaultModel(data?.default_model ?? '');
      });
  }, []);

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
                  {keyConfigured === null
                    ? 'API key status unavailable'
                    : keyConfigured
                      ? 'API key configured (server-side)'
                      : 'No API key configured'}
                </span>
              </div>
              <p className="text-[11px] text-text-muted">
                The Featherless key lives in <span className="font-mono text-text-secondary">app_config</span>, which only the
                service role can read or write. Set it from the Supabase dashboard (SQL editor) or the CLI — it is never
                sent to the browser, and it can no longer be entered or read here.
              </p>
              {defaultModel && (
                <p className="mt-1.5 text-[11px] text-text-muted">
                  Default model: <span className="font-mono text-text-secondary">{defaultModel}</span>
                </p>
              )}
            </div>
          </div>

          {/* Provider keys — stored per account, read by the search function per request */}
          <div>
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-text-muted">
              Search provider keys
            </label>
            <div className="rounded-lg border border-border-subtle bg-bg-elevated p-3">
              <p className="mb-2 text-[11px] text-text-muted">
                Paste any of these, one per line, and they are stored against your account — no terminal, no
                deploy per key. Your keys are used before the deployment's own, and only for your searches.
                A second key for the same provider is a spare: name it with a number (<span className="font-mono">EXA_API_KEY_1</span>)
                and the search tries each in turn instead of the new one replacing the old.
              </p>
              <textarea
                value={keyText}
                onChange={(event) => setKeyText(event.target.value)}
                placeholder={'EXA_API_KEY=…\nEXA_API_KEY_1=…  (a spare)\nTAVILY_API_KEY=…\nGOOGLE_API_KEY=…\nGOOGLE_CSE_ID=…'}
                spellCheck={false}
                rows={3}
                className="w-full resize-y rounded-lg border border-border-subtle bg-bg-base px-2.5 py-2 font-mono text-[11px] text-text-primary placeholder-text-muted outline-none focus:border-accent/40"
              />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  onClick={handleSaveKeys}
                  disabled={savingKeys || !keyText.trim()}
                  className="flex items-center gap-1.5 rounded-lg bg-olive px-2.5 py-1.5 text-[11px] font-semibold text-bg-deep transition-colors hover:bg-olive-hover disabled:cursor-not-allowed disabled:opacity-30"
                >
                  {savingKeys ? <Loader2 size={12} className="animate-spin" /> : <Key size={12} />}
                  Save keys
                </button>
                {keyMessage && (
                  <span className={`text-[11px] ${keyMessage.tone === 'ok' ? 'text-olive' : 'text-error'}`}>
                    {keyMessage.text}
                  </span>
                )}
              </div>

              <div className="mt-2.5 flex flex-wrap gap-1 border-t border-border-subtle pt-2">
                {PROVIDER_KEYS.map((provider) => {
                  const stored = storedKeys.includes(provider.name);
                  return (
                    <span
                      key={provider.name}
                      title={`${provider.name} — ${provider.hint}`}
                      className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${
                        stored
                          ? 'border-olive/30 bg-olive-subtle text-olive'
                          : 'border-border-subtle text-text-muted'
                      }`}
                    >
                      {stored && <Check size={9} />}
                      {provider.label}
                    </span>
                  );
                })}
              </div>
              <p className="mt-1.5 text-[10px] text-text-muted">
                If an engine still reports a missing key after saving, the search function in this project is
                an older build — redeploy it once and it will read these rows.
              </p>
            </div>
          </div>

          {/* Answer prompt — swap the prompt for a variant without a build or a deploy */}
          <div>
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-text-muted">
              Answer prompt
            </label>
            <div className="rounded-lg border border-border-subtle bg-bg-elevated p-3">
              <p className="mb-2 text-[11px] text-text-muted">
                Leave empty to use the built-in prompt. A variant is used from your next turn on, so wording can be
                compared on the same searches without touching code.
              </p>
              <textarea
                value={promptText}
                onChange={(event) => {
                  setPromptText(event.target.value);
                  setPromptNote(null);
                }}
                placeholder={`Leave empty for the built-in prompt (${describePromptVariant(null).words} words)…`}
                spellCheck={false}
                rows={8}
                className="w-full resize-y rounded-lg border border-border-subtle bg-bg-base px-2.5 py-2 font-mono text-[11px] text-text-primary placeholder-text-muted outline-none focus:border-accent/40"
              />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  onClick={handleSavePrompt}
                  className="flex items-center gap-1.5 rounded-lg bg-olive px-2.5 py-1.5 text-[11px] font-semibold text-bg-deep transition-colors hover:bg-olive-hover"
                >
                  <Check size={12} />
                  Use this prompt
                </button>
                <button
                  onClick={handleResetPrompt}
                  disabled={activePrompt.source === 'default' && !promptText.trim()}
                  className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-2.5 py-1.5 text-[11px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <RotateCcw size={12} />
                  Built-in
                </button>
                <span className={`text-[11px] ${promptWordCount(promptText) > ANSWER_BUDGET_WORDS ? 'text-warning' : 'text-text-muted'}`}>
                  {promptText.trim() ? `${promptWordCount(promptText)} words typed` : `${activePrompt.words} words in the ${activePrompt.source === 'variant' ? 'active variant' : 'built-in prompt'}`}
                </span>
                {promptNote && <span className="text-[11px] text-olive">{promptNote}</span>}
              </div>
              <p className="mt-1.5 text-[10px] text-text-muted">
                Stored on this device for this account only. Variants are not saved to your account, so a bad one cannot
                follow you to another machine. The built-in prompt states a {ANSWER_BUDGET_WORDS}-word ceiling, a claim
                ledger and citation rules — a variant that drops them changes what an answer is, not just its tone.
              </p>
            </div>
          </div>

          {/* Empty-result block — the switch that lets a search-less answer through */}
          <div>
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-text-muted">
              When a search finds nothing
            </label>
            <div className="rounded-lg border border-border-subtle bg-bg-elevated p-3">
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  role="switch"
                  aria-checked={emptyResultBlock}
                  aria-label="Empty-result block"
                  onClick={() => onEmptyResultBlockChange(!emptyResultBlock)}
                  className={`relative h-5 w-9 flex-shrink-0 rounded-full border transition-colors ${
                    emptyResultBlock
                      ? 'border-olive/40 bg-olive-subtle'
                      : 'border-border-subtle bg-bg-hover'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all ${
                      emptyResultBlock ? 'left-[18px] bg-olive' : 'left-0.5 bg-text-muted'
                    }`}
                  />
                </button>
                <span className="flex-1 text-[11px] text-text-secondary">{describeEmptyResultBlock(emptyResultBlock)}</span>
              </div>
              <p className="mt-1.5 text-[10px] text-text-muted">
                The turn ends in an answer either way, and the gaps behind it are listed under the answer, in the activity
                trail and in the Sources panel in both cases — the search really did come back empty, so the reason is
                owed. This switch only sets what the answer's own prose must do. On: the model is told to say plainly that
                it is not backed by retrieved sources. Off: it answers from its own knowledge without being asked to add
                that line, and is still told not to invent URLs, titles or citation IDs. The unverified badge stays either
                way. Stored on this device.
              </p>
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

          {/* Model Reliability */}
          <div>
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-text-muted">
              Model Reliability
            </label>
            <div className="rounded-lg border border-border-subtle bg-bg-elevated p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-text-primary">
                    {healthCount === 0
                      ? 'No reliability history'
                      : `${healthCount} model${healthCount === 1 ? '' : 's'} tracked`}
                  </div>
                  <p className="mt-0.5 text-[11px] text-text-muted">
                    Learned from live completions: a model that answered moves to the front of the fallback chain, one
                    that hit capacity moves back. Reset to forget that history.
                  </p>
                </div>
                <button
                  onClick={handleResetHealth}
                  disabled={healthCount === 0}
                  className="flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-border-subtle px-2.5 py-1.5 text-[11px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <RotateCcw size={12} />
                  {healthCleared ? 'Cleared' : 'Reset'}
                </button>
              </div>
            </div>
          </div>

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
