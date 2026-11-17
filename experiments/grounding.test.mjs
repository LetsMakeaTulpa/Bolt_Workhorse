// The anti-fabrication promise applied to the answer itself: a citation that does not exist, and a
// figure or name that is in no cited page, are the two ways an answer can look sourced while not
// being sourced. The check must catch both without turning ordinary prose into warnings.
// Run: node experiments/grounding.test.mjs (builds both modules itself)
import { asUrl, bundle, tmpPath } from './lib/build.mjs';

const LIB = process.env.GROUNDING_MODULE ?? tmpPath('grounding.mjs');
const BUBBLE = process.env.BUBBLE_MODULE ?? tmpPath('grounding-bubble.mjs');
if (!process.env.GROUNDING_MODULE) bundle('src/lib/grounding.ts', LIB);
if (!process.env.BUBBLE_MODULE) {
  bundle('src/components/MessageBubble.tsx', BUBBLE, [
    '--jsx=automatic',
    '--external:react',
    '--external:react-dom',
    '--alias:decode-named-character-reference=./node_modules/decode-named-character-reference/index.js',
  ]);
}

const { checkGrounding, citationIds, figures, names, splitSentences } = await import(asUrl(LIB));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const page = (citation, text) => ({ citation_id: citation, title: `Source ${citation}`, url: `https://a.test/${citation}`, snippet: 'snippet', content: text });

// ── 1. finding the claims in the prose ──────────────────────────────────────
{
  check('sentences split on full stops', splitSentences('One claim. Two claim. Three.').length === 3);
  check('an abbreviation does not end a sentence', splitSentences('The nDCG was 0.42, e.g. in Table 2 [1].').length === 1);
  check('a fenced code block is not a claim', !splitSentences('Text here.\n```\nnDCG = 0.42\n```\n').join(' ').includes('nDCG = 0.42'));
  check('a heading is not a claim', !splitSentences('## Results of 2024\n\nThe score was 0.42 [1].').join(' ').includes('Results of 2024'));

  check('citation IDs are read without brackets', citationIds('A [1] and B [2] and a repeat [1].').join(',') === '1,2');
  check('single digits are not figures', figures('The three studies, 1 of 2 [1].').length === 0, JSON.stringify(figures('The three studies, 1 of 2 [1].')));
  check('decimals, percentages and years are figures', figures('0.42, 12%, 2024').length === 3, JSON.stringify(figures('0.42, 12%, 2024')));
  check('a name is a capitalised sequence', names('The study by Rebecca Smith reports this.').join('|') === 'Rebecca Smith');
  check('the first word of a sentence is not a name', names('Results are consistent.').length === 0);
  check('a name in the question is not a claim', names('Rebecca Smith reports this.', 'what does Rebecca Smith report?').length === 0);
  check('an acronym is specific enough', names('It uses the ACM dataset.').includes('ACM'));
}

// ── 2. citation IDs must exist ──────────────────────────────────────────────
{
  const sources = [page('[1]', 'The benchmark reports an nDCG of 0.42 on the test split.')];
  const report = checkGrounding('The benchmark reports nDCG 0.42 [1]. A later paper confirms it [7].', sources);
  const flagged = report.sentences.find((s) => s.text.includes('later paper'));
  check('a citation no source provides is flagged', flagged?.status === 'unknown-citation', flagged?.status);
  check('the invented ID is named', flagged?.missing.join() === '[7]', JSON.stringify(flagged?.missing));
  check('it is also reported at answer level', report.unknownCitations.join() === '7');
  check('the summary says what is wrong', /no source provides \(\[7\]\)/.test(report.summary), report.summary);
}

