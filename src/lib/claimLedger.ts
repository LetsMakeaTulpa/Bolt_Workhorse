/**
 * Parses the CLAIM LEDGER section into rows so it can be drawn as a table.
 *
 * The prompt asks for bullets — `- [n] claim — established | claimed | contested` — but a model
 * reads that trailing pipe as a column separator often enough that the section arrives as a
 * pipe-delimited list, a real GFM table, or bullets with an em dash. ReactMarkdown renders the last
 * two as raw text or an unstyled grid, so the section is parsed here and rendered deliberately.
 *
 * The section is only lifted out when at least one row parses: an answer that merely mentions
 * "claim ledger" in prose keeps its text, the same rule `splitFollowUps` follows.
 */

export type LedgerVerdict = 'established' | 'claimed' | 'contested';

export interface LedgerClaim {
  /** the citation marker as written (`[3]`), or null when the line has none */
  citation: string | null;
  claim: string;
  /** null when the row carries no recognised verdict, so it is shown without a badge */
  verdict: LedgerVerdict | null;
}

export interface ParsedLedger {
  /** the answer with the ledger section removed */
  body: string;
  claims: LedgerClaim[];
}

// the closing bold can sit before or after the colon: `**CLAIM LEDGER**` and `**CLAIM LEDGER:**`
const HEADING = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*claim\s+ledger\s*:?\s*(?:\*\*|__)?\s*$/i;
/** a following section, so the ledger stops where the answer does */
const NEXT_HEADING = /^\s*(?:#{1,6}\s+\S|\*\*[^*]+\*\*\s*$|(?:follow[\s-]?ups?|sources|references)\b\s*:?\s*$)/i;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;
const VERDICT = /^(established|claimed|contested)\b[\s.!]*$/i;
const CITATION = /^\[(\d{1,3})]/;
/** `|---|:--|` and bare rule rows are separators, not claims */
const SEPARATOR = /^\s*\|?[\s:|-]+\|?\s*$/;
/** the table's own header cells, which are not a claim */
const HEADER_CELLS = /^(?:claims?|statements?|status|verdict|state|basis)s?$/i;

function tidy(text: string): string {
  return text
    .replace(/\*\*|__/g, '')
    .replace(/^[`"']+|[`"']+$/g, '')
    .trim();
}

function withCitation(text: string): { citation: string | null; claim: string } {
  const match = text.match(CITATION);
  if (!match) return { citation: null, claim: text };
  return { citation: `[${match[1]}]`, claim: text.slice(match[0].length).trim() };
}

function rowFrom(line: string): LedgerClaim | null {
  let text = line.trim();
  if (!text || SEPARATOR.test(text)) return null;
  text = text.replace(BULLET, '').trim();
  if (!text) return null;

  // a pipe row: `| [1] claim | established |`, `[1] claim | established`
  const cells = text
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => tidy(cell))
    .filter(Boolean);
  if (cells.length >= 2) {
    if (HEADER_CELLS.test(cells[0]) && HEADER_CELLS.test(cells[cells.length - 1])) return null;
    const tail = cells[cells.length - 1];
    const verdict = VERDICT.test(tail) ? (tail.toLowerCase().match(VERDICT)![1] as LedgerVerdict) : null;
    const claim = (verdict ? cells.slice(0, -1) : cells).join(' — ');
    const { citation, claim: bare } = withCitation(claim);
    return bare.length >= 3 ? { citation, claim: bare, verdict } : null;
  }

  // a bullet: `- [1] claim — established`, with an em dash, en dash or spaced hyphen. Greedy on the
  // left, because the verdict is the last field: `Latency — not throughput — is the constraint —
  // contested` must split at its final dash, not its first.
  const split = text.match(/^(.+)\s+[—–]\s+(.+)$/) ?? text.match(/^(.+)\s+-\s+(.+)$/);
  // the verdict is tidied first: a bullet whose whole line is bold ends in `Established.**`
  const verdictText = split ? tidy(split[2]) : '';
  if (split && VERDICT.test(verdictText)) {
    const { citation, claim } = withCitation(tidy(split[1]));
    const verdict = verdictText.toLowerCase().match(VERDICT)![1] as LedgerVerdict;
    return claim.length >= 3 ? { citation, claim, verdict } : null;
  }

  const { citation, claim } = withCitation(tidy(text));
  return claim.length >= 3 ? { citation, claim, verdict: null } : null;
}

export function splitClaimLedger(content: string): ParsedLedger {
  const lines = content.split(/\r?\n/);
  const heading = lines.findIndex((line) => HEADING.test(line));
  if (heading < 0) return { body: content.trim(), claims: [] };

  const section: string[] = [];
  for (const line of lines.slice(heading + 1)) {
    if (NEXT_HEADING.test(line)) break;
    section.push(line);
  }

  const claims: LedgerClaim[] = [];
  for (const line of section) {
    const row = rowFrom(line);
    if (row) claims.push(row);
  }
  if (claims.length === 0) return { body: content.trim(), claims: [] };

  return { body: lines.slice(0, heading).join('\n').trim(), claims: claims.slice(0, 8) };
}
