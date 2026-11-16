// A search must not depend on a keyed engine to render anything. This pins the fallback set: every
// member answers without a provider key, the selected engines are not repeated, and preference
// order is stable so a retry is predictable.
// Run: node experiments/search-fallback.test.mjs

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const OUT = (process.env.ENGINES_MODULE ?? '/tmp/fieldwork-engines.mjs').replaceAll('\\', '/');
const ESBUILD = `${process.cwd()}/node_modules/esbuild/bin/esbuild`.replaceAll('\\', '/');
execFileSync(
  process.execPath,
  [ESBUILD, 'src/lib/engines.ts', '--bundle', '--format=esm', `--outfile=${OUT}`, '--log-level=error'],
  { stdio: 'inherit' },
);

const { ENGINE_CATALOG, KEYLESS_ENGINES, fallbackEnginesFor } = await import(`${pathToFileURL(OUT).href}?t=${Date.now()}`);

// engines that need a provider secret to answer at all
const KEYED = ['exa', 'tavily', 'google', 'brave', 'searxng', 'firecrawl', 'shodan', 'urlscan'];

check('the fallback set is not empty', KEYLESS_ENGINES.length >= 4, String(KEYLESS_ENGINES.length));
check('no keyed engine is in the fallback set', KEYLESS_ENGINES.every((engine) => !KEYED.includes(engine)), JSON.stringify(KEYLESS_ENGINES));
check('every fallback engine exists in the catalogue', KEYLESS_ENGINES.every((engine) => ENGINE_CATALOG.some((entry) => entry.id === engine)), JSON.stringify(KEYLESS_ENGINES));
check('the fallback set has no duplicates', new Set(KEYLESS_ENGINES).size === KEYLESS_ENGINES.length);

// selection behaviour
const spare = fallbackEnginesFor(['exa', 'tavily']);
check('the selected engines are not retried', !spare.includes('exa') && !spare.includes('tavily'));
check('the preference order is preserved', JSON.stringify(spare) === JSON.stringify(KEYLESS_ENGINES), JSON.stringify(spare));
const partly = fallbackEnginesFor(['duckduckgo', 'arxiv']);
check('already-tried keyless engines are skipped', !partly.includes('duckduckgo') && !partly.includes('arxiv') && partly.includes('wikipedia'), JSON.stringify(partly));
check('selecting the whole set leaves nothing to retry', fallbackEnginesFor([...KEYLESS_ENGINES]).length === 0);
check('gapless selection still offers the rest', fallbackEnginesFor([]).length === KEYLESS_ENGINES.length);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) process.exit(1);
