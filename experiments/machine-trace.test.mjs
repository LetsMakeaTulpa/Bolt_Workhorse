// The transcript's machine strip: which sources were actually read, and which searches the model
// ran on its own — each one a query the reader can press to run again.
// Run: node experiments/machine-trace.test.mjs (builds both modules itself)
import { asUrl, bundle, tmpPath } from './lib/build.mjs';

const LIB = process.env.MACHINE_TRACE_MODULE ?? tmpPath('machine-trace.mjs');
const BUBBLE = process.env.BUBBLE_MODULE ?? tmpPath('machine-bubble.mjs');
if (!process.env.MACHINE_TRACE_MODULE) bundle('src/lib/machineTrace.ts', LIB);
if (!process.env.BUBBLE_MODULE) {
  bundle('src/components/MessageBubble.tsx', BUBBLE, [
    '--jsx=automatic',
    '--external:react',
    '--external:react-dom',
    '--alias:decode-named-character-reference=./node_modules/decode-named-character-reference/index.js',
  ]);
}

const { readInFull, parseToolSearches, summarizeMachine } = await import(asUrl(LIB));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const source = (citation, title, extra = {}) => ({
  citation_id: citation,
  title,
  url: `https://a.test/${String(citation ?? '').replace(/\D/g, '') || 'anon'}`,
  snippet: `snippet for ${title}`,
  source_engine: 'exa',
  ...extra,
});

// ── 1. which sources were actually read ─────────────────────────────────────
{
  const read = readInFull([
    source('[1]', 'Read page', { content: 'the page itself', content_source: 'fetch' }),
    source('[2]', 'Snippet only'),
    source('[3]', 'Rendered page', { content: 'rendered body', content_source: 'firecrawl' }),
    source('[4]', 'Blank content', { content: '   ' }),
  ]);
  check('only sources with page text are read in full', read.length === 2, String(read.length));
  check('they keep their citation ids', read.map((item) => item.citation).join(',') === '[1],[3]', read.map((item) => item.citation).join(','));
  check('rank order is kept', read[0].title === 'Read page' && read[1].title === 'Rendered page');
  check('the extractor is reported', read[0].via === 'fetch' && read[1].via === 'firecrawl');
  check('a source with no citation id falls back to its position', readInFull([source(undefined, 'Anon', { content: 'x' })])[0].citation === '[1]');
  check('an empty result list has nothing to show', readInFull([]).length === 0);
}

// ── 2. the model's own searches ─────────────────────────────────────────────
{
  check('an array of queries is read as-is', parseToolSearches(['a', 'b']).join('|') === 'a|b');
  check('the jsonb text form is read too', parseToolSearches('["a","b"]').join('|') === 'a|b');
  check('nothing recorded is an empty list', parseToolSearches(null).length === 0 && parseToolSearches(undefined).length === 0);
  check('an empty string is an empty list', parseToolSearches('  ').length === 0);
  check('broken JSON is an empty list, not a throw', parseToolSearches('["a",').length === 0);
  check('a non-array is an empty list', parseToolSearches({ query: 'a' }).length === 0);
  check('duplicates collapse, case-insensitively', parseToolSearches(['RRF benchmark', 'rrf benchmark']).length === 1);
  check('whitespace is normalised', parseToolSearches(['  rrf   benchmark  '])[0] === 'rrf benchmark');
  check('empty and non-string entries are dropped', parseToolSearches(['', '  ', 7, null, 'real']).join('|') === 'real');
}

// ── 3. what the strip decides to show ─────────────────────────────────────
{
  const full = summarizeMachine({
    search_results: [source('[1]', 'Read page', { content: 'page' })],
    tool_searches: ['extra query'],
  });
  check('page text and extra searches both count', full.anything === true && full.read.length === 1 && full.extraSearches.length === 1);

  check('page text alone is enough', summarizeMachine({ search_results: [source('[1]', 'P', { content: 'x' })], tool_searches: [] }).anything === true);
  check('a search with no read page is still shown', summarizeMachine({ search_results: [source('[1]', 'P')], tool_searches: ['q'] }).anything === true);
  check('a plain answer shows no strip', summarizeMachine({ search_results: [source('[1]', 'P')], tool_searches: [] }).anything === false);
}

// ── 4. the strip in the bubble ────────────────────────────────────────────
{
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { MessageBubble } = await import(asUrl(BUBBLE));

  const message = (content, searchResults, toolSearches) => ({
    id: 'm1',
    conversation_id: 'c1',
    role: 'assistant',
    content,
    model: 'Qwen/Qwen2.5-7B-Instruct',
    search_enabled: true,
    search_results: searchResults,
    tool_searches: toolSearches,
    created_at: new Date().toISOString(),
  });

  const html = renderToStaticMarkup(
    React.createElement(MessageBubble, {
      message: message(
        'The paper reports an nDCG of 0.42 [1].',
        [source('[1]', 'Read in full paper', { content: 'an ndcg of 0.42', content_source: 'fetch' })],
        ['rrf benchmark numbers'],
      ),
      isStreaming: false,
      query: 'what is the nDCG',
      onRetrySearch: () => {},
    }),
  );

  check('the strip says what was read in full', html.includes('Read in full'));
  check('and names the source', html.includes('Read in full paper') && html.includes('[1]'));
  check('the page is linked', html.includes('https://a.test/1'));
  check('the strip says what the model searched', html.includes('Searched again') && html.includes('rrf benchmark numbers'));
  check('the query is a button that runs it again', /title="Run this search again: rrf benchmark numbers"/.test(html));
  const queryButton = html.match(/<button[^>]*Run this search again[^>]*>/)?.[0] ?? '';
  check('the button is enabled when there is a handler', queryButton !== '' && !/\sdisabled(=|\s|>)/.test(queryButton), queryButton.slice(0, 80));

  const plain = renderToStaticMarkup(
    React.createElement(MessageBubble, {
      message: message('An answer with no sources [1].', [source('[1]', 'Snippet only')], []),
      isStreaming: false,
      query: 'q',
      onRetrySearch: () => {},
    }),
  );
  check('a snippet-only answer shows no read-in-full strip', !plain.includes('Read in full'));
  check('and no searched-again strip', !plain.includes('Searched again'));
}

const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) process.exit(1);
