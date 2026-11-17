// The fetch-and-extract stage: the top sources should reach the model as page text, and a page that
// will not load must never cost the search its results.
// Run: node experiments/extract.test.mjs (builds both modules itself when no paths are given)
import { asUrl, bundle, tmpPath } from './lib/build.mjs';

const EXTRACT_PATH = process.env.EXTRACT_MODULE ?? tmpPath('extract.mjs');
const CONTEXT_PATH = process.env.SOURCE_CONTEXT_MODULE ?? tmpPath('source-context.mjs');
if (!process.env.EXTRACT_MODULE) bundle('supabase/functions/web-search/extract.ts', EXTRACT_PATH);
if (!process.env.SOURCE_CONTEXT_MODULE) bundle('src/lib/sourceContext.ts', CONTEXT_PATH);

const {
  capText,
  decodeEntities,
  extractFromHtml,
  extractTopSources,
  fetchPageText,
  htmlToText,
  isExtractableUrl,
  pickExtractionTargets,
} = await import(asUrl(EXTRACT_PATH));
const { countWithPageText, formatSource, formatSourceContext } = await import(asUrl(CONTEXT_PATH));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const page = (body, type = 'text/html; charset=utf-8', status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': type } });

// ── 1. readable text out of a page ──────────────────────────────────────────
{
  const html = `<!doctype html><html><head><title>t</title><style>.a{color:red}</style></head>
    <body><nav>Skip to content</nav>
    <script>window.dataLayer=[1,2,3]</script>
    <p>The benchmark reports nDCG at 10 of 0.42 &amp; recall of 0.71.</p>
    <div>Second <b>paragraph</b> with a&nbsp;non&#8209;breaking space.</div>
    <footer>Cookie policy</footer></body></html>`;
  const text = htmlToText(html);
  check('script contents never reach the model', !/dataLayer|color:red/.test(text), text);
  check('prose survives the tag strip', text.includes('nDCG at 10 of 0.42 & recall of 0.71'));
  check('block tags become line breaks', text.split('\n').length >= 2, JSON.stringify(text.split('\n')));
  check('boilerplate lines are dropped', !/skip to content|cookie policy/i.test(text));
  check('entities decode, including numeric ones', /non‑breaking/.test(text), text.split('\n').pop());
}

check('an unknown entity is left alone', decodeEntities('&amp; &bogus;') === '& &bogus;');
check('a code point decodes', decodeEntities('&#x2014;') === '—');

// ── 2. the article body wins over the page chrome ───────────────────────────
{
  const html = `<html><body><header>Site name · Menu · Subscribe</header>
    <article><p>${'The paper measures retrieval quality with nDCG and reports a gain of 12 points. '.repeat(10)}</p></article>
    <aside>Related: other articles you may like</aside></body></html>`;
  const text = extractFromHtml(html, 5000);
  check('the article is extracted without the chrome', text.includes('12 points') && !/Related:|Menu/.test(text), text.slice(0, 80));
  check('and without the surrounding site name', !text.startsWith('Site name'), text.slice(0, 40));

  const noArticle = extractFromHtml('<html><body><p>Short page about a thing.</p></body></html>');
  check('a page with no article still yields its text', noArticle.includes('Short page about a thing'));
  check('extraction respects the character budget', extractFromHtml(`<p>${'word '.repeat(4000)}</p>`, 300).length <= 301);
}

check('long text is cut on a boundary and marked', (() => {
  const capped = capText('alpha beta gamma delta epsilon zeta', 20);
  return capped.length <= 21 && capped.endsWith('…');
})());
check('short text is returned untouched', capText('short', 100) === 'short');

// ── 3. which results are worth fetching ────────────────────────────────────
check('http and https are fetchable', isExtractableUrl('http://a.test/x') && isExtractableUrl('https://a.test/x'));
check('an onion service is not', !isExtractableUrl('http://abcdef.onion/'));
check('a local address is not', !isExtractableUrl('http://localhost:3000/'));
check('a non-http scheme is not', !isExtractableUrl('ftp://a.test/f') && !isExtractableUrl('not a url'));
check('the limit is honoured', pickExtractionTargets([{ url: 'https://a.test/1' }, { url: 'https://a.test/2' }, { url: 'https://a.test/3' }], 2).length === 2);
check('an unfetchable top result does not use up the window', (() => {
  const picked = pickExtractionTargets([{ url: 'http://x.onion/' }, { url: 'https://a.test/1' }, { url: 'https://a.test/2' }], 2);
  return picked.length === 2 && picked.every((row) => row.url.startsWith('https://'));
})());

// ── 4. one page, with the reasons it might not work ────────────────────────
{
  const body = `<article><p>Full text of the page with the number: 0.42.</p><p>${'Supporting detail sentences that a snippet would have cut off. '.repeat(3)}</p></article>`;
  const fetched = await fetchPageText('https://a.test/page', { fetchImpl: async () => page(body) });
  check('a fetched page comes back as text', fetched.source === 'fetch' && fetched.text.includes('0.42'), fetched.text);

  const csv = `rank,score\n${Array.from({ length: 20 }, (_, i) => `${i + 1},ndcg,0.${90 - i}`).join('\n')}`;
  const plain = await fetchPageText('https://a.test/api', { fetchImpl: async () => page(csv, 'text/plain') });
  check('a plain-text page is kept as it is, not tag-stripped', plain.text === csv.trim(), plain.text.slice(0, 30));

  const missing = await fetchPageText('https://a.test/gone', { fetchImpl: async () => page('nope', 'text/html', 404) }).catch((err) => err);
  check('a 404 is reported as an http status', String(missing.message) === 'http 404', String(missing.message));

  const pdf = await fetchPageText('https://a.test/paper.pdf', { fetchImpl: async () => page('%PDF-1.7', 'application/pdf') }).catch((err) => err);
  check('a pdf is reported as unreadable rather than decoded', /unreadable content type/.test(String(pdf.message)), String(pdf.message));

  const thin = await fetchPageText('https://a.test/spa', { fetchImpl: async () => page('<div id="root"></div>') }).catch((err) => err);
  check('an empty shell is treated as unreadable', /too thin/.test(String(thin.message)), String(thin.message));

  const timedOut = await fetchPageText('https://a.test/slow', {
    timeoutMs: 30,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
    }),
  }).catch((err) => err);
  check('a hanging page times out instead of stalling the search', /timed out/.test(String(timedOut.message)), String(timedOut.message));
}

