import type { LedgerClaim, LedgerVerdict } from '../lib/claimLedger';

/** Two verdicts, two colours: what holds, what is only asserted, and what the sources fight over. */
const TONE: Record<LedgerVerdict, string> = {
  established: 'border-olive/30 bg-olive-subtle text-olive',
  claimed: 'border-warning/30 bg-warning-subtle text-warning',
  contested: 'border-error/30 bg-error-subtle text-error',
};

/**
 * The CLAIM LEDGER as a table. The ledger is the part of an answer a researcher scans rather than
 * reads, so it gets columns and a status chip instead of the bullet list the prompt asks for.
 */
export function ClaimLedgerTable({ claims }: { claims: LedgerClaim[] }) {
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
          {claims.map((row, index) => (
            <tr key={`${row.citation ?? 'claim'}:${index}`} className="border-t border-border-subtle align-top">
              <td className="px-2 py-1.5 leading-snug text-text-secondary">
                {row.citation && <span className="mr-1.5 font-mono text-text-muted">{row.citation}</span>}
                {row.claim}
              </td>
              <td className="px-2 py-1.5">
                {row.verdict ? (
                  <span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] ${TONE[row.verdict]}`}>
                    {row.verdict}
                  </span>
                ) : (
                  <span className="text-text-muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
