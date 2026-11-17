import { AlertTriangle, X } from 'lucide-react';

/**
 * What the answer was actually produced by, when that is not what was asked for.
 *
 * The activity log already records a fallback or a provider serving a different model, but the log
 * is a panel people collapse and a tab they rarely open — so the one fact that changes how the
 * answer should be read was invisible where the answer is. This is that fact, above the transcript.
 */
export interface ModelNotice {
  /** fallback: our chain moved on; served: the provider ran something else */
  kind: 'fallback' | 'served';
  /** the model that was requested */
  from: string;
  /** the model that actually answered */
  to: string;
  /** why the switch happened, when the caller knows */
  reason?: string;
}

export function ModelNoticeBanner({ notice, onDismiss }: { notice: ModelNotice; onDismiss?: () => void }) {
  const title =
    notice.kind === 'served'
      ? `Provider answered as ${notice.to}, not ${notice.from} — this answer came from ${notice.to}`
      : `${notice.from} unavailable — answered on ${notice.to}`;
  const detail =
    notice.kind === 'served'
      ? '"This answer is attributed to the model that actually produced it, not the one selected."'
      : notice.reason
        ? `Reason: ${notice.reason}`
        : '';

  return (
    <div
      role="status"
      aria-live="polite"
      title={title}
      className="flex items-start gap-2 border-b border-warning/30 bg-warning-subtle px-6 py-2 text-[11px] text-warning"
    >
      <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{title}</p>
        {detail && <p className="mt-0.5 truncate text-[10px] opacity-80">{detail}</p>}
      </div>
      <button
        type="button"
        onClick={() => onDismiss?.()}
        disabled={!onDismiss}
        aria-label="Dismiss model notice"
        title="Dismiss model notice"
        className="flex-shrink-0 rounded p-0.5 transition-colors hover:bg-warning/20 disabled:cursor-not-allowed disabled:opacity-30"
      >
        <X size={12} />
      </button>
    </div>
  );
}
