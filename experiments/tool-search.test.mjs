// The model's dork tool: a dork skips the query compiler and only reaches engines that parse
// operators, and a turn with none of those engines is refused rather than searched in plain text.
// Run: node experiments/tool-search.test.mjs (builds the module itself)
import { asUrl, bundle, tmpPath } from './lib/build.mjs';

const MODULE = process.env.TOOL_SEARCH_MODULE ?? tmpPath('tool-search.mjs');
if (!process.env.TOOL_SEARCH_MODULE) bundle('src/lib/toolSearch.ts', MODULE);
const { runToolSearch } = await import(asUrl(MODULE));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const source = (n) => ({ title: `Page ${n}`, url: `https://a.test/${n}`, snippet: 's', source_engine: 'duckduckgo' });

/** A fake search that records the arguments the executor hands it. */
const fakeSearch = (found = [source(1)]) => {
  const calls = [];
  const performSearch = async (query, conversationId, options) => {
    calls.push({ query, conversationId, options });
    return found;
  };
  return { calls, performSearch };
};

const base = { searchEnabled: true, conversationId: 'conv-1', knownUrls: [] };

// 1. the two rules a dork exists for
{
  const { calls, performSearch } = fakeSearch();
  const query = 'site:example.org filetype:pdf reciprocal rank fusion';
  const outcome = await runToolSearch({
    ...base,
    query,
    dork: true,
    engines: ['duckduckgo', 'arxiv', 'wikipedia', 'brave'],
    performSearch,
  });

  check('a dork is searched exactly once', calls.length === 1);
  check(
    'a dork skips the query compiler',
    calls[0]?.options.compileQueries === false,
    JSON.stringify(calls[0]?.options),
  );
  check(
    'a dork only reaches engines that parse operators',
    JSON.stringify(calls[0]?.options.engines) === JSON.stringify(['duckduckgo', 'brave']),
    JSON.stringify(calls[0]?.options.engines),
  );
  check('the dork reaches the search unchanged', calls[0]?.query === query, calls[0]?.query);
  check(
    'the answer keeps streaming and the sources are offered',
    calls[0]?.options.keepStreaming === true && outcome.count === 1 && outcome.offered.length === 1,
    JSON.stringify({ keepStreaming: calls[0]?.options.keepStreaming, count: outcome.count }),
  );
  check(
    'the tool result names the search and carries the source',
    outcome.text.startsWith(`Search results for "${query}":`) && outcome.text.includes('https://a.test/1'),
    outcome.text.slice(0, 80),
  );
  check('the run is recorded as a dork', outcome.yielded?.dork === true, JSON.stringify(outcome.yielded));
}

// 2. no selected engine parses operators: refused, never searched in plain text
{
  const { calls, performSearch } = fakeSearch();
  const outcome = await runToolSearch({
    ...base,
    query: 'site:example.org filetype:pdf',
    dork: true,
    engines: ['arxiv', 'wikipedia'],
    performSearch,
  });

  check('a dork with no operator-capable engine is not run at all', calls.length === 0);
  check(
    'the refusal says no selected engine parses operators',
    outcome.count === 0 && /No selected engine parses dork operators/.test(outcome.text),
    outcome.text,
  );
  check(
    'the refusal offers the way out (search_web) rather than pretending the search found nothing',
    /search_web/.test(outcome.text) && !/returned no usable sources/.test(outcome.text),
  );
  check('a refusal records no yield and offers nothing', outcome.yielded === undefined && outcome.offered.length === 0);
}

// 3. a plain search is compiled and is not narrowed to dork engines
{
  const { calls, performSearch } = fakeSearch();
  const outcome = await runToolSearch({
    ...base,
    query: 'surface code thresholds',
    dork: false,
    engines: ['duckduckgo', 'arxiv'],
    performSearch,
  });

  check('a plain search is compiled', calls[0]?.options.compileQueries === true, JSON.stringify(calls[0]?.options));
  check('a plain search is not recorded as a dork', outcome.yielded?.dork === undefined, JSON.stringify(outcome.yielded));
  check(
    'a plain search keeps every selected engine',
    calls[0]?.options.engines === undefined,
    JSON.stringify(calls[0]?.options),
  );
}

// 4. search off is refused before any engine call
{
  const { calls, performSearch } = fakeSearch();
  const outcome = await runToolSearch({
    ...base,
    searchEnabled: false,
    query: 'anything',
    dork: false,
    engines: ['duckduckgo'],
    performSearch,
  });

  check('search off is refused without searching', calls.length === 0 && /switched off/.test(outcome.text), outcome.text);
}

// 5. what the run added is counted against the evidence already held, and the cap is eight
{
  const many = Array.from({ length: 10 }, (_, index) => source(index + 1));
  const { calls, performSearch } = fakeSearch(many);
  const outcome = await runToolSearch({
    ...base,
    knownUrls: ['https://a.test/1', 'https://a.test/2'],
    query: 'surface code thresholds',
    dork: false,
    engines: ['duckduckgo'],
    performSearch,
  });

  check(
    'the yield counts what the answer did not already hold',
    outcome.yielded?.found === 10 && outcome.yielded?.added === 8,
    JSON.stringify(outcome.yielded),
  );
  check(
    'only the first eight reach the model, the rest are panel-only',
    outcome.offered.length === 8 && outcome.capped.length === 2,
    JSON.stringify({ offered: outcome.offered.length, capped: outcome.capped.length }),
  );
  check('the capped sources are not in the prompt text', !outcome.text.includes('https://a.test/10'), outcome.text.slice(-60));
  check('the call is still one search', calls.length === 1);
}

// 6. an empty run says it was empty, and is still recorded as a yield
{
  const { performSearch } = fakeSearch([]);
  const outcome = await runToolSearch({
    ...base,
    query: 'nothing at all',
    dork: false,
    engines: ['duckduckgo'],
    performSearch,
  });

  check(
    'an empty search reports no usable sources and records the yield',
    outcome.count === 0 && outcome.yielded?.found === 0 && /returned no usable sources/.test(outcome.text),
    outcome.text,
  );
}

const failures = results.filter((row) => !row.ok);
console.log(`\n${results.length - failures.length}/${results.length} assertions passed`);
if (failures.length) process.exit(1);
