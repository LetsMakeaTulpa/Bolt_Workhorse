// Retrying a turn that failed after its sources were stored must not run the engines again. These
// checks pin the decision: the live run wins when it answers the same question, the stored rows are
// the fallback, and the rebuilt list keeps each source's citation number.
// Run: node experiments/reuse-sources.test.mjs

import { asUrl, bundle, tmpPath } from './lib/build.mjs';

const OUT = process.env.REUSE_SOURCES_MODULE ?? tmpPath('reuse-sources.mjs');
if (!process.env.REUSE_SOURCES_MODULE) bundle('src/lib/reuseSources.ts', OUT);

const { reuseForRetry, sourcesFromRows } = await import(asUrl(OUT));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const row = (over = {}) => ({
  id: `row-${over.citation_id ?? '1'}`,
  conversation_id: 'c-1',
  title: `Source ${over.citation_id ?? '[1]'}`,
  url: `https://a.test/${String(over.citation_id ?? '1').replace(/\D/g, '') || '1'}`,
  snippet: 'a snippet',
  provider: 'exa',
  original_query: 'tesla q3 deliveries',
  publication_date: '2026-05-01',
  relevance_score: 0.42,
  citation_id: '[1]',
  metadata: {},
  ...over,
});

// 1. rebuilding the list keeps the citation numbers the answer used
{
  const sources = sourcesFromRows([
    row({ citation_id: '[10]', id: 'ten' }),
    row({ citation_id: '[2]', id: 'two' }),
    row({ citation_id: '[1]', id: 'one' }),
  ]);
  check('sources come back in citation order', sources.map((s) => s.citation_id).join(',') === '[1],[2],[10]', sources.map((s) => s.citation_id).join(','));
  check('the row keeps its provider', sources[0].source_engine === 'exa');
  check('the row keeps its date', sources[0].published === '2026-05-01');
  check('the row keeps its score', sources[0].relevance_score === 0.42);
}
{
  const sources = sourcesFromRows([row({ citation_id: '' }), row({ citation_id: '[2]', id: 'two' })]);
  check('a row with no citation number sorts last, not first', sources[1].citation_id === undefined, sources.map((s) => String(s.citation_id)).join(','));
}
{
  const sources = sourcesFromRows([row({ publication_date: '' })]);
  check('an empty date is absent, not an empty string', sources[0].published === undefined);
  check('an empty citation id is absent', sourcesFromRows([row({ citation_id: '' })])[0].citation_id === undefined);
}

// 2. only this conversation's rows, for this question, with somewhere to go
{
  const rows = [
    row({ id: 'mine' }),
    row({ id: 'other-conversation', conversation_id: 'c-2' }),
    row({ id: 'other-question', original_query: 'spacex launch cadence' }),
    row({ id: 'no-url', url: '' }),
  ];
  const sources = sourcesFromRows(rows, { question: 'tesla q3 deliveries', conversationId: 'c-1' });
  check('only this conversation and question is reused', sources.length === 1 && sources[0].url === 'https://a.test/1', `${sources.length}`);
  check('a row with no url is not a source', sources.every((source) => source.url !== ''));
}

// 3. the question is compared as written, not as typed
{
  const sources = sourcesFromRows([row({ original_query: 'Tesla  Q3   Deliveries' })], { question: '  tesla q3 deliveries ' });
  check('case and spacing do not change the question', sources.length === 1, `${sources.length}`);
  check('a different question reuses nothing', sourcesFromRows([row()], { question: 'different question' }).length === 0);
}

// 4. what a retry answers from
const live = [{ title: 'Live', url: 'https://live.test/a', snippet: 's', source_engine: 'exa', citation_id: '[1]', content: 'full page' }];
{
  const choice = reuseForRetry({ question: 'tesla q3 deliveries', lastQuery: 'Tesla Q3 Deliveries', live, rows: [] });
  check('the run in memory wins when it answers the same question', choice === live);
  check('the in-memory list keeps its page text', choice?.[0].content === 'full page');
}
{
  const choice = reuseForRetry({ question: 'tesla q3 deliveries', lastQuery: 'some earlier question', live, rows: [row()] });
  check('a list for another question is not reused', choice?.[0].title === 'Source [1]', choice?.[0].title);
}
{
  const choice = reuseForRetry({ question: 'tesla q3 deliveries', lastQuery: null, live: [], rows: [row()] });
  check('the stored rows answer when nothing is in memory', choice?.length === 1 && choice[0].url === 'https://a.test/1');
}
{
  check('nothing stored and nothing live means search again', reuseForRetry({ question: 'q', lastQuery: null, live: [], rows: [] }) === null);
  check(
    'stored rows for another question do not count',
    reuseForRetry({ question: 'q', lastQuery: 'q', live: [], rows: [row({ original_query: 'other' })] }) === null,
  );
}

const failures = results.filter((row) => !row.ok);
console.log(`\n${results.length - failures.length}/${results.length} assertions passed`);
if (failures.length) process.exit(1);
