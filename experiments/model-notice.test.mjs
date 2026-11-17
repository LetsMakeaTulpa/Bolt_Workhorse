// The banner that says which model actually answered. It exists because the same fact in the
// activity log is only visible to someone who opens that tab, while it changes how the answer above
// it should be read.
// Run: node experiments/model-notice.test.mjs (standalone; smoke also bundles the module)
import { bundle } from './lib/build.mjs';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const asUrl = (path) => (path.startsWith('file:') ? path : pathToFileURL(path).href);

const out = process.env.MODEL_NOTICE_MODULE ?? 'node_modules/.cache/fieldwork/model-notice.mjs';
if (!process.env.MODEL_NOTICE_MODULE) {
  mkdirSync('node_modules/.cache/fieldwork', { recursive: true });
  // colon, not `=`: esbuild rejects `--external=x` for repeatable flags
  bundle('src/components/ModelNotice.tsx', out, ['--jsx=automatic', '--external:react', '--external:react-dom']);
}

const React = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { ModelNoticeBanner } = await import(asUrl(process.env.MODEL_NOTICE_MODULE ? out : `${process.cwd()}/${out}`.replaceAll('\\', '/')));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const render = (notice, onDismiss) => renderToStaticMarkup(React.createElement(ModelNoticeBanner, { notice, onDismiss }));
const ASKED = 'xortron/RESTRICTED-RESEARCH-MODEL';
const ANSWERED = 'Qwen/Qwen2.5-7B-Instruct';

// 1. a fallback: both models are named, and the reason is shown when there is one
{
  const html = render({ kind: 'fallback', from: ASKED, to: ANSWERED, reason: 'HTTP 503 (capacity_exhausted)' }, () => {});
  check('a fallback names the model that was asked for', html.includes(ASKED), ASKED);
  check('a fallback names the model that answered', html.includes(ANSWERED), ANSWERED);
  check('a fallback says which one answered', /answered on <\/?[^>]*>?/i.test(html) || /answered on/.test(html));
  check('the reason is shown, not just the switch', html.includes('Reason: HTTP 503 (capacity_exhausted)'), html.match(/Reason:[^<]*/)?.[0]);
  check('the banner is announced to assistive tech', /role="status"/.test(html) && /aria-live="polite"/.test(html));
  check('the full sentence is in a tooltip too', new RegExp(`title="${ASKED} unavailable — answered on ${ANSWERED}"`).test(html), html.match(/title="[^"]*"/)?.[0]);
}

// 2. no reason: the line is absent rather than empty
{
  const html = render({ kind: 'fallback', from: ASKED, to: ANSWERED }, () => {});
  check('a fallback without a reason shows no empty reason line', !/Reason:/.test(html));
  check('the switch is still named', html.includes(ANSWERED) && html.includes(ASKED));
}

// 3. the provider served another model: the wording says the answer came from it
{
  const html = render({ kind: 'served', from: ASKED, to: ANSWERED }, () => {});
  check('a served-model notice says it is not what was selected', /Provider answered as Qwen\/Qwen2\.5-7B-Instruct, not xortron\/RESTRICTED-RESEARCH-MODEL/.test(html), html.match(/Provider answered[^<]*/)?.[0]);
  check('and says the answer came from the served model', /this answer came from Qwen\/Qwen2\.5-7B-Instruct/.test(html));
  check('the served notice carries no "unavailable" claim', !/unavailable/.test(html));
}

// 4. the dismiss control exists, and is only actionable when something can act on it
{
  const withHandler = render({ kind: 'fallback', from: ASKED, to: ANSWERED }, () => {});
  check('a dismiss control is labelled', /aria-label="Dismiss model notice"/.test(withHandler));
  check('the dismiss control is enabled with a handler', !/disabled=""/.test(withHandler));
  const withoutHandler = render({ kind: 'fallback', from: ASKED, to: ANSWERED });
  check('the dismiss control is disabled without one', /disabled=""/.test(withoutHandler));
}

// 5. a long model id is clipped visually, with the whole sentence kept in the tooltip
{
  const long = { kind: 'fallback', from: ASKED, to: `${'org/'}${'x'.repeat(120)}` };
  const html = render(long, () => {});
  check('a long model id is clipped by CSS', /truncate/.test(html));
  check('the untruncated sentence survives in the tooltip', html.includes(`answered on ${long.to}`));
}

const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) process.exit(1);
