// The ledger's own verdict, checked against the ledger's own evidence.
//
// Grounding never saw the claim table: the ledger is lifted out of the answer before sentences are
// audited. A figure the prose audit would flag could therefore be repeated as an `established` row
// and read as settled. These checks pin the join — the figure must be in the page the row cites, and
// a row the audit contradicts must stop reading `established`.
// Run: node experiments/claim-audit.test.mjs (builds both modules itself)
import { asUrl, bundle, tmpPath } from './lib/build.mjs';

const AUDIT = process.env.CLAIM_AUDIT_MODULE ?? tmpPath('claim-audit.mjs');
const BUBBLE = process.env.CLAIM_AUDIT_BUBBLE ?? tmpPath('claim-audit-bubble.mjs');
if (!process.env.CLAIM_AUDIT_MODULE) bundle('src/lib/claimAudit.ts', AUDIT);
if (!process.env.CLAIM_AUDIT_BUBBLE) {
  bundle('src/components/MessageBubble.tsx', BUBBLE, [
    '--jsx=automatic',
    '--external:react',
    '--external:react-dom',
    '--alias:decode-named-character-reference=./node_modules/decode-named-character-reference/index.js',
  ]);
}

const { auditClaims, contradicts } = await import(asUrl(AUDIT));
const { MessageBubble } = await import(asUrl(BUBBLE));
const React = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const page = (citation, text, extra = {}) => ({
  citation_id: citation,
  title: `Source ${citation}`,
  url: `https://a.test/${citation.replace(/\D/g, '')}`,
  snippet: 'snippet',
  content: text,
  ...extra,
});
const claim = (text, verdict, citation = '[1]') => ({ citation, claim: text, verdict });
const only = (claims, sources, question = '') => auditClaims(claims, sources, question)[0];

// ── 1. the figure has to be in the page the row cites ─────────────────────
{
  const sources = [page('[1]', 'Throughput rose to 12% after the change.')];
  const audit = only([claim('Throughput rose 47%', 'established')], sources);
  check('an established figure in no cited page is flagged', audit.status === 'unsupported', audit.status);
  check('the missing figure is named', audit.missing.join(',') === '47%', JSON.stringify(audit.missing));
  check('the note says where it looked', /47% not found in \[1\]/.test(audit.note), audit.note);
  check('it overturns the settled verdict', contradicts(audit) === true);

  const supported = only([claim('Throughput rose 12%', 'established')], sources);
  check('a figure the page does contain stands', supported.status === 'supported', supported.status);
  check('and keeps the settled verdict', contradicts(supported) === false);
}

// ── 2. names are checked the same way ─────────────────────────────────────
{
  const sources = [page('[1]', 'The change was reported by Rebecca Smith.')];
  const missingName = only([claim('Rebecca Jones measured 12%', 'established')], sources);
  check(
    'a name in no cited page is flagged',
    missingName.missing.some((token) => /Jones/.test(token)),
    JSON.stringify(missingName.missing),
  );
  const asked = only(
    [claim('Rebecca Smith reported a 12% rise', 'established')],
    [page('[1]', 'The change was reported by Rebecca Smith: a 12% rise.')],
    'what did Rebecca Smith report?',
  );
  check('a name the question supplied is not a new claim', asked.status === 'supported', asked.status);
}

// ── 3. a citation that does not exist, or no citation at all ───────────────
{
  const sources = [page('[1]', 'Throughput rose to 12%.')];
  const unknown = only([claim('Throughput rose 47%', 'established', '[9]')], sources);
  check('a row citing a source this answer lacks is flagged', unknown.status === 'unknown-citation', unknown.status);
  check('the invented id is named', /\[9\]/.test(unknown.note), unknown.note);

  const uncited = only([claim('Throughput rose 47%', 'established', null)], sources);
  check('a figure with no citation is flagged', uncited.status === 'no-citation', uncited.status);
  check('the note says it has no source', /no citation/.test(uncited.note), uncited.note);
}

// ── 4. a snippet is not a contradiction ───────────────────────────────────
{
  const sources = [{ citation_id: '[1]', title: 'Source', url: 'https://a.test/1', snippet: 'Throughput rose…' }];
  const audit = only([claim('Throughput rose 47%', 'established')], sources);
  check('a snippet-only source makes the row unchecked, not wrong', audit.status === 'unchecked', audit.status);
  check('an unchecked row does not overturn the verdict', contradicts(audit) === false);
}

// ── 5. the audit reads the prompt, not the panel ──────────────────────────
{
  const sources = [page('[1]', 'Throughput rose to 12%.', { in_prompt: false, prompt_reason: 'capped' })];
  const audit = only([claim('Throughput rose 47%', 'established')], sources);
  check('a page the prompt never carried cannot confirm a claim', audit.status === 'unchecked', audit.status);

  const trimmed = [page('[1]', 'Intro. Throughput rose to 12%.', { in_prompt: true, prompt_chars: 8 })];
  check(
    'a figure past the prompt cut is not in what the model read',
    only([claim('Throughput rose 12%', 'established')], trimmed).status === 'unsupported',
  );
}

// ── 6. framing statements are not checkable claims ────────────────────────
{
  const sources = [page('[1]', 'Throughput rose to 12%.')];
  const framing = only([claim('The picture is mixed', 'established')], sources);
  check('a row with no figure or name is not flagged', framing.status === 'nothing-to-check', framing.status);
  check('and gets no note', framing.note === '');
  check('every row is audited, in order', auditClaims([claim('A 47% rise', 'claimed'), claim('A 12% rise', 'established')], sources).length === 2);
}

// ── 7. the table stops printing it as settled ─────────────────────────────
{
  const sources = [page('[1]', 'Throughput rose to 12% after the change.')];
  const message = (ledger) => ({
    id: 'm1',
    conversation_id: 'c1',
    role: 'assistant',
    content: `Throughput rose [1].\n\nCLAIM LEDGER\n${ledger}`,
    model: 'Qwen/Qwen2.5-7B-Instruct',
    search_enabled: true,
    search_results: sources,
    created_at: '2026-11-18T00:00:00Z',
  });
  const html = (ledger) =>
    renderToStaticMarkup(
      React.createElement(MessageBubble, { message: message(ledger), isStreaming: false, query: 'did throughput rise' }),
    );
  const text = (markup) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  const flagged = html('- [1] Throughput rose 47% — established');
  check('the contradicted row no longer reads established', !/>\s*established\s*</.test(flagged));
  check('it reads unconfirmed', /unconfirmed/.test(text(flagged)));
  check('the missing figure is named under the claim', /47% not found in \[1\]/.test(text(flagged)));
  check('the title still records what the model claimed', /marked this established/.test(flagged));

  const supported = html('- [1] Throughput rose 12% — established');
  check('a supported row keeps its settled chip', /established/.test(text(supported)) && !/unconfirmed/.test(text(supported)));

  const claimed = html('- [1] Throughput rose 47% — claimed');
  check('a row that never claimed to be settled is left alone', /claimed/.test(text(claimed)) && !/unconfirmed/.test(text(claimed)));
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
