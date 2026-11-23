/**
 * The claim ledger, checked against the pages it cites.
 *
 * `splitClaimLedger` lifts the ledger out of the answer before grounding runs, so its rows were the
 * one part of a sourced answer that nothing audited: a sentence asserting an uncited figure was
 * flagged, and the same assertion repeated as `- [1] Throughput rose 47% — established` was printed
 * as settled. That is the cheapest contradiction there is — the answer's own verdict against the
 * answer's own evidence — so it is checked here rather than waiting for sources to disagree with
 * each other.
 *
 * It checks the claims the ledger calls established. `claimed` and `contested` already tell the
 * reader to be careful, so a missing figure there is not a contradiction of the ledger's own word.
 * The check is the same one the prose audit makes, through the same citation index and the same
 * figure and name extraction: a row's citation must exist, must have page text, and every figure or
 * name in the row must appear in that page — and only in the part of it the prompt carried.
 */
import type { LedgerClaim } from './claimLedger';
import {
  citationIds,
  figures,
  figurePresent,
  hasPageText,
  indexCitations,
  namePresent,
  names,
  pageTextOf,
  type CitedSource,
} from './grounding';

export type ClaimCheck =
  /** every figure and name in the claim appears in the page it cites */
  | 'supported'
  /** a figure or name is in no cited page — the flag this exists for */
  | 'unsupported'
  /** the cited page came back as a snippet, so nothing could be checked */
  | 'unchecked'
  /** the row cites an id this answer has no source for */
  | 'unknown-citation'
  /** the row asserts a figure with no citation at all */
  | 'no-citation'
  /** no figures or names: a framing statement, not something a page can settle */
  | 'nothing-to-check';

export interface ClaimAudit {
  status: ClaimCheck;
  /** figures and names the cited pages do not contain */
  missing: string[];
  /** citation ids the row points at, without brackets */
  citations: string[];
  /** one line naming what is wrong, empty when nothing is */
  note: string;
}

const bracketed = (ids: string[]): string => ids.map((id) => `[${id}]`).join(' ');

/** Audit every ledger row, in the order the table draws them. */
export function auditClaims(claims: LedgerClaim[], sources: CitedSource[], question = ''): ClaimAudit[] {
  const { byId, withheld } = indexCitations(sources);

  return claims.map((row) => {
    const citations = citationIds(row.citation ?? '');
    const claimedFigures = figures(row.claim);
    const claimedNames = names(row.claim, question);
    const claimed = [...claimedFigures, ...claimedNames];

    if (claimed.length === 0) {
      return { status: 'nothing-to-check' as const, missing: [], citations, note: '' };
    }
    if (citations.length === 0) {
      return {
        status: 'no-citation' as const,
        missing: claimed,
        citations,
        note: `${claimed.join(', ')} with no citation saying where it comes from`,
      };
    }

    const unknown = citations.filter((id) => !byId.has(id) && !withheld.has(id));
    if (unknown.length > 0) {
      return {
        status: 'unknown-citation' as const,
        missing: claimed,
        citations,
        note: `cites ${bracketed(unknown)}, which this answer has no source for`,
      };
    }

    const cited = citations
      .map((id) => byId.get(id))
      .filter((source): source is CitedSource => Boolean(source));
    const pages = cited.filter(hasPageText);
    if (pages.length === 0) {
      return {
        status: 'unchecked' as const,
        missing: [],
        citations,
        note: `${bracketed(citations)} came back as a snippet, not a page — nothing to check`,
      };
    }

    const haystack = pageTextOf(pages);
    const missing = [
      ...claimedFigures.filter((figure) => !figurePresent(figure, haystack)),
      ...claimedNames.filter((name) => !namePresent(name, haystack)),
    ];

    return {
      status: missing.length > 0 ? ('unsupported' as const) : ('supported' as const),
      missing,
      citations,
      note: missing.length > 0 ? `${missing.join(', ')} not found in ${bracketed(citations)}` : '',
    };
  });
}

/**
 * Whether an established row must stop reading as settled.
 *
 * `unchecked` is not a contradiction: the page may hold the figure below where the snippet stopped,
 * and this app does not call that wrong. Only a page that was read and did not contain the claim, or
 * a citation that does not exist, overturns the model's own word.
 */
export const contradicts = (audit: ClaimAudit | undefined): boolean =>
  audit?.status === 'unsupported' || audit?.status === 'unknown-citation' || audit?.status === 'no-citation';
