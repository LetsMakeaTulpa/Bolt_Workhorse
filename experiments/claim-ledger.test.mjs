// The claim ledger is lifted out of an answer and drawn as a table. A parser that drifts either
// loses the rows or eats the prose above them, and neither is visible until someone reads carefully
// — which is the one thing a reader doing research will not do. Every shape a model actually sends
// is pinned here: bullets with an em dash, bullets ending in a pipe, a real GFM table, decorations,
// a missing citation, an unknown verdict, and the section boundary.
import { asUrl, tmpPath, ESBUILD } from './lib/build.mjs';
import { execFileSync } from 'node:child_process';

const OUT = tmpPath('fieldwork-claim-ledger.mjs');
execFileSync(
  process.execPath,
  [ESBUILD, 'src/lib/claimLedger.ts', '--bundle', '--format=esm', `--outfile=${OUT}`, '--log-level=error'],
  { stdio: 'inherit' },
);
const { splitClaimLedger } = await import(`${asUrl(OUT)}?t=${Date.now()}`);

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const show = (claims) => JSON.stringify(claims);

// ── 1. the shape the prompt asks for ──────────────────────────────────────────
const bullets = splitClaimLedger(
  'Error rates fall with distance [1].\n\nCLAIM LEDGER\n- [1] Error rates fall with distance — established\n- [2] The 2025 roadmap slipped — claimed',
);
check('strips the section from the body', bullets.body === 'Error rates fall with distance [1].', JSON.stringify(bullets.body));
check('keeps every row', bullets.claims.length === 2, String(bullets.claims.length));
check(
  'reads citation, claim and verdict',
  bullets.claims[0].citation === '[1]' && bullets.claims[0].claim === 'Error rates fall with distance' && bullets.claims[0].verdict === 'established',
  show(bullets.claims[0]),
);
check('reads the second verdict', bullets.claims[1].verdict === 'claimed', show(bullets.claims[1]));

// ── 2. a model that reads the trailing pipe as a column separator ────────────
const pipeBullet = splitClaimLedger('Answer.\n\nCLAIM LEDGER\n- [4] Vendor claims 99% uptime | contested');
check(
  'a pipe-delimited bullet still yields a verdict',
  pipeBullet.claims[0]?.verdict === 'contested' && pipeBullet.claims[0]?.citation === '[4]',
  show(pipeBullet.claims[0]),
);
check('the pipe is not left in the claim text', pipeBullet.claims[0]?.claim === 'Vendor claims 99% uptime', show(pipeBullet.claims[0]));

// ── 3. a real GFM table, header and separator included ───────────────────────
const table = splitClaimLedger(
  'Answer.\n\nCLAIM LEDGER\n| Claim | Status |\n| --- | :-- |\n| [5] Surface code thresholds beat 1% | established |\n| [6] Vendors disagree on the margin | contested |',
);
check('a GFM table is read as rows', table.claims.length === 2, show(table.claims));
check('the header row is not a claim', !table.claims.some((row) => /^Claim$/.test(row.claim)), show(table.claims));
check(
  'a table row keeps its citation and verdict',
  table.claims[0].citation === '[5]' && table.claims[0].verdict === 'established',
  show(table.claims[0]),
);
check('the separator row is skipped', !table.claims.some((row) => /^-+$|:\-/.test(row.claim)), show(table.claims));

// ── 4. the decorations models add ───────────────────────────────────────────
const decorated = splitClaimLedger('Answer.\n\n## **CLAIM LEDGER:**\n* **[1] A decorated claim — Established.**');
check(
  'a decorated heading and bullet are still the ledger',
  decorated.claims.length === 1 && decorated.claims[0].verdict === 'established',
  show(decorated.claims),
);
check('markdown around the claim is removed', decorated.claims[0]?.claim === 'A decorated claim', show(decorated.claims[0]));

const spaced = splitClaimLedger('Answer.\n\nCLAIM LEDGER\n- [2] A hyphen verdict - claimed');
check('a spaced hyphen is a verdict separator', spaced.claims[0]?.verdict === 'claimed', show(spaced.claims[0]));

// ── 5. rows that are not complete ───────────────────────────────────────────
const noCitation = splitClaimLedger('Answer.\n\nCLAIM LEDGER\n- A claim with no marker — established');
check(
  'a claim without a citation keeps a null citation',
  noCitation.claims[0]?.citation === null && noCitation.claims[0]?.verdict === 'established',
  show(noCitation.claims[0]),
);

const unknownVerdict = splitClaimLedger('Answer.\n\nCLAIM LEDGER\n- [7] Something unproven — plausible');
check(
  'an unrecognised verdict is not invented',
  unknownVerdict.claims[0]?.verdict === null && unknownVerdict.claims[0]?.claim === 'Something unproven — plausible',
  show(unknownVerdict.claims[0]),
);

// a claim can contain the dash the parser splits on; the verdict is the last field, not the first
const dashed = splitClaimLedger('Answer.\n\nCLAIM LEDGER\n- [2] Latency — not throughput — is the constraint — contested');
check(
  'a claim containing an em dash keeps its verdict',
  dashed.claims[0]?.verdict === 'contested' && dashed.claims[0]?.claim === 'Latency — not throughput — is the constraint',
  show(dashed.claims[0]),
);

// ── 6. the section boundary: the ledger must not swallow the rest of the post ─
const bounded = splitClaimLedger(
  'Answer.\n\nCLAIM LEDGER\n- [1] A real claim here — established\n\nFOLLOW-UPS\n- Which source disagrees?',
);
check('the ledger stops at the next heading', bounded.claims.length === 1, show(bounded.claims));
check('a follow-up bullet is not a claim', !bounded.claims.some((row) => /disagrees/.test(row.claim)), show(bounded.claims));

// ── 7. when it must not lift anything ───────────────────────────────────────
const prose = splitClaimLedger('The claim ledger is the useful part of the answer.\n\nWe should keep it.');
check('prose that mentions the ledger is left alone', prose.claims.length === 0 && prose.body.includes('The claim ledger'), JSON.stringify(prose.body));

const noRows = splitClaimLedger('Answer.\n\nCLAIM LEDGER\n\n');
check('an empty section changes nothing', noRows.claims.length === 0 && noRows.body === 'Answer.\n\nCLAIM LEDGER', JSON.stringify(noRows.body));

const crumbs = splitClaimLedger('Answer.\n\nCLAIM LEDGER\n- [1] x');
check('a one-letter claim is not a claim', crumbs.claims.length === 0, show(crumbs.claims));

// ── 8. the shape of the whole post survives ─────────────────────────────────
const crlf = splitClaimLedger('Answer [1].\r\n\r\nCLAIM LEDGER\r\n- [1] A Windows answer — claimed\r\n');
check('CRLF content parses', crlf.claims.length === 1 && crlf.claims[0].verdict === 'claimed', show(crlf.claims));
check('the body keeps its own text', crlf.body === 'Answer [1].', JSON.stringify(crlf.body));

const many = splitClaimLedger(
  `Answer.\n\nCLAIM LEDGER\n${Array.from({ length: 10 }, (_, i) => `- [${i + 1}] Claim number ${i + 1} — established`).join('\n')}`,
);
check('a long ledger is capped at eight rows', many.claims.length === 8, String(many.claims.length));

console.log(`\n${passed}/${passed + failures.length} assertions passed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exit(1);
}
