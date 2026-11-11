import { Compass, Globe, BookOpen, Zap, Shield, GitBranch, Map, FileSearch, Microscope, Archive } from 'lucide-react';

interface WelcomeScreenProps {
  onSendMessage: (content: string) => void;
}

const SUGGESTED_PROMPTS = [
  {
    icon: BookOpen,
    title: 'Historical Research',
    prompt: 'What happened to the cemeteries in San Francisco during the early twentieth century?',
  },
  {
    icon: Microscope,
    title: 'Academic Investigation',
    prompt: 'What are the latest developments in quantum error correction research?',
  },
  {
    icon: GitBranch,
    title: 'Technical Discovery',
    prompt: 'Find the best open-source tools for building AI agent systems in 2026',
  },
  {
    icon: Shield,
    title: 'Fact Verification',
    prompt: 'Verify the claim that lithium-ion battery recycling has reached 95% efficiency',
  },
  {
    icon: Map,
    title: 'Map Relationships',
    prompt: 'Map the relationships between major AI model providers and their training data sources',
  },
  {
    icon: FileSearch,
    title: 'Deep Investigation',
    prompt: 'Investigate the current state of nuclear fusion energy development across multiple companies',
  },
];

export function WelcomeScreen({ onSendMessage }: WelcomeScreenProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 animate-fade-in">
      <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-accent-hover glow-accent">
        <Compass size={28} className="text-bg-base" />
      </div>

      <h1 className="mb-1.5 text-2xl font-bold text-text-primary tracking-tight">Fieldwork</h1>
      <p className="mb-1 text-center text-sm text-text-secondary max-w-md">
        Conversational research and intelligence workstation
      </p>
      <p className="mb-6 text-xs text-text-muted">
        Ask. Investigate. Understand. Preserve.
      </p>

      <div className="grid w-full max-w-2xl grid-cols-1 gap-2.5 sm:grid-cols-2">
        {SUGGESTED_PROMPTS.map((prompt, i) => {
          const Icon = prompt.icon;
          return (
            <button
              key={i}
              onClick={() => onSendMessage(prompt.prompt)}
              className="group flex items-start gap-3 rounded-lg border border-border-subtle bg-bg-surface p-3.5 text-left transition-all hover:border-accent/25 hover:bg-bg-elevated animate-slide-up"
              style={{ animationDelay: `${i * 0.08}s` }}
            >
              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-bg-elevated text-olive transition-colors group-hover:bg-olive-subtle">
                <Icon size={16} />
              </div>
              <div>
                <div className="text-xs font-medium text-text-primary mb-0.5">{prompt.title}</div>
                <div className="text-[11px] text-text-muted line-clamp-2">{prompt.prompt}</div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-6 flex items-center gap-1.5 text-[11px] text-text-muted">
        <Globe size={11} className="text-olive" />
        <span>Multi-engine search with semantic query compilation and reciprocal rank fusion</span>
      </div>
    </div>
  );
}
