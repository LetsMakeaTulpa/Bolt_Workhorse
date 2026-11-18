// The source card's badge row, rendered against title and date combinations that change which
// badges appear and what they say. The badges must agree with the ranking, so the dates here are
// relative to now: freshness is a property of the age, not of a fixed calendar day.
// Run: node experiments/source-card.test.mjs (standalone; smoke also bundles the module)
import { bundle } from './lib/build.mjs';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const asUrl = (path) => (path.startsWith('file:') ? path : pathToFileURL(path).href);

const out = process.env.SOURCE_CARD_MODULE ?? 'node_modules/.cache/fieldwork/source-card.mjs';
if (!process.env.SOURCE_CARD_MODULE) {
  mkdirSync('node_modules/.cache/fieldwork', { recursive: true });
  // colon, not `=`: esbuild rejects `--external=x` for repeatable flags
  bundle('src/components/SourceCard.tsx', out, ['--jsx=automatic', '--external:react', '--external:react-dom']);
}

const React = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { SourceCard } = await import(asUrl(process.env.SOURCE_CARD_MODULE ? out : `${process.cwd()}/${out}`.replaceAll('\\', '/')));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const render = (source) => renderToStaticMarkup(React.createElement(SourceCard, { source }));
const renderRanked = (source, rank) => renderToStaticMarkup(React.createElement(SourceCard, { source, rank }));
const ago = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
const card = (overrides = {}) => ({
  title: 'Reciprocal rank fusion, explained',
  url: 'https://example.org/rrf',
  snippet: 'A short explanation of RRF.',
  source_engine: 'exa',
  citation_id: '[1]',
  relevance_score: 0.0328,
  query: 'latest AI regulation news 2026',
  ...overrides,
});
const badges = (html) => (html.match(/<span[^>]*class="[^"]*rounded border[^"]*"[^>]*>[^<]*<svg[\s\S]*?<\/svg>[\s\S]*?<\/span>/g) ?? []);

// 1. a fresh date on a recency-seeking query: full boost, and the chip is the olive one
{
  const html = render(card({ published: ago(3) }));
  check('fresh date shows the date and the full multiplier', /2026-\d\d-\d\d ×1\.60/.test(html) || /20\d\d-\d\d-\d\d ×1\.60/.test(html), html.match(/20\d\d-\d\d-\d\d ×[\d.]+/)?.[0]);
  check('the fresh chip is the highlighted one', /border-olive\/30 bg-olive-subtle text-olive/.test(html));
  check('the fresh chip is not the neutral one', !/border-border-subtle text-text-muted/.test(html.split('Reciprocal rank fusion')[1] ?? ''));

  const detail = html.match(/title="Published[^"]*"/)?.[0] ?? '';
  check('the chip tooltip explains the multiplier', /freshness ×1\.60/.test(detail), detail);
  check('the chip tooltip names the age in days', /\(3d ago\)/.test(detail), detail);
}

// 2. an old date on the same query: still a multiplier, but no longer highlighted
{
  const html = render(card({ published: ago(400) }));
  check('an ageing date shows its own multiplier', /20\d\d-\d\d-\d\d ×1\.\d\d/.test(html) && !/×1\.60/.test(html), html.match(/20\d\d-\d\d-\d\d ×[\d.]+/)?.[0]);
  check('an ageing date is the neutral chip', /border-border-subtle text-text-muted/.test(html));
  check('the tooltip calls it months old', /mo ago/.test(html));
}

// 3. a dated source on a query that is not recency-seeking: the date is shown but explicitly ignored
{
  const html = render(card({ published: ago(2), query: '' }));
  check('a non-recency query marks the date ignored', /20\d\d-\d\d-\d\d ignored/.test(html), html.match(/20\d\d-\d\d-\d\d [a-z]+/)?.[0]);
  check('an ignored date carries no multiplier', !/20\d\d-\d\d-\d\d ×/.test(html));
  check('the tooltip says the date did not move the result', /did not move the result/.test(html));
}

// 4. no date at all, and a date nothing can parse
{
  const html = render(card({ published: undefined }));
  check('an undated source says so', /no date/.test(html));
  check('an undated chip has no multiplier', !/no date[^<]*×/.test(html) && !/×[\d.]+[^<]*no date/.test(html));
  check('the undated tooltip explains itself', /No publication date/.test(html));

  const junk = render(card({ published: 'sometime last spring' }));
  check('an unparseable date falls back to the same chip', /no date/.test(junk));
}

// 5. the score badge appears only when there is a score worth showing
{
  check('a positive score renders four decimals', /RRF 0\.0328/.test(render(card())));
  check('a zero score is omitted', !/RRF \d\.\d{4}/.test(render(card({ relevance_score: 0 }))));
  check('an absent score is omitted', !/RRF \d\.\d{4}/.test(render(card({ relevance_score: undefined }))));
}

