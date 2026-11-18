// The browser engines are the only ones that can be widened without a function deploy, so each new
// one has to earn its place: a keyless, CORS-open API, a mapping that keeps the fields fusion ranks
// on, and silence when it has nothing rather than an invented result.
// Run: node experiments/client-engines.test.mjs (builds the modules itself)
import { asUrl, bundle, tmpPath } from './lib/build.mjs';

const CLIENT_PATH = process.env.CLIENT_ENGINES_MODULE ?? tmpPath('client-engines.mjs');
const ENGINES_PATH = process.env.ENGINES_MODULE ?? tmpPath('engine-registry.mjs');
const FUSION_PATH = process.env.FUSION_MODULE ?? tmpPath('engine-weights.mjs');
if (!process.env.CLIENT_ENGINES_MODULE) bundle('src/lib/clientEngines.ts', CLIENT_PATH);
if (!process.env.ENGINES_MODULE) bundle('src/lib/engines.ts', ENGINES_PATH);
if (!process.env.FUSION_MODULE) bundle('src/lib/fusion.ts', FUSION_PATH);

// `fetchJson` times out through `window.setTimeout`, and the mapping helpers use DOMParser only on
// the HTML-shaped engines — GDELT never reaches them.
globalThis.window = { setTimeout, clearTimeout };
globalThis.DOMParser = class {
  parseFromString() {
    return { body: { textContent: '' } };
  }
};

let requested = '';
globalThis.fetch = async (url) => {
  requested = String(url);
  const limit = Number(new URL(url).searchParams.get('maxrecords') ?? 0);
  return new Response(
    JSON.stringify({
      articles: [
        { url: 'https://news.test/a', title: 'Grid operators delay outage review', domain: 'news.test', sourcecountry: 'UK', language: 'English', seendate: '20261117120000' },
        { url: 'https://news.test/b', title: '', domain: 'news.test', sourcecountry: 'US', language: 'English', seendate: '2026-11-16T08:00:00Z' },
        { url: '', title: 'No link', domain: 'news.test', seendate: '20261115000000' },
        { url: 'https://news.test/c', title: 'Third', domain: 'news.test', seendate: '20261114000000' },
      ].slice(0, Math.max(1, limit)),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
};

const { CLIENT_ENGINES, CLIENT_ENGINE_IDS, searchClientEngines } = await import(asUrl(CLIENT_PATH));
const { ENGINE_CATALOG: ENGINES, SURFACES } = await import(asUrl(ENGINES_PATH));
const { archiveIntent, engineWeights } = await import(asUrl(FUSION_PATH));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// ── 1. GDELT maps into the shape fusion ranks on ───────────────────────────
{
  const found = await searchClientEngines('grid outage', ['gdelt'], 3);
  check('the news engine answers', found.length === 3, String(found.length));
  check('it keeps the title and link', found[0].title === 'Grid operators delay outage review' && found[0].url === 'https://news.test/a');
  check('a missing title falls back to the url', found[1].title === 'https://news.test/b');
  check('an entry with no url is dropped', !found.some((item) => !item.url));
  check('the publication date is normalised for recency', found[0].published === '2026-11-17', String(found[0].published));
  check('a date that is already ISO is left alone', found[1].published === '2026-11-16', String(found[1].published));
  check('the snippet names the origin', found[0].snippet.includes('news.test') && found[0].snippet.includes('UK'));
  check('it asks for no more than it was given', new URL(requested).searchParams.get('maxrecords') === '6', requested);
  check('an unknown engine is silence, not a guess', (await searchClientEngines('x', ['nope'], 3)).length === 0);
  const aborted = new AbortController();
  aborted.abort();
  check('an aborted run returns nothing', (await searchClientEngines('x', ['gdelt'], 3, undefined, aborted.signal)).length === 0);
}

// ── 2. the registry and the weights know about every engine ────────────────
{
  check('gdelt is a registered client engine', CLIENT_ENGINE_IDS.has('gdelt'));
  check('every client engine is in the picker', [...CLIENT_ENGINE_IDS].every((id) => ENGINES.some((engine) => engine.id === id)), [...CLIENT_ENGINE_IDS].join(','));
  const wayback = ENGINES.find((engine) => engine.id === 'wayback');
  check('wayback is registered as a server engine', wayback?.runtime === 'server');
  check('the deep-web surface includes the archive', SURFACES.find((surface) => surface.id === 'deep')?.engines.includes('wayback'));
  const gdelt = ENGINES.find((engine) => engine.id === 'gdelt');
  check('the news engine is browser-side', gdelt?.runtime === 'browser');
  const weights = engineWeights('what did example.com look like in 2021');
  check('both new engines carry a fusion weight', Number.isFinite(weights.gdelt) && Number.isFinite(weights.wayback), `${weights.gdelt}/${weights.wayback}`);
  check('an archive question outranks the live page', weights.wayback > weights.duckduckgo, `${weights.wayback} vs ${weights.duckduckgo}`);
  check('a live question does not', engineWeights('latest quantum error correction results').wayback < 1);

  // navigational is not archive intent: a bare domain or a CVE id asks about the page that exists
  // now, and lifting the archived copy would answer a different question than the one asked
  check('a dated question about a page is an archive question', archiveIntent('what did example.com look like in 2021'));
  check('historical wording is', archiveIntent('history of the roman republic'));
  check('a dork with a date is', archiveIntent('site:example.com before:2021'));
  check('a CVE lookup is not', archiveIntent('CVE-2024-3094 exploit') === false);
  check('a bare domain is not', archiveIntent('tesla.com investor relations') === false);
  check('a topical year beside a domain is not', archiveIntent('tesla.com 2024 revenue') === false);
  const cve = engineWeights('CVE-2024-3094 exploit');
  check('so the archive keeps its base weight on a CVE lookup', cve.wayback === 0.75, String(cve.wayback));
  check('and cannot outrank the live advisory', cve.wayback < cve.duckduckgo, `${cve.wayback} vs ${cve.duckduckgo}`);
}

const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) process.exit(1);
