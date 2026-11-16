// The paste box writes rows the search function reads by name, so a parser mistake either stores
// a key the function never looks for or silently drops one.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// the local esbuild entry point under node directly: `npx` cannot be spawned from cmd.exe
const OUT = (process.env.PROVIDER_KEYS_MODULE ?? '/tmp/fieldwork-provider-keys.mjs').replaceAll('\\', '/');
const ESBUILD = `${process.cwd()}/node_modules/esbuild/bin/esbuild`.replaceAll('\\', '/');
execFileSync(
  process.execPath,
  [ESBUILD, 'src/lib/providerKeys.ts', '--bundle', '--format=esm', `--outfile=${OUT}`, '--log-level=error'],
  { stdio: 'inherit' },
);
const { parseProviderKeys, describeKeys, PROVIDER_KEYS } = await import(`${pathToFileURL(OUT).href}?t=${Date.now()}`);

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const basic = parseProviderKeys('EXA_API_KEY=exa-1234567890\nTAVILY_API_KEY: tvly-1234567890');
check('accepts = and : separators', basic.keys.length === 2, JSON.stringify(basic.keys.map((k) => k.name)));
check('keeps the env-var name verbatim', basic.keys[0].name === 'EXA_API_KEY', basic.keys[0].name);
check('keeps the value verbatim', basic.keys[1].value === 'tvly-1234567890', basic.keys[1].value);

const messy = parseProviderKeys('  export GOOGLE_CSE_ID = "abc123def456"  \n# comment\n\nSHODAN_API_KEY=abcdef123456');
check('handles export, quotes and blank lines', messy.keys.length === 2 && messy.keys[0].value === 'abc123def456', JSON.stringify(messy.keys));
check('ignores comments', messy.keys.every((key) => !key.value.startsWith('#')));

const unknown = parseProviderKeys('OPENAI_API_KEY=sk-abcdefghijklmnop');
check('rejects names the function does not read', unknown.keys.length === 0 && unknown.rejected[0] === 'OPENAI_API_KEY', JSON.stringify(unknown));

const short = parseProviderKeys('EXA_API_KEY=abc');
check('rejects a value that cannot be a key', short.keys.length === 0 && short.invalid[0] === 'EXA_API_KEY', JSON.stringify(short));

const url = parseProviderKeys('SEARXNG_URL=not-a-url.example\nTAVILY_API_KEY=tvly-1234567890');
check('requires http(s) for URL secrets', url.keys.length === 1 && url.keys[0].name === 'TAVILY_API_KEY', JSON.stringify(url.keys));
check('reports the bad URL', url.invalid.includes('SEARXNG_URL'), JSON.stringify(url.invalid));

const duplicate = parseProviderKeys('EXA_API_KEY=first-1234567\nEXA_API_KEY=second-1234567');
check('keeps the first of duplicate names', duplicate.keys.length === 1 && duplicate.keys[0].value === 'first-1234567', duplicate.keys[0]?.value);

const structural = parseProviderKeys('this line has no separator at all');
check('reports a line with no separator', structural.invalid.length === 1 && structural.keys.length === 0);

const empty = parseProviderKeys('   \n\n');
check('returns nothing for an empty paste', empty.keys.length === 0 && empty.invalid.length === 0 && empty.rejected.length === 0);

// numbered names: people label their keys, and the function only reads the documented name
const numbered = parseProviderKeys('EXA_API_KEY_1=exa-1234567890');
check('a numbered name is accepted', numbered.keys.length === 1 && numbered.rejected.length === 0, JSON.stringify(numbered));
check('and stored under the documented name', numbered.keys[0]?.name === 'EXA_API_KEY', numbered.keys[0]?.name);
check('and the mapping is reported back', numbered.aliased[0]?.from === 'EXA_API_KEY_1' && numbered.aliased[0]?.to === 'EXA_API_KEY', JSON.stringify(numbered.aliased));

const numberedLower = parseProviderKeys('exa_api_key_2=exa-1234567890');
check('numbering works in lower case', numberedLower.keys[0]?.name === 'EXA_API_KEY' && numberedLower.aliased.length === 1);

const numberedDup = parseProviderKeys('EXA_API_KEY_1=first-1234567\nEXA_API_KEY_2=second-1234567');
check('two variants of one secret save one row, first wins', numberedDup.keys.length === 1 && numberedDup.keys[0].value === 'first-1234567', JSON.stringify(numberedDup.keys));

const numberedUrl = parseProviderKeys('SEARXNG_URL_1=https://searx.example');
check('a numbered URL secret keeps URL validation', numberedUrl.keys[0]?.name === 'SEARXNG_URL' && numberedUrl.invalid.length === 0, JSON.stringify(numberedUrl));

const numberedBadUrl = parseProviderKeys('SEARXNG_URL_2=not-a-url.example');
check('a bad numbered URL is reported as typed', numberedBadUrl.invalid[0] === 'SEARXNG_URL_2', JSON.stringify(numberedBadUrl.invalid));

const numberedShort = parseProviderKeys('EXA_API_KEY_3=abc');
check('a bad numbered value is reported as typed', numberedShort.invalid[0] === 'EXA_API_KEY_3' && numberedShort.keys.length === 0, JSON.stringify(numberedShort.invalid));

// numbering must not turn an unknown name into a guess
const numberedUnknownBase = parseProviderKeys('EXA_KEY_1=exa-1234567890');
check('an unknown base is still rejected', numberedUnknownBase.keys.length === 0 && numberedUnknownBase.rejected[0] === 'EXA_KEY_1', JSON.stringify(numberedUnknownBase));
const numberedWord = parseProviderKeys('EXA_API_KEY_TWO=exa-1234567890');
check('a non-numeric suffix is not stripped', numberedWord.keys.length === 0 && numberedWord.rejected[0] === 'EXA_API_KEY_TWO', JSON.stringify(numberedWord));
const unnumbered = parseProviderKeys('EXA_API_KEY=exa-1234567890');
check('an exact name records no alias', unnumbered.aliased.length === 0);

check('describes a paste by provider label', describeKeys([{ name: 'EXA_API_KEY', value: 'x' }]) === 'Exa');
check('catalogues Google as two secrets', PROVIDER_KEYS.filter((key) => key.engine === 'google').length === 2);

console.log(`\n${passed}/${passed + failures.length} assertions passed`);
if (failures.length > 0) process.exit(1);
