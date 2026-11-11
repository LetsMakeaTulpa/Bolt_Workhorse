import { Conversation, Finding, ResearchPreset } from '../types';
import { Plus, MessageSquare, Trash2, Bookmark, Compass, Archive, Layers, Search as SearchIcon } from 'lucide-react';

interface SidebarProps {
  conversations: Conversation[];
  currentConversation: Conversation | null;
  onNewChat: () => void;
  onSelectConversation: (conv: Conversation) => void;
  onDeleteConversation: (id: string) => void;
  findingsCount: number;
  presets: ResearchPreset[];
  selectedPreset: string;
  onSelectPreset: (preset: string) => void;
}

export function Sidebar({
  conversations,
  currentConversation,
  onNewChat,
  onSelectConversation,
  onDeleteConversation,
  findingsCount,
  presets,
  selectedPreset,
  onSelectPreset,
}: SidebarProps) {
  const generalPresets = presets.filter((p) => p.category === 'general');
  const verificationPresets = presets.filter((p) => p.category === 'verification');
  const analyticalPresets = presets.filter((p) => p.category === 'analytical');
  const legacyPresets = presets.filter((p) => p.category === 'legacy');

  return (
    <aside className="flex w-64 flex-col border-r border-border-subtle bg-bg-deep">
      <div className="p-3">
        <button
          onClick={onNewChat}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-bg-base transition-colors hover:bg-accent-hover glow-accent"
        >
          <Plus size={16} />
          New Investigation
        </button>
      </div>

      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-lg bg-bg-surface px-3 py-2 text-xs text-text-secondary border border-border-subtle">
          <Bookmark size={14} className="text-accent" />
          <span>{findingsCount} saved findings</span>
        </div>
      </div>

      {/* Research Presets */}
      <div className="px-3 py-2">
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
          <Layers size={11} />
          Research Presets
        </div>
        <div className="space-y-0.5">
          {generalPresets.map((p) => (
            <PresetItem key={p.id} preset={p} selected={selectedPreset === p.name} onSelect={onSelectPreset} />
          ))}
          {verificationPresets.map((p) => (
            <PresetItem key={p.id} preset={p} selected={selectedPreset === p.name} onSelect={onSelectPreset} />
          ))}
          {analyticalPresets.map((p) => (
            <PresetItem key={p.id} preset={p} selected={selectedPreset === p.name} onSelect={onSelectPreset} />
          ))}
        </div>
        {legacyPresets.length > 0 && (
          <>
            <div className="mt-3 mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
              <Archive size={11} />
              Legacy Profiles
            </div>
            <div className="space-y-0.5">
              {legacyPresets.map((p) => (
                <PresetItem key={p.id} preset={p} selected={selectedPreset === p.name} onSelect={onSelectPreset} />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Conversations */}
      <div className="mt-2 flex-1 overflow-y-auto px-2">
        <div className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
          Investigations
        </div>
        {conversations.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-text-muted">
            No investigations yet
          </div>
        ) : (
          <div className="space-y-0.5">
            {conversations.map((conv) => (
              <div
                key={conv.id}
                className={`group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-xs transition-colors ${
                  currentConversation?.id === conv.id
                    ? 'bg-bg-elevated text-text-primary border border-border-subtle'
                    : 'text-text-secondary hover:bg-bg-surface'
                }`}
                onClick={() => onSelectConversation(conv)}
              >
                <MessageSquare size={13} className="flex-shrink-0 opacity-50" />
                <span className="flex-1 truncate">{conv.title}</span>
                {conv.preset && (
                  <span className="flex-shrink-0 text-[9px] text-text-muted uppercase">{conv.preset}</span>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); onDeleteConversation(conv.id); }}
                  className="flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-100 text-text-muted hover:text-error"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-border-subtle p-3">
        <div className="flex items-center gap-2 text-[10px] text-text-muted">
          <Compass size={12} className="text-accent" />
          <span>Fieldwork v1.0 — Research Intelligence</span>
        </div>
      </div>
    </aside>
  );
}

function PresetItem({ preset, selected, onSelect }: { preset: ResearchPreset; selected: boolean; onSelect: (name: string) => void }) {
  return (
    <button
      onClick={() => onSelect(preset.name)}
      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
        selected
          ? 'bg-accent-subtle text-accent border border-accent/20'
          : 'text-text-secondary hover:bg-bg-surface border border-transparent'
      }`}
      title={preset.description}
    >
      <SearchIcon size={11} className="flex-shrink-0 opacity-60" />
      <span className="flex-1 truncate">{preset.name.replace(/-/g, ' ')}</span>
    </button>
  );
}
