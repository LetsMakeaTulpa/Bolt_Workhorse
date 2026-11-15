import { KeyRound, Settings2 } from 'lucide-react';
import { engineKeyRow, type KeyState } from '../lib/engineKeyStatus';
import type { EngineIssue } from '../lib/engines';

/**
 * Which of the selected engines can actually answer, shown before the search rather than after.
 * Chips carry the engine's key names in their tooltip; a value is never shown because the browser
 * never receives one.
 */
const TONE: Record<KeyState, string> = {
  ready: 'border-olive/40 bg-olive-subtle text-olive',
  keyless: 'border-border-subtle text-text-muted',
  optional: 'border-border-subtle text-text-muted',
  unknown: 'border-border-subtle text-text-secondary',
  partial: 'border-warning/40 bg-warning-subtle text-warning',
  missing: 'border-warning/40 bg-warning-subtle text-warning',
  rejected: 'border-warning/40 bg-warning-subtle text-warning',
  unused: 'border-accent/40 bg-accent-subtle text-accent',
};

const DOT: Record<KeyState, string> = {
  ready: 'bg-olive',
  keyless: 'bg-text-muted/40',
  optional: 'bg-text-muted/40',
  unknown: 'bg-text-muted/70',
  partial: 'bg-warning',
  missing: 'bg-warning',
  rejected: 'bg-warning',
  unused: 'bg-accent',
};

interface EngineKeyRowProps {
  /** the engines currently selected, in selection order */
  engines: string[];
  /** secret names this account has stored — names only */
  storedKeys: string[];
  /** the last run's status strip: the only evidence about deployment-level secrets */
  issues?: EngineIssue[];
  /** the keys table has not been applied to this project yet */
  unavailable?: boolean;
  onOpenSettings?: () => void;
}

export function EngineKeyRow({ engines, storedKeys, issues = [], unavailable = false, onOpenSettings }: EngineKeyRowProps) {
  const row = engineKeyRow(engines, new Set(storedKeys), issues);
  if (row.length === 0 && !unavailable) return null;

  const needsAttention = row.filter(
    (status) =>
      status.state === 'missing' ||
      status.state === 'partial' ||
      status.state === 'unused' ||
      status.state === 'rejected',
  );

  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-1 text-[10px]">
      <span className="flex items-center gap-1 text-text-muted">
        <KeyRound size={10} />
        Keys
      </span>
      {unavailable && (
        <span
          title="The per-account keys table is not in this project yet. Apply migration 20261115160000_user_engine_keys.sql, or set the keys as function secrets."
          className="flex items-center gap-1 rounded border border-warning/30 bg-warning-subtle px-1.5 py-0.5 text-warning"
        >
          <span className="font-medium">per-account keys</span>
          <span className="opacity-80">table not applied</span>
        </span>
      )}
      {row.map((status) => (
        <span
          key={status.engine}
          title={status.detail}
          className={`flex items-center gap-1 rounded border px-1.5 py-0.5 ${TONE[status.state]}`}
        >
          <span className={`h-1 w-1 rounded-full ${DOT[status.state]}`} />
          <span className="font-medium">{status.label}</span>
          <span className="opacity-80">{status.text}</span>
        </span>
      ))}
      {onOpenSettings && (needsAttention.length > 0 || unavailable) && (
        <button
          type="button"
          onClick={onOpenSettings}
          title="Add or review provider keys"
          className="flex items-center gap-1 rounded border border-border-subtle px-1.5 py-0.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <Settings2 size={10} />
          {needsAttention.length > 0 ? 'add keys' : 'open settings'}
        </button>
      )}
    </div>
  );
}