// 6. the routing badge follows the engine's weight for this query, not the engine alone
{
  const exaFresh = render(card({ published: ago(3) }));
  check('a damped engine is labelled with its weight', /recency-seeking · exa ×\d\.\d\d/.test(exaFresh), exaFresh.match(/recency-seeking · exa ×[\d.]+/)?.[0]);
  check('a damped engine is the warning tone', /border-warning\/30 bg-warning-subtle text-warning/.test(exaFresh));
  check(
    'the routing tooltip names the flat base and the delta',
    /flat base of ×1\.20 \(-0\.20\)/.test(exaFresh),
    exaFresh.match(/exa weighted[^"]*/)?.[0],
  );

  const tavilyFresh = render(card({ source_engine: 'tavily', published: ago(3) }));
  check('a raised engine is the accent tone', /border-accent\/30 bg-accent-subtle text-accent/.test(tavilyFresh));
  check('tavily is weighted above one for a fresh query', /recency-seeking · tavily ×1\.\d\d/.test(tavilyFresh), tavilyFresh.match(/· tavily ×[\d.]+/)?.[0]);

  const fused = render(card({ source_engine: 'exa+tavily' }));
  check('a fused result is labelled by its primary engine', /· exa ×/.test(fused) && !/· exa\+tavily/.test(fused));

  const unknown = render(card({ source_engine: '' }));
  check('an engine with no weight gets no routing badge', !/· exa ×/.test(unknown) && !/Sparkles/.test(unknown));
}

// 7. titles: long, quoted, unicode and empty all render without breaking the row
{
  const long = 'A very long title that keeps going well past the two lines the card allows, mentioning reciprocal rank fusion, engine weighting, and publication dates in one breath';
  const html = render(card({ title: long, published: ago(3) }));
  check('a long title is rendered whole and clipped by CSS only', html.includes(long.slice(0, 60)) && /line-clamp-2/.test(html));
  check('the badges still render under a long title', /×1\.60/.test(html) && /RRF 0\.0328/.test(html));

  const quoted = render(card({ title: 'The "RRF" paper & its critics <part 2>', published: ago(3) }));
  check('quotes and ampersands are escaped, not injected', /The &quot;RRF&quot; paper &amp; its critics/.test(quoted) && !/<part 2>/.test(quoted));

  const unicode = render(card({ title: '再帰的ランク融合 — eine Einführung', published: ago(3) }));
  check('a non-latin title survives intact', unicode.includes('再帰的ランク融合 — eine Einführung'));

  const untitled = render(card({ title: '', published: ago(3) }));
  check('an empty title still renders the badge row', /<h4[^>]*><\/h4>/.test(untitled) && /×1\.60/.test(untitled));
}

// 8. the citation marker is optional, and the card is always one link to the source
{
  const html = render(card({ published: ago(3) }));
  check('a citation id is shown before the title', /\[1\]<\/span><h4/.test(html.replace(/\s+/g, '')) || /\[1\]/.test(html));
  check('no citation id leaves no marker', !/\[1\]/.test(render(card({ citation_id: '' }))));
  check('the whole card is one external link', /^<a [^>]*href="https:\/\/example.org\/rrf"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/.test(html));
  check('both badges sit in one wrapping row', /flex flex-wrap items-center gap-1/.test(html) && badges(html).length === 2);
}

// 9. the rank chip: the panel is sorted by score, so the number has to be the first thing in the
// badge row and match the position the reader is looking at
{
  const html = renderRanked(card({ published: ago(3) }), 2);
  check('a ranked card shows its position', />#2</.test(html));
  check('the position comes before the score it explains', html.indexOf('#2') < html.indexOf('RRF 0.0328'));
  check(
    'the position is the first chip of the row',
    /text-\[9px\]">\s*<span class="rounded border[^"]*"[^>]*title="Position 2/.test(html),
    html.match(/text-\[9px\]">[\s\S]{0,160}/)?.[0],
  );
  check('the position tooltip says what it counts', /Position 2 in this list, highest fusion score first/.test(html));
  // the rank chip carries no icon, so count raw chips here rather than `badges()`, which keys on the svg
  check(
    'all three chips share the wrapping row',
    (html.match(/<span[^>]*class="[^"]*rounded border/g) ?? []).length === 3,
    String((html.match(/<span[^>]*class="[^"]*rounded border/g) ?? []).length),
  );
  check('an unranked card shows no position', !/>#\d+</.test(render(card({ published: ago(3) }))));
}

// 10. whether the prompt carried the source: the one line in the panel between evidence and results
{
  const shown = render(card({ in_prompt: true }));
  check('a source the prompt carried says so', /<\/svg>in prompt</.test(shown), shown.match(/<\/svg>[^<]*/)?.[0]);
  check('the model-visible mark is the accent one', /border-accent\/30 bg-accent-subtle text-accent/.test(shown));
  check('its tooltip says the model could read it', /carried this source to the model/.test(shown));

  const hidden = render(card({ in_prompt: false }));
  check('a panel-only source says the model never saw it', /<\/svg>panel only</.test(hidden), hidden.match(/<\/svg>[^<]*/)?.[0]);
  check('the panel-only mark is the warning tone', /border-warning\/30 bg-warning-subtle text-warning/.test(hidden));
  check('its tooltip names the consequence', /never saw it/.test(hidden));

  const unknown = render(card({}));
  check('a row with no recorded verdict carries no mark', !/>in prompt</.test(unknown) && !/>panel only</.test(unknown));
  check('and the unmarked card keeps its badges unchanged', badges(unknown).length === 2, String(badges(unknown).length));
}

const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) process.exit(1);