// ── 3. figures and names have to be in the cited page ──────────────────────
{
  const sources = [
    page('[1]', 'On the test split nDCG reached 0.42 and recall reached 0.71, as Rebecca Smith reports.'),
    page('[2]', 'A second paper agrees about the effect size but gives no numbers.'),
  ];
  const report = checkGrounding(
    'nDCG was 0.42 [1]. Recall was 0.91 [1]. Rebecca Smith reports the effect [1]. The effect is real [2].',
    sources,
  );
  const find = (fragment) => report.sentences.find((s) => s.text.includes(fragment));

  check('a figure that is in the page is grounded', find('nDCG was 0.42')?.status === 'grounded', find('nDCG was 0.42')?.status);
  check('a figure that is not in the page is flagged', find('Recall was 0.91')?.status === 'unsupported');
  check('and the missing figure is named', find('Recall was 0.91')?.missing.join() === '0.91');
  check('a name in the page is grounded', find('Rebecca Smith reports')?.status === 'grounded');
  check('a sentence with no figures or names is not flagged', find('The effect is real')?.status === 'unchecked');
  check('grounded sentences are counted', report.grounded === 2, String(report.grounded));
  check('only checkable sentences are counted', report.checked === 3, String(report.checked));
  check('everything found reads as a clean bill', /^All 2 checked sentences match their sources$/.test(checkGrounding('nDCG was 0.42 [1].', sources).summary), checkGrounding('nDCG was 0.42 [1].', sources).summary);
}

// ── 4. a name that is in no cited page ─────────────────────────────────────
{
  const sources = [page('[1]', 'The benchmark reports 0.42 on the test split.')];
  const report = checkGrounding('The improvement, according to Rebecca Smith, is large [1].', sources);
  check('an unknown name is flagged', report.flagged.length === 1, JSON.stringify(report.flagged.map((s) => s.status)));
  check('the missing name is named', report.flagged[0]?.missing.includes('Rebecca Smith'), JSON.stringify(report.flagged[0]?.missing));
}

// ── 5. an uncited figure is an assertion without a source ──────────────────
{
  const report = checkGrounding('Usage grew 47% last year.', [page('[1]', 'Nothing relevant.')]);
  check('a figure with no citation is flagged', report.flagged.length === 1 && report.flagged[0].status === 'unsupported');
  check('and says what it could not find', report.flagged[0].missing.join() === '47%', JSON.stringify(report.flagged[0].missing));
  check('prose with no figures or names is left alone', checkGrounding('This matters for the field.', [page('[1]', 'x')]).flagged.length === 0);
}

// ── 6. snippet-only sources are uncheckable, not wrong ────────────────────
{
  const sources = [{ citation_id: '[1]', title: 'Snippet only', url: 'https://a.test/s', snippet: 'Reports 0.42.' }];
  const report = checkGrounding('The score was 0.42 [1].', sources);
  check('a snippet-only source cannot fail the answer', report.flagged.length === 0, JSON.stringify(report.flagged));
  check('but it is reported as unchecked', report.unchecked.length === 1 && report.unchecked[0].status === 'no-page-text');
  check('the summary says so plainly', /could not be checked/.test(report.summary), report.summary);
}

// ── 7. the strip in the bubble ────────────────────────────────────────────
{
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { MessageBubble } = await import(asUrl(BUBBLE));

  const message = (content, searchResults) => ({
    id: 'm1',
    conversation_id: 'c1',
    role: 'assistant',
    content,
    model: 'Qwen/Qwen2.5-7B-Instruct',
    search_enabled: true,
    search_results: searchResults,
    created_at: new Date().toISOString(),
  });

  const flaggedHtml = renderToStaticMarkup(
    React.createElement(MessageBubble, {
      message: message('nDCG was 0.42 [1]. Recall was 0.91 [1]. See also [7].', [page('[1]', 'The benchmark reports an nDCG of 0.42.')]),
      isStreaming: false,
      query: 'what is the nDCG',
    }),
  );
  check('the bubble shows a grounding line', flaggedHtml.includes('Grounding:'), flaggedHtml.slice(0, 0));
  check('the missing figure is named in the summary', flaggedHtml.includes('0.91'));
  check('the invented citation is named in the summary', flaggedHtml.includes('[7]'));

  const cleanHtml = renderToStaticMarkup(
    React.createElement(MessageBubble, {
      message: message('The benchmark reports nDCG 0.42 [1].', [page('[1]', 'The benchmark reports an nDCG of 0.42.')]),
      isStreaming: false,
      query: 'what is the nDCG',
    }),
  );
  check('a grounded answer reads as a clean bill', /All 1 checked sentence match(es)? their sources/.test(cleanHtml));

  const quietHtml = renderToStaticMarkup(
    React.createElement(MessageBubble, {
      message: message('This matters for the field.', []),
      isStreaming: false,
      query: 'why',
    }),
  );
  check('an answer with nothing checkable shows no strip at all', !quietHtml.includes('Grounding:'));
}

const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) process.exit(1);
