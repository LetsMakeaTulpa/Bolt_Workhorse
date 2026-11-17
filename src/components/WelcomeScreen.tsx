import { Compass, Archive, Clock, EyeOff, FileSearch } from 'lucide-react';

interface WelcomeScreenProps {
  onSendMessage: (content: string) => void;
}

/**
 * The first thing the app says when there is no conversation yet: an invitation to ask. The search
 * engines, dorks and source panel are what the answers are built on, not what the page is.
 */
const EXAMPLES = [
  {
    icon: Clock,
    label: 'Live',
    prompt: 'What changed in the EU AI Act enforcement this week?',
  },
  {
    icon: Archive,
    label: 'Archived',
    prompt: 'What vanished when GeoCities shut down, and what is still archived?',
  },
  {
    icon: EyeOff,
    label: 'Obscure',
    prompt: 'Which 1990s BBS archives still exist for early cryptography discussion?',
  },
  {
    icon: FileSearch,
    label: 'Literature',
    prompt: 'Find retracted papers in my field from the last two years and why they were pulled',
  },
];

export function WelcomeScreen({ onSendMessage }: WelcomeScreenProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 animate-fade-in">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-accent-hover glow-accent">
        <Compass size={24} className="text-bg-base" />
      </div>

      <h1 className="mb-1 text-2xl font-bold tracking-tight text-text-primary">Ask. Then ask again.</h1>
      <p className="mb-7 max-w-md text-center text-sm text-text-secondary">
        A research chat: the answer streams in, the web is searched behind it, and the top pages are
        read in full when a snippet is not enough. Follow up on any answer without repeating yourself.
      </p>

      <div className="grid w-full max-w-2xl grid-cols-1 gap-2 sm:grid-cols-2">
        {EXAMPLES.map((example, i) => {
          const Icon = example.icon;
          return (
            <button
              key={example.label}
              onClick={() => onSendMessage(example.prompt)}
              className="group flex items-start gap-2.5 rounded-xl border border-border-subtle bg-bg-surface p-3 text-left transition-all hover:border-accent/25 hover:bg-bg-elevated animate-slide-up"
              style={{ animationDelay: `${i * 0.06}s` }}
            >
              <span className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-bg-elevated text-olive transition-colors group-hover:bg-olive-subtle">
                <Icon size={13} />
              </span>
              <span className="min-w-0">
                <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                  {example.label}
                </span>
                <span className="block text-[11px] leading-snug text-text-secondary line-clamp-2">
                  {example.prompt}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <p className="mt-6 text-[11px] text-text-muted">
        Press <span className="font-mono text-text-secondary">/</span> to type · every answer keeps its sources, and you can ask a follow-up on any of them
      </p>
    </div>
  );
}
