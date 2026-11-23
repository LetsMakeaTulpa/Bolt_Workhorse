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

const { readInFull, parseSearchYields, parseQueries, promptCoverage, promptView, summarizeMachine, usedSources, modelSearchOrigin } = await import(asUrl(LIB));

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
  check('the text the prompt carried comes with it', read[0].text === 'the page itself', read[0].text);
  check(
    'its length is the length the model read',
    read[0].given === 'the page itself'.length && read[0].stored === 'the page itself'.length,
    `${read[0].given}/${read[0].stored}`,
  );
  check('a source with no citation id falls back to its position', readInFull([source(undefined, 'Anon', { content: 'x' })])[0].citation === '[1]');
  check('an empty result list has nothing to show', readInFull([]).length === 0);
}

// ── 1b. the text is the prompt's text, cap and all ───────────────────────────
{
  const page = 'word '.repeat(1200); // 6,000 characters: more than any prompt carries
  const standard = readInFull([source('[1]', 'Long page', { content: page })])[0];
  check('a long page is cut where the prompt cuts it', standard.given <= 4000 && standard.text.endsWith('…'), String(standard.given));
  check('the whole page length is still reported', standard.stored === page.trim().length, String(standard.stored));
  check('never more than the prompt carried', standard.given < standard.stored);

  const followUp = readInFull([source('[1]', 'Long page', { content: page, prompt_chars: 3000 })])[0];
  check(
    'a cap recorded with the row is honoured',
    followUp.given <= 3000 && followUp.given < standard.given,
    `${followUp.given} vs ${standard.given}`,
  );

  const short = readInFull([source('[1]', 'Short page', { content: '  one line  ' })])[0];
  check('a short page is given whole, trimmed', short.text === 'one line' && short.given === short.stored, short.text);
}

// ── 1c. what each of the model's own searches added ─────────────────────────
{
  const yields = parseSearchYields([
    { query: 'rrf k constant', found: 5, added: 3 },
    { query: 'reciprocal rank fusion 2009', found: 4, added: 0 },
    { query: 'rrf k constant', found: 6, added: 1 },
    { query: 'no counts' },
    'a bare string from an older row',
  ]);
  check('a recorded search keeps the count it added', yields['rrf k constant']?.added === 1, JSON.stringify(yields['rrf k constant']));
  check('a repeat query keeps its newest record', yields['rrf k constant']?.found === 6, String(yields['rrf k constant']?.found));
  check('a redundant search is zero new, not unknown', yields['reciprocal rank fusion 2009']?.added === 0);
  check('an entry without counts records nothing', !('no counts' in yields) && Object.keys(yields).length === 2);
  check(
    'a row written before the counts claims none',
    Object.keys(parseSearchYields(undefined)).length === 0 && Object.keys(parseSearchYields(['x'])).length === 0,
  );

  const traced = summarizeMachine({
    search_results: [],
    tool_searches: ['rrf k constant'],
    tool_search_yields: [{ query: 'rrf k constant', found: 1, added: 0 }],
  });
  check('the strip receives the yields with the searches', traced.searchYields['rrf k constant']?.added === 0 && traced.anything);
}