// ── 5. the Firecrawl fallback, only when a plain fetch came back thin ──────
{
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('https://api.firecrawl.dev')) {
      return new Response(JSON.stringify({ data: { markdown: '# Rendered\n\nThe number is 0.42.' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return page('<div id="root"></div>');
  };
  const rendered = await fetchPageText('https://a.test/spa', { fetchImpl, firecrawlKey: 'k' });
  check('a page that renders in JavaScript is scraped instead', rendered.source === 'firecrawl' && rendered.text.includes('0.42'), rendered.text);
  check('the scrape went to Firecrawl', calls.some((url) => url.includes('firecrawl.dev/v1/scrape')));

  const noKey = await fetchPageText('https://a.test/spa', { fetchImpl: async () => page('<div id="root"></div>') }).catch((err) => err);
  check('without a key there is nothing to fall back to', /too thin/.test(String(noKey.message)));

  const bothFail = await fetchPageText('https://a.test/spa', {
    firecrawlKey: 'k',
    fetchImpl: async (url) => (String(url).startsWith('https://api.firecrawl.dev')
      ? page('{"error":"rate limited"}', 'application/json', 429)
      : page('<div id="root"></div>')),
  }).catch((err) => err);
  check('both failures are reported together', /too thin.*firecrawl: firecrawl http 429/.test(String(bothFail.message)), String(bothFail.message));

  const goodPage = await fetchPageText('https://a.test/page', {
    firecrawlKey: 'k',
    fetchImpl: async (url) => (String(url).includes('firecrawl') ? page('{"data":{"markdown":"unused"}}', 'application/json') : page(`<p>${'real page text '.repeat(40)}</p>`)),
  });
  check('a readable page costs no Firecrawl credit', goodPage.source === 'fetch');
}

// ── 6. the whole stage: order kept, text attached, failures counted ────────
{
  const sources = [
    { title: 'first', url: 'https://a.test/1', snippet: 's1' },
    { title: 'second', url: 'https://a.test/broken', snippet: 's2' },
    { title: 'third', url: 'https://a.test/3', snippet: 's3' },
    { title: 'fourth', url: 'https://a.test/4', snippet: 's4' },
  ];
  const { results: enriched, summary } = await extractTopSources(sources, {
    limit: 3,
    fetchImpl: async (url) => {
      if (String(url).includes('broken')) return page('nope', 'text/html', 500);
      return page(`<article><p>${('text of ' + url + '. ').repeat(20)}</p></article>`);
    },
  });
  check('the ranking is not reshuffled by extraction', enriched.map((row) => row.title).join(',') === 'first,second,third,fourth');
  check('page text is attached to the sources that were read', enriched[0].content.includes('https://a.test/1') && enriched[2].content.includes('https://a.test/3'));
  check('the source of the text is recorded', enriched[0].content_source === 'fetch', enriched[0].content_source);
  check('a failed page keeps its result and gains no content', enriched[1].content === undefined && enriched[1].snippet === 's2');
  check('the fourth source is left as a snippet', enriched[3].content === undefined);
  check('the summary counts what was attempted', summary.requested === 3 && summary.extracted === 2 && summary.failures.length === 1, JSON.stringify(summary));
  check('the summary says why the page failed', /http 500/.test(summary.failures[0].error), summary.failures[0].error);
  check('the summary counts the characters', summary.chars === (enriched[0].content.length + enriched[2].content.length), String(summary.chars));

  const off = await extractTopSources(sources, { limit: 0 });
  check('a limit of zero reads nothing', off.summary.requested === 0 && off.results.every((row) => row.content === undefined));
}

// ── 7. how that text is given to the model ────────────────────────────────
{
  const withText = formatSource({
    title: 'Paper',
    url: 'https://a.test/paper',
    snippet: 'A snippet.',
    source_engine: 'exa+firecrawl',
    citation_id: '[1]',
    content: 'The measured nDCG was 0.42.',
  });
  check('the page text is given after the snippet', /Snippet: A snippet\.[\s\S]*Page text \(extracted from the page\):\nThe measured nDCG was 0.42\./.test(withText), withText);
  check('identity and provenance stay first', withText.startsWith('[1] Paper\nURL: https://a.test/paper\nProvider: exa+firecrawl'));

  const snippetOnly = formatSource({ title: 'T', url: 'https://a.test/x', snippet: 's', source_engine: 'exa' });
  check('a source without text reads exactly as before', !snippetOnly.includes('Page text') && snippetOnly.endsWith('Snippet: s'), snippetOnly);

  const long = formatSource(
    { title: 'T', url: 'https://a.test/l', snippet: 's', source_engine: 'exa', content: 'word '.repeat(1000) },
    { contentChars: 100 },
  );
  check('one long page cannot crowd out the rest', long.length < 400 && long.includes('…'), String(long.length));

  const many = formatSourceContext([
    { title: 'A', url: 'https://a.test/a', snippet: 'sa', source_engine: 'exa', citation_id: '[1]', content: 'full a' },
    { title: 'B', url: 'https://a.test/b', snippet: 'sb', source_engine: 'exa', citation_id: '[2]' },
    { title: 'C', url: 'https://a.test/c', snippet: 'sc', source_engine: 'exa', citation_id: '[3]' },
  ], { limit: 2 });
  check('the context is rank ordered', many.indexOf('[1] A') < many.indexOf('[2] B'));
  check('the limit is honoured', !many.includes('[3] C'));
  check('page text rides along inside the context', many.includes('full a'));
  check('sources with text can be counted for the notice', countWithPageText([
    { title: 'A', url: 'u1', snippet: 's', source_engine: 'e', content: 'x' },
    { title: 'B', url: 'u2', snippet: 's', source_engine: 'e' },
    { title: 'C', url: 'u3', snippet: 's', source_engine: 'e', content: '  ' },
  ]) === 1);
}

const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) process.exit(1);
