import { ShieldAlert } from 'lucide-react';
import type { LedgerClaim, LedgerVerdict } from '../lib/claimLedger';
import { contradicts, type ClaimAudit } from '../lib/claimAudit';

/** Two verdicts, two colours: what holds, what is only asserted, and what the sources fight over. */
const TONE: Record<LedgerVerdict, string> = {
  established: 'border-olive/30 bg-olive-subtle text-olive',
  claimed: 'border-warning/30 bg-warning-subtle text-warning',
  contested: 'border-error/30 bg-error-subtle text-error',
};

/**
 * The CLAIM LEDGER as a table. The ledger is the part of an answer a researcher scans rather than
 * reads, so it gets columns and a status chip instead of the bullet list the prompt asks for.
 *
 * The chip is the model's word, except where the audit contradicts it: an established row whose
 * figure is in no cited page is the answer's own verdict failing the answer's own evidence, so it
 * reads `unconfirmed` with the missing figure named beneath it. `claimed` and `contested` rows keep
 * their chip — they never promised the check had been made.
 */
export function ClaimLedgerTable({ claims, audits = [] }: { claims: LedgerClaim[]; audits?: ClaimAudit[] }) {
  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-border-subtle">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="bg-bg-elevated text-left text-[10px] uppercase tracking-wider text-text-muted">
            <th className="px-2 py-1.5 font-medium">Claim</th>
            <th className="w-24 px-2 py-1.5 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {claims.map((row, index) => {
            const audit = audits[index];
            const unsettled = row.verdict === 'established' && contradicts(audit);
            return (
              <tr key={`${row.citation ?? 'claim'}:${index}`} className="border-t border-border-subtle align-top">
                <td className="px-2 py-1.5 leading-snug text-text-secondary">
                  {row.citation && <span className="mr-1.5 font-mono text-text-muted">{row.citation}</span>}
                  {row.claim}
                  {unsettled && (
                    <div className="mt-0.5 flex items-start gap-1 text-[10px] text-warning">
                      <ShieldAlert size={9} className="mt-0.5 flex-shrink-0" />
                      <span>{audit.note}</span>
                    </div>
                  )}
                </td>
                <td className="px-2 py-1.5">
                  {row.verdict ? (
                    unsettled ? (
                      <span
                        title={`The model marked this established, but ${audit.note} — its own sources do not settle it`}
                        className="inline-block rounded border border-warning/30 bg-warning-subtle px-1.5 py-0.5 text-[10px] text-warning"
                      >
                        unconfirmed
                      </span>
                    ) : (
                      <span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] ${TONE[row.verdict]}`}>
                        {row.verdict}
                      </span>
                    )
                  ) : (
                    <span className="text-text-muted">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
