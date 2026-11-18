// The machine strip's freshness receipt: the date window the answer's sources cover, and whether a
// query that asked for recent material got it.
// Run: node experiments/freshness.test.mjs (builds the module itself)
import { asUrl, bundle, tmpPath } from './lib/build.mjs';

const LIB = process.env.FRESHNESS_MODULE ?? tmpPath('freshness.mjs');
if (!process.env.FRESHNESS_MODULE) bundle('src/lib/freshness.ts', LIB);

const { describeFreshness, freshnessOf } = await import(asUrl(LIB));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** A fixed clock, so "months old" is arithmetic and not the calendar of the day. */
const NOW = Date.UTC(2026, 10, 17);

const page = (published, title = 'Page') => ({
  title,
  url: `https://a.test/${title.toLowerCase().replace(/\s+/g, '-')}`,
  snippet: `snippet for ${title}`,
  source_engine: 'exa',
  ...(published === undefined ? {} : { published }),
});

const window = (sources, query = 'quantum error correction', now = NOW) => freshnessOf(sources, query, now);

// ── 1. the date window ─────────────────────────────────────────────────────
{
  const days = window([
    page('2026-08-02', 'Newest'),
    page('2019-05-01', 'Oldest'),
    page('2023-11-30', 'Middle'),
  ]);
  check('the window runs oldest to newest', days.oldest === '2019-05-01' && days.newest === '2026-08-02', `${days.oldest} → ${days.newest}`);
  check('every dated page counts', days.dated === 3 && days.undated === 0);
  check('a timeless query does not flag the window', days.wantsRecent === false && days.stale === false);

  const one = window([page('2024-02-29', 'Only')]);
  check('one dated page is its own window', one.oldest === '2024-02-29' && one.newest === '2024-02-29');
}

// ── 2. what is not a date ──────────────────────────────────────────────────
{
  const days = window([page('2019-05-01'), page('sometime in 2020'), page('2020-13-40'), page(undefined, 'No date'), page('   ', 'Blank')]);
  check('undated pages are counted, not guessed at', days.dated === 1 && days.undated === 4, `${days.dated} dated, ${days.undated} undated`);
  check('a malformed date does not enter the window', days.oldest === '2019-05-01' && days.newest === '2019-05-01');
  check('an answer with no sources has nothing to say', window([]).dated === 0 && window([]).stale === false);
}

// ── 3. recency asked and answered ──────────────────────────────────────────
{
  const fresh = window([page('2026-11-07'), page('2026-06-01')], 'latest quantum error correction results');
  check('a recency query is recognised', fresh.wantsRecent === true);
  check('a recent newest page is not flagged', fresh.stale === false && fresh.newestAgeMonths === 0, String(fresh.newestAgeMonths));

  const old = window([page('2020-03-01'), page('2019-05-01')], 'latest quantum error correction results');
  check('a recency query served by an old newest page is flagged', old.wantsRecent === true && old.stale === true);
  check('the flag carries the age it is based on', old.newestAgeMonths === 80, String(old.newestAgeMonths));

  const aging = window([page('2025-01-15'), page('2019-05-01')], 'latest quantum error correction results');
  check('a newest page inside the aging tier is flagged too', aging.stale === true && aging.newestAgeMonths === 22, String(aging.newestAgeMonths));

  const stale = window([page('2021-01-15')], 'latest quantum error correction results');
  check('an old newest page is flagged', stale.stale === true && stale.newestAgeMonths === 70, String(stale.newestAgeMonths));
}

// ── 4. recency asked, nothing to answer with ───────────────────────────────
{
  const undated = window([page(undefined, 'A'), page('not a date', 'B')], 'what changed this week');
  check('"this week" counts as recency-seeking', undated.wantsRecent === true);
  check('undated pages cannot answer it and say so', undated.stale === true && undated.dated === 0);
  check('with no date there is no age to report', undated.newestAgeMonths === null && undated.newest === null);
}

// ── 5. the intent signal is the ranking's, not a second one ────────────────
{
  check('a year in the query is recency-seeking', window([page('2020-01-01')], 'quantum error correction 2026').wantsRecent === true);
  check('an identifier year is not', window([page('2020-01-01')], 'CVE-2024-3094 details').wantsRecent === false);
  check('"history of" is not', window([page('2020-01-01')], 'history of quantum error correction').wantsRecent === false);
  check('the older wording "recently" is', window([page('2020-01-01')], 'what was recently announced').wantsRecent === true);
}

// ── 6. when the line earns its place ──────────────────────────────────────
{
  check('a recent, tight, dated window stays quiet', window([page('2026-09-01'), page('2026-08-01')]).notable === false);
  check(
    'a recency query speaks up even when it was answered well',
    window([page('2026-09-01')], 'latest quantum results').notable === true,
  );
  const wide = window([page('2015-01-01'), page('2026-01-01')]);
  check('a window spanning many years speaks up', wide.notable === true && wide.spanYears === 11, `${wide.spanYears}`);
  check('a narrow window does not', window([page('2024-01-01'), page('2026-01-01')]).notable === false);
  check(
    'mostly undated sources speak up',
    window([page('2024-01-01'), page(undefined, 'B'), page(undefined, 'C')]).notable === true,
  );
  check('an even split does not', window([page('2024-01-01'), page(undefined, 'B')]).notable === false);
  check('a wholly undated answer speaks up', window([page(undefined, 'A')]).notable === true);
  check('an answer with no sources says nothing', window([]).notable === false);
}

// ── 7. the hover keeps the whole window ───────────────────────────────────
{
  const mixed = window(
    [page('2019-05-01'), page('2026-08-02'), page(undefined, 'Undated')],
    'latest quantum error correction results',
  );
  const text = describeFreshness(mixed);
  check('the hover names both ends', text.includes('2019-05-01 → 2026-08-02'), text);
  check('and the span and both counts', /spanning 7 years/.test(text) && /2 dated/.test(text) && /1 undated/.test(text), text);
  check('a recency window says whether it was answered', /newest page is recent/.test(text), text);

  const old = window([page('2019-05-01')], 'latest quantum results');
  check('an unfulfilled recency window names the age', /newest page is 90 months old/.test(describeFreshness(old)), describeFreshness(old));

  const undatedOnly = describeFreshness(window([page(undefined, 'A')]));
  check('a date-less answer explains itself', /No source carries a publication date/.test(undatedOnly), undatedOnly);
}

const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) process.exit(1);
