// The paste box writes rows the search function reads by name, so a parser mistake either stores
// a key the function never looks for or silently drops one.
import { execFileSync } from 'node:child_process';

const OUT = '/tmp/fieldwork-provider-keys.mjs';
execFileSync('npx', ['--yes', 'esbuild', 'src/lib/providerKeys.ts', '--bundle', '--format=esm', `--outfile=${OUT}`, '--log-level=error'], {
  stdio: 'inherit',
});
const { parseProviderKeys, describeKeys, PROVIDER_KEYS } = await import(`${OUT}?t=${Date.now()}`);

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

check('describes a paste by provider label', describeKeys([{ name: 'EXA_API_KEY', value: 'x' }]) === 'Exa');
check('catalogues Google as two secrets', PROVIDER_KEYS.filter((key) => key.engine === 'google').length === 2);

console.log(`\n${passed}/${passed + failures.length} assertions passed`);
if (failures.length > 0) process.exit(1);
