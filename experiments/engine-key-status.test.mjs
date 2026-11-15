// Whether the composer can tell an engine is unusable before it runs.
// Run: npx esbuild src/lib/engineKeyStatus.ts --bundle --format=esm --outfile=/tmp/engine-key-status.mjs \
//        && node experiments/engine-key-status.test.mjs
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

// smoke passes plain paths; `import()` needs a URL when that path is a Windows one
const asUrl = (path) => (path.startsWith('file:') ? path : pathToFileURL(path).href);

const modulePath = asUrl(process.env.KEYSTATUS_MODULE ?? '/tmp/engine-key-status.mjs');
const { engineKeyRow, engineKeyStatus } = await import(modulePath);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const stored = (...names) => new Set(names);
const issue = (engine, status) => ({ engine, name: engine, status, label: status, detail: '', severity: 'warning' });
const stateOf = (engine, keys, issues = []) => engineKeyStatus(engine, keys, issues);

// 1. engines that never need a key
{
  const status = stateOf('duckduckgo', stored());
  check('keyless engine reports keyless', status?.state === 'keyless', status?.state);
  check('keyless engine lists no required names', status?.required.length === 0);
}

// 2. a stored key makes the engine ready
{
  const status = stateOf('exa', stored('EXA_API_KEY'));
  check('stored key reports ready', status?.state === 'ready', status?.state);
  check('ready shows the key as the account\'s own', status?.text === 'your key', status?.text);
}

// 3. Google needs both names, so half of them is not enough
{
  const status = stateOf('google', stored('GOOGLE_API_KEY'));
  check('half-configured google is partial', status?.state === 'partial', status?.state);
  check('partial names the missing half', /GOOGLE_CSE_ID/.test(status?.text ?? ''), status?.text);
  check('partial keeps what is stored', status?.stored.join(',') === 'GOOGLE_API_KEY', status?.stored.join(','));

  const both = stateOf('google', stored('GOOGLE_API_KEY', 'GOOGLE_CSE_ID'));
  check('both google names reports ready', both?.state === 'ready', both?.state);
}

// 4. a failure the function reported outranks "we do not know"
{
  const missing = stateOf('tavily', stored(), [issue('tavily', 'missing_key')]);
  check('reported missing_key is missing', missing?.state === 'missing', missing?.state);

  const unknown = stateOf('tavily', stored(), []);
  check('no key and no failure is unknown, not missing', unknown?.state === 'unknown', unknown?.state);
  check('unknown says the deployment may supply it', /deployment may supply/i.test(unknown?.detail ?? ''));
}

// 5. a saved key the function still cannot see is a setup problem, not a success
{
  const unused = stateOf('exa', stored('EXA_API_KEY'), [issue('exa', 'missing_key')]);
  check('saved but reported missing is unused', unused?.state === 'unused', unused?.state);
  check('unused suggests a redeploy', /redeploy/i.test(unused?.detail ?? ''), unused?.detail);
}

// 5b. a key the provider refused is reported as rejected, not as working
{
  const rejected = stateOf('exa', stored('EXA_API_KEY'), [issue('exa', 'key_fallback')]);
  check('a refused key shows rejected, not ready', rejected?.state === 'rejected', rejected?.state);
  check('rejected says the deployment key answered', /deployment/i.test(rejected?.detail ?? ''), rejected?.detail);

  const noPersonalKey = stateOf('tavily', stored(), [issue('tavily', 'key_fallback')]);
  check('a fallback with no stored key does not claim one', noPersonalKey?.state === 'unknown', noPersonalKey?.state);
}

// 6. urlscan works anonymously; a key only raises the limit
{
  const anonymous = stateOf('urlscan', stored());
  check('optional key engine reports optional', anonymous?.state === 'optional', anonymous?.state);
  check('optional is not reported as missing', anonymous?.state !== 'missing');
}

// 7. a key for a different engine must not count
{
  const wrong = stateOf('exa', stored('TAVILY_API_KEY'));
  check('another engine\'s key does not satisfy exa', wrong?.state === 'unknown', wrong?.state);
}

// 8. the row keeps selection order and ignores engines it does not know
{
  const row = engineKeyRow(['exa', 'duckduckgo', 'nope', 'tavily'], stored('EXA_API_KEY'));
  assert.ok(Array.isArray(row));
  check('row preserves selection order', row.map((entry) => entry.engine).join(',') === 'exa,duckduckgo,tavily', row.map((entry) => entry.engine).join(','));
  check('row drops unknown engine ids', !row.some((entry) => entry.engine === 'nope'));
  check('row states are mixed as expected', row[0].state === 'ready' && row[1].state === 'keyless', row.map((entry) => entry.state).join(','));
}

// 9. no values are ever carried: the status objects only hold names
{
  const status = stateOf('exa', stored('EXA_API_KEY'));
  const serialised = JSON.stringify(status);
  check('status carries key names, never values', status.stored.join() === 'EXA_API_KEY' && !/value/i.test(serialised));
}

// 10. the row the composer actually renders. `KEYROW_MODULE` is set by smoke, which bundles the
// component with react kept external so the test renders the same component the app mounts.
if (process.env.KEYROW_MODULE) {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { EngineKeyRow } = await import(asUrl(process.env.KEYROW_MODULE));

  const html = renderToStaticMarkup(
    React.createElement(EngineKeyRow, {
      engines: ['exa', 'google', 'duckduckgo', 'tavily'],
      storedKeys: ['EXA_API_KEY', 'GOOGLE_API_KEY'],
      issues: [{ engine: 'tavily', name: 'Tavily', status: 'missing_key', label: 'missing key', detail: '', severity: 'warning' }],
    }),
  );

  check('render: exa shows as configured', /Exa<\/span>\s*<span[^>]*>your key/.test(html), html.slice(0, 0));
  check('render: google asks for the missing CSE id', /needs GOOGLE_CSE_ID/.test(html));
  check('render: keyless engine is not flagged', /DuckDuckGo[\s\S]{0,120}keyless/.test(html));
  check('render: a reported failure shows as missing', /Tavily[\s\S]{0,120}missing key/.test(html));
  check('render: tooltips carry the required key names', /title="Using your EXA_API_KEY/.test(html));
  check('render: no secret values appear', !/value=|secret-/i.test(html));

  const empty = renderToStaticMarkup(React.createElement(EngineKeyRow, { engines: [], storedKeys: [] }));
  check('render: nothing selected renders nothing', empty === '', JSON.stringify(empty));
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
process.exit(failed.length ? 1 : 0);