// ── 2. the model's own searches ─────────────────────────────────────────────
{
  check('an array of queries is read as-is', parseQueries(['a', 'b']).join('|') === 'a|b');
  check('the jsonb text form is read too', parseQueries('["a","b"]').join('|') === 'a|b');
  check('nothing recorded is an empty list', parseQueries(null).length === 0 && parseQueries(undefined).length === 0);
  check('an empty string is an empty list', parseQueries('  ').length === 0);
  check('broken JSON is an empty list, not a throw', parseQueries('["a",').length === 0);
  check('a non-array is an empty list', parseQueries({ query: 'a' }).length === 0);
  check('duplicates collapse, case-insensitively', parseQueries(['RRF benchmark', 'rrf benchmark']).length === 1);
  check('whitespace is normalised', parseQueries(['  rrf   benchmark  '])[0] === 'rrf benchmark');
  check('empty and non-string entries are dropped', parseQueries(['', '  ', 7, null, 'real']).join('|') === 'real');
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

// ── 3b. how much of the fused list the prompt carried ─────────────────────
{
  const mixed = summarizeMachine({
    search_results: [
      source('[1]', 'Given', { in_prompt: true }),
      source('[2]', 'Given too', { in_prompt: true }),
      source('[3]', 'Panel only', { in_prompt: false }),
    ],
    tool_searches: [],
  });
  check('the marks are counted', mixed.given === 2 && mixed.shown === 3 && mixed.panelOnly === 1);
  check('a source the model never saw is worth a strip on its own', mixed.anything === true && mixed.read.length === 0);

  const all = summarizeMachine({ search_results: [source('[1]', 'A', { in_prompt: true })], tool_searches: [] });
  check('nothing withheld means nothing to report', all.panelOnly === 0 && all.anything === false && all.given === 1);

  const carried = usedSources({
    search_results: [source('[1]', 'A', { in_prompt: true }), source('[2]', 'B', { in_prompt: false })],
  });
  check('the sources dated are the ones the prompt carried', carried.length === 1 && carried[0].citation_id === '[1]');
  check('an unmarked row falls back to all its sources', usedSources({ search_results: [source('[1]', 'A')] }).length === 1);
  check(
    'a row marked entirely panel-only carries nothing to the model',
    usedSources({
      search_results: [source('[1]', 'A', { in_prompt: false }), source('[2]', 'B', { in_prompt: false })],
    }).length === 0,
  );

  const unmarked = summarizeMachine({ search_results: [source('[1]', 'A')], tool_searches: [] });
  check('a row written before the mark claims nothing', unmarked.given === null && unmarked.panelOnly === 0 && unmarked.anything === false);
}

// ── 3c. the prompt read back out of the answer ──────────────────────────────
{
  const page = 'alpha '.repeat(2000); // 12,000 characters: more than any prompt carries
  const view = promptView({
    queries_used: '["compiled a","compiled b"]',
    search_results: [
      source('[1]', 'Carried page', {
        content: page,
        in_prompt: true,
        prompt_reason: 'trimmed',
        prompt_chars: 100,
        content_source: 'fetch',
      }),
      source('[2]', 'Snippet carried', { in_prompt: true, prompt_reason: 'given' }),
      source('[3]', 'Over the cap', { content: 'page', in_prompt: false, prompt_reason: 'capped' }),
      source('[4]', 'No prompt', { content: 'page', in_prompt: false, prompt_reason: 'no-prompt' }),
    ],
  });
  check('the compiled queries are read back', view.asked.join('|') === 'compiled a|compiled b', view.asked.join('|'));
  check('carried sources keep prompt order', view.carried.map((entry) => entry.title).join('|') === 'Carried page|Snippet carried');
  check('left-out sources keep rank order', view.leftOut.map((entry) => entry.title).join('|') === 'Over the cap|No prompt');
  check(
    'a cut page says how much was carried and how much there was',
    view.carried[0].carried > 0 && view.carried[0].stored === page.trim().length && view.carried[0].truncated,
    `${view.carried[0].carried}/${view.carried[0].stored}`,
  );
  check('a snippet carries no page text', view.carried[1].carried === 0 && view.carried[1].text === '');
  check('the total is what the prompt carried', view.characters === view.carried[0].carried, String(view.characters));
  check(
    'the reasons travel with the left-out rows',
    view.leftOut[0].reason === 'capped' && view.leftOut[1].reason === 'no-prompt',
  );
  check('the cut count is the truncated count', view.truncated === 1 && view.anything === true);

  const legacy = promptView({ search_results: [source('[1]', 'Old row', { content: 'page text' })] });
  check(
    'an unmarked row claims no omission',
    legacy.coverageRecorded === false && legacy.leftOut.length === 0 && legacy.carried.length === 1,
  );
  check('and records no query', legacy.asked.length === 0);
  check('a row with no sources has nothing to show', promptView({ search_results: [] }).anything === false);
}

// ── 4. the strip in the bubble ────────────────────────────────────────────
{
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { MessageBubble } = await import(asUrl(BUBBLE));

  const message = (content, searchResults, toolSearches, queries = []) => ({
    id: 'm1',
    conversation_id: 'c1',
    role: 'assistant',
    content,
    model: 'Qwen/Qwen2.5-7B-Instruct',
    search_enabled: true,
    search_results: searchResults,
    queries_used: queries,
    tool_searches: toolSearches,
    created_at: new Date().toISOString(),
  });

  const html = renderToStaticMarkup(
    React.createElement(MessageBubble, {
      message: message(
        'The paper reports an nDCG of 0.42 [1].',
        [
          source('[1]', 'Read in full paper', {
            content: 'an ndcg of 0.42',
            content_source: 'fetch',
            in_prompt: true,
            prompt_reason: 'given',
          }),
        ],
        ['rrf benchmark numbers'],
        ['what is the nDCG'],
      ),
      isStreaming: false,
      query: 'what is the nDCG',
      onRetrySearch: () => {},
    }),
  );

  check('the view is the prompt behind the answer', html.includes('What the model read'), 'view title');
  check(
    'it starts with the question as the search sent it',
    html.includes('Asked as') && html.includes('what is the nDCG') && html.includes('sent as typed'),
    'asked-as line',
  );
  check('then the sources in prompt order', html.includes('In the prompt') && html.includes('Read in full paper'));
  check('the source row is a control', /<button[^>]*data-prompt-source="https:\/\/a\.test\/1"/.test(html), 'prompt row');
  check(
    'the summary says how many characters the prompt carried',
    // the count is wrapped in its own span so a narrow line cannot break it, so compare the text
    html.replace(/<[^>]*>/g, '').includes('1 of 1 source reached the prompt · 15 chars carried'),
    html.slice(0, 240),
  );
  check('the row says which extractor read it', html.includes('>fetch<'), 'extractor');
  check('the text stays closed until it is asked for', !html.includes('exactly as the model read it'));
  check('the strip says what the model searched', html.includes('Searched again') && html.includes('rrf benchmark numbers'));
  check(
    'the query says it only searches',
    /title="Search only[^"]*rrf benchmark numbers[^"]*not rewritten"/.test(html),
    'chip title',
  );
  const queryButton = html.match(/<button[^>]*Search only[^>]*>/)?.[0] ?? '';
  check('the button is enabled when there is a handler', queryButton !== '' && !/\sdisabled(=|\s|>)/.test(queryButton), queryButton.slice(0, 80));

  const plain = renderToStaticMarkup(
    React.createElement(MessageBubble, {
      message: message('An answer with no sources [1].', [source('[1]', 'Snippet only')], []),
      isStreaming: false,
      query: 'q',
      onRetrySearch: () => {},
    }),
  );
  check('a snippet-only answer still shows what it read', plain.includes('What the model read') && plain.includes('snippet only'));
  check('and no searched-again strip', !plain.includes('Searched again'));
  check(
    'a row with no prompt marks claims no omission',
    !plain.includes('Never reached the prompt') && plain.includes('Stored with this answer'),
    plain.slice(0, 240),
  );

  const long = 'word '.repeat(1200);
  const compiledView = renderToStaticMarkup(
    React.createElement(MessageBubble, {
      message: message(
        'An answer from a long page [1] and a page it never saw [2].',
        [
          source('[1]', 'Long supplied page', {
            content: long,
            in_prompt: true,
            prompt_reason: 'trimmed',
            prompt_chars: 200,
          }),
          source('[2]', 'Panel only page', { content: 'other text', in_prompt: false, prompt_reason: 'capped' }),
        ],
        [],
        ['first rewritten query', 'second rewritten query'],
      ),
      isStreaming: false,
      query: 'the original question',
    }),
  );
  check(
    'a rewritten question names every query the compiler sent',
    compiledView.includes('compiler rewrote') &&
      compiledView.includes('first rewritten query') &&
      compiledView.includes('second rewritten query'),
    'compiled queries',
  );
  check(
    'a cut page shows where the prompt stopped and how long the page was',
    compiledView.includes('of 5,999') && compiledView.includes('1 cut'),
    'truncation',
  );
  check(
    'a source that never reached the prompt is listed with its reason',
    compiledView.includes('Never reached the prompt') &&
      compiledView.includes('Panel only page') &&
      compiledView.includes('over the follow-up cap'),
    'left out',
  );

  const withheld = renderToStaticMarkup(
    React.createElement(MessageBubble, {
      message: message(
        'An answer that used only its first source [1].',
        [
          source('[1]', 'Given', { in_prompt: true }),
          source('[2]', 'Panel only', { in_prompt: false, prompt_reason: 'capped' }),
        ],
        [],
      ),
      isStreaming: false,
      query: 'q',
      onRetrySearch: () => {},
    }),
  );
  check(
    'a source the prompt never carried is named, with the reason',
    withheld.includes('Never reached the prompt') &&
      withheld.includes('Panel only') &&
      withheld.includes('over the follow-up cap'),
    withheld.slice(0, 240),
  );
  check('and the summary counts it', withheld.includes('1 never reached'));

  /** A rendered answer, so each freshness case states only its dates and its query. */
  const answer = (content, searchResults, query) =>
    renderToStaticMarkup(
      React.createElement(MessageBubble, {
        message: message(content, searchResults, []),
        isStreaming: false,
        query,
        onRetrySearch: () => {},
      }),
    );

  const dated = answer(
    'An old answer with one new page behind it [1][2].',
    [
      source('[1]', 'Old page', { in_prompt: true, published: '2019-05-01' }),
      source('[2]', 'Newer page', { in_prompt: true, published: '2026-08-02' }),
      source('[3]', 'Undated page', { in_prompt: true }),
    ],
    'latest quantum error correction results',
  );
  check(
    'the strip shows the date window the sources cover',
    dated.includes('Sources dated') && dated.includes('2019-05-01 → 2026-08-02') && dated.includes('1 undated'),
    dated.slice(0, 240),
  );
  check('a recent newest page is shown without a flag', !dated.includes('mo old'));
  check(
    'the hover carries the whole window',
    dated.includes('title="Publication window: 2019-05-01 → 2026-08-02'),
    dated.match(/title="Publication window[^"]*"/)?.[0],
  );

  const staleAnswer = answer(
    'An answer built on pages from before the question [1][2].',
    [
      source('[1]', 'Older page', { in_prompt: true, published: '2019-05-01' }),
      source('[2]', 'Old page', { in_prompt: true, published: '2020-01-02' }),
    ],
    'latest quantum error correction results',
  );
  check(
    'and flags an old newest page for a recency query',
    staleAnswer.includes('Sources dated') && staleAnswer.includes('newest is') && staleAnswer.includes('mo old'),
    staleAnswer.slice(0, 240),
  );

  const quiet = answer(
    'A timeless answer [1].',
    [source('[1]', 'Old page', { in_prompt: true, published: '2019-05-01' })],
    'history of quantum error correction',
  );
  check('a tight, dated, timeless window stays out of the strip', !quiet.includes('Sources dated'), quiet.slice(0, 240));

  const wide = answer(
    'A long view [1][2].',
    [
      source('[1]', 'Older page', { in_prompt: true, published: '2015-01-01' }),
      source('[2]', 'Newer page', { in_prompt: true, published: '2026-01-01' }),
    ],
    'history of quantum error correction',
  );
  check(
    'a window spanning many years still speaks up',
    wide.includes('Sources dated') && wide.includes('2015-01-01 → 2026-01-01'),
    wide.slice(0, 240),
  );

  const mostlyUndated = answer(
    'Sparse dates [1][2][3].',
    [
      source('[1]', 'Dated page', { in_prompt: true, published: '2024-01-01' }),
      source('[2]', 'Undated page', { in_prompt: true }),
      source('[3]', 'Another undated page', { in_prompt: true }),
    ],
    'history of quantum error correction',
  );
  check(
    'mostly undated sources still speak up',
    mostlyUndated.includes('Sources dated') && mostlyUndated.includes('2 undated'),
    mostlyUndated.slice(0, 240),
  );
}

// ── 5. opening the text the model was given ─────────────────────────────────
{
  let renderer = null;
  try {
    renderer = await import('react-test-renderer');
  } catch {
    console.log('SKIP  the page text opens on click — react-test-renderer missing from node_modules');
  }
  if (renderer) {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const React = await import('react');
    const { MessageBubble } = await import(asUrl(BUBBLE));
    let tree;
    await renderer.act(async () => {
      tree = renderer.create(
        React.createElement(MessageBubble, {
          message: {
            id: 'm2',
            conversation_id: 'c1',
            role: 'assistant',
            content: 'The paper reports an nDCG of 0.42 [1].',
            model: 'Qwen/Qwen2.5-7B-Instruct',
            search_enabled: true,
            search_results: [
              source('[1]', 'Read in full paper', { content: 'an ndcg of 0.42', content_source: 'firecrawl' }),
            ],
            tool_searches: [],
            created_at: new Date().toISOString(),
          },
          isStreaming: false,
          query: 'what is the nDCG',
        }),
      );
    });
    const nodes = () => {
      const all = [];
      const walk = (node) => {
        if (!node || typeof node === 'string') return;
        all.push(node);
        (node.children ?? []).forEach(walk);
      };
      walk(tree.root);
      return all;
    };
    // the rendered text only: titles are attributes, so a claim in a tooltip cannot pass for text
    const text = (node) => {
      if (typeof node === 'string') return node;
      if (Array.isArray(node)) return node.map(text).join('');
      return node && node.children ? text(node.children) : '';
    };
    const shown = () => text(tree.toJSON());

    check('the page text is not on screen before a click', !shown().includes('an ndcg of 0.42'));
    const chip = nodes().find((node) => node.type === 'button' && node.props['data-prompt-source']);
    check('the read entry is mounted as a control', Boolean(chip));
    await renderer.act(async () => {
      chip.props.onClick();
    });
    check('opening it shows the exact text the model read', shown().includes('an ndcg of 0.42'));
    check('with its length and the extractor', shown().includes('15 chars given') && shown().includes('read by firecrawl'));
    const close = nodes().find((node) => node.type === 'button' && node.props['aria-label'] === 'Close the page text');
    await renderer.act(async () => {
      close.props.onClick();
    });
    check('closing it puts the text away', !shown().includes('an ndcg of 0.42') && !shown().includes('read by firecrawl'));
  }
}

// ── the Sources panel's marker: which stored rows the model was actually given ──
{
  const coverage = promptCoverage([
    {
      search_results: [
        source('[1]', 'Read by the model', { in_prompt: true, prompt_reason: 'given' }),
        source('[2]', 'Over the cap', { in_prompt: false, prompt_reason: 'capped' }),
        source('[3]', 'Panel only, no reason recorded', { in_prompt: false }),
        source('[4]', 'Saved before the mark'),
      ],
    },
  ]);
  check(
    'a marked row carries its verdict into the panel',
    coverage.get('https://a.test/1')?.inPrompt === true && coverage.get('https://a.test/2')?.inPrompt === false,
    JSON.stringify([...coverage]),
  );
  check('a reasoned row carries the reason too', coverage.get('https://a.test/2')?.reason === 'capped');
  check(
    'a boolean-only row keeps its verdict without inventing a reason',
    coverage.get('https://a.test/3')?.reason === null && coverage.get('https://a.test/3')?.inPrompt === false,
  );
  check('an unmarked legacy row stays unknown, not "never shown"', !coverage.has('https://a.test/4'));
  check(
    'a trimmed row is still a carried row',
    promptCoverage([{ search_results: [source('[1]', 'Long page', { prompt_reason: 'trimmed' })] }]).get('https://a.test/1')?.inPrompt === true,
  );

  const newest = promptCoverage([
    { search_results: [source('[1]', 'shown once', { in_prompt: true, prompt_reason: 'given' })] },
    { search_results: [source('[1]', 'not shown later', { in_prompt: false, prompt_reason: 'no-prompt' })] },
  ]);
  check(
    'the newest turn that carried a url decides',
    newest.get('https://a.test/1')?.inPrompt === false && newest.get('https://a.test/1')?.reason === 'no-prompt',
  );

  const untouched = promptCoverage([{ search_results: [source('[1]', 'unmarked')] }]);
  check('a conversation with no marks yields nothing to claim', untouched.size === 0, String(untouched.size));
}

// a stored row records the query that returned it; when that query is one the model ran itself,
// the Sources panel can name the search behind the row
{
  const searches = ['surface code thresholds', 'reciprocal rank fusion'];
  check(
    'a stored row names the model search that produced it',
    modelSearchOrigin('surface code thresholds', searches) === 'surface code thresholds',
  );
  check(
    'the question that opened the turn is not an origin',
    modelSearchOrigin('how do surface codes scale?', searches) === null,
  );
  check(
    'a row with no query names no origin',
    modelSearchOrigin(undefined, searches) === null && modelSearchOrigin('   ', searches) === null,
  );
}

// the strip marks a dork as a dork: the flag travels in the recorded yield, not the query text
{
  const yields = parseSearchYields([
    { query: 'site:example.org filetype:pdf', found: 2, added: 1, dork: true },
    { query: 'surface code thresholds', found: 4, added: 2 },
  ]);
  check('a dork run keeps its flag through the stored row', yields['site:example.org filetype:pdf']?.dork === true);
  check('a plain extra search is not marked as a dork', yields['surface code thresholds']?.dork === undefined);
}

const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) process.exit(1);
