// Whether the composer can tell an engine is unusable before it runs.
// Run: npm run smoke, which bundles both modules inside the project (so their external
// `react` resolves) and sets KEYSTATUS_MODULE and KEYROW_MODULE to them
import { bundle, tmpPath } from './lib/build.mjs';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

// smoke passes plain paths; `import()` needs a URL when that path is a Windows one
const asUrl = (path) => (path.startsWith('file:') ? path : pathToFileURL(path).href);

const modulePath = asUrl(process.env.KEYSTATUS_MODULE ?? tmpPath('engine-key-status.mjs'));
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

// 2b. a spare key is the same provider's key: a numbered name alone still counts as ready, and
// having two is worth saying because the function rotates rather than picking one
{
  check('a numbered key still makes the engine ready', engineKeyStatus('exa', stored('EXA_API_KEY_2'))?.state === 'ready');
  const two = engineKeyStatus('exa', stored('EXA_API_KEY', 'EXA_API_KEY_1'));
  check('two keys are reported as a rotation', /2 keys, tried in order/.test(two?.detail ?? ''), two?.detail);
  const one = engineKeyStatus('exa', stored('EXA_API_KEY'));
  check('a single key says nothing about rotation', one?.detail === 'Using your EXA_API_KEY.', one?.detail);
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

// 5d. when the deployment says it holds the secret, "unknown" becomes a fact
{
  const held = stored('EXA_API_KEY');
  const viaDeployment = engineKeyStatus('exa', stored(), [], held);
  check('a deployment-held key reports deployment', viaDeployment?.state === 'deployment', viaDeployment?.state);
  check('deployment text says whose key it is', /deployment key/.test(viaDeployment?.text ?? ''), viaDeployment?.text);

  const halfPair = engineKeyStatus('google', stored(), [], stored('GOOGLE_API_KEY'));
  check('half a deployment pair is not deployment-ready', halfPair?.state === 'unknown', halfPair?.state);

  const personal = engineKeyStatus('exa', stored('EXA_API_KEY'), [], held);
  check('a personal key outranks the deployment copy', personal?.state === 'ready', personal?.state);

  const askedButSilent = engineKeyStatus('exa', stored(), [], null);
  check('no answer from the function stays unknown', askedButSilent?.state === 'unknown', askedButSilent?.state);

  const forwarded = engineKeyRow(['tavily'], stored(), [], stored('TAVILY_API_KEY'));
  check('engineKeyRow forwards the deployment set', forwarded[0]?.state === 'deployment', forwarded[0]?.state);
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

// 11. the lane yield strip. Two kinds of loss, two kinds of chip: a lane that answered with nothing
// at all, and a lane that answered but had results thrown away — the second is the one that has to
// be openable, because a count on its own cannot be judged.
{
  // smoke builds this so a bundling error fails the step it belongs to; run standalone and it builds
  // itself, in the project, so an external `react` resolves to the copy the render uses
  const out = process.env.LANE_MODULE ?? 'node_modules/.cache/fieldwork/lane-yield-row.mjs';
  if (!process.env.LANE_MODULE) {
    mkdirSync('node_modules/.cache/fieldwork', { recursive: true });
    bundle('src/components/LaneYieldRow.tsx', out, ['--jsx=automatic', '--external=react', '--external=react-dom']);
  }

  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const laneModule = process.env.LANE_MODULE ? out : `${process.cwd()}/${out}`.replaceAll('\\', '/');
  const { LaneYieldRow } = await import(asUrl(laneModule));

  const render = (props) => renderToStaticMarkup(React.createElement(LaneYieldRow, props));
  const mixed = render({
    laneYield: [
      { lane: 'exa', engine: 'exa', returned: 5, kept: 3, offTopic: 2, dropped: [{ title: 'Roman Republic', rel: 0 }] },
      { lane: 'tavily', engine: 'tavily', returned: 0, kept: 0, offTopic: 0, dropped: [] },
    ],
  });

  check('render: a wasted lane shows kept out of returned', /Exa[\s\S]{0,120}3\/5/.test(mixed));
  check('render: the wasted chip is a collapsed disclosure button', /<button[^>]*aria-expanded="false"/.test(mixed));
  check(
    'render: its tooltip says how many were dropped of how many',
    /title="2 of 5 results from Exa were dropped/.test(mixed),
  );
  check('render: a dead lane says no results rather than 0/0', /Tavily[\s\S]{0,120}no results/.test(mixed));
  check('render: the dead lane is not a button', !/no results<\/span>\s*<\/button>/.test(mixed));
  check('render: the strip labels itself', /Lane yield/.test(mixed));
  check('render: dropped titles stay hidden until the chip is opened', !/Roman Republic/.test(mixed));

  const quiet = render({ laneYield: [{ lane: 'exa', engine: 'exa', returned: 4, kept: 4, offTopic: 0, dropped: [] }] });
  check('render: a clean run renders nothing', quiet === '', JSON.stringify(quiet));

  const explained = render({
    laneYield: [{ lane: 'tavily', engine: 'tavily', returned: 0, kept: 0, offTopic: 0, dropped: [] }],
    issues: [{ engine: 'tavily', name: 'Tavily', status: 'missing_key', label: 'missing key', detail: '', severity: 'warning' }],
  });
  check('render: an engine already reported as broken is not also called dead', !/no results/.test(explained), explained);
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
process.exit(failed.length ? 1 : 0);
