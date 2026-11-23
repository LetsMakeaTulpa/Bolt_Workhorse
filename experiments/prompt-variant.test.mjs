// The prompt must be swappable without a code change, and swappable *safely*: blank text has to
// mean "built-in", a variant has to stay per account, and a broken storage must not break answering.
// Run: node experiments/prompt-variant.test.mjs

import { tmpPath, ESBUILD } from './lib/build.mjs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const OUT = (process.env.VARIANT_MODULE ?? tmpPath('fieldwork-prompt-variant.mjs')).replaceAll('\\', '/');
execFileSync(
  process.execPath,
  [ESBUILD, 'src/lib/promptVariant.ts', '--bundle', '--format=esm', `--outfile=${OUT}`, '--log-level=error'],
  { stdio: 'inherit' },
);

const {
  ANSWER_BUDGET_WORDS,
  clearPromptVariant,
  describePromptVariant,
  promptStorageKey,
  promptWordCount,
  readPromptVariant,
  savePromptVariant,
  systemPromptFor,
} = await import(`${pathToFileURL(OUT).href}?t=${Date.now()}`);
// this suite used to import the system-prompt bundle the *other* suite happened to leave in the
// cache, so a clean cache failed here and nowhere else. It builds the module it compares against.
const PROMPT_OUT = (process.env.SYSTEM_PROMPT_MODULE ?? tmpPath('system-prompt.mjs')).replaceAll('\\', '/');
execFileSync(
  process.execPath,
  [ESBUILD, 'src/lib/systemPrompt.ts', '--bundle', '--format=esm', `--outfile=${PROMPT_OUT}`, '--log-level=error'],
  { stdio: 'inherit' },
);
const { FIELDWORK_SYSTEM_PROMPT } = await import(`${pathToFileURL(PROMPT_OUT).href}?t=${Date.now()}`);

const memoryStorage = () => {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    size: () => map.size,
  };
};

const user = 'user-a';
const other = 'user-b';

// 1. nothing stored means the built-in prompt, by identity
check('an untouched account uses the built-in prompt', systemPromptFor(user, memoryStorage()) === FIELDWORK_SYSTEM_PROMPT);
check('reading an untouched account returns null', readPromptVariant(user, memoryStorage()) === null);

// 2. a saved variant is what gets sent, verbatim (newlines and all)
const storage = memoryStorage();
const variant = 'You are Fieldwork, testing variant B.\n\nKeep answers to 80 words.';
savePromptVariant(user, variant, storage);
check('the variant is read back verbatim', readPromptVariant(user, storage) === variant);
check('the variant is what answers', systemPromptFor(user, storage) === variant);

// 3. blank text clears rather than saving an empty prompt
savePromptVariant(user, '   \n\n  ', storage);
check('whitespace-only text restores the built-in prompt', systemPromptFor(user, storage) === FIELDWORK_SYSTEM_PROMPT);
check('and leaves nothing behind', readPromptVariant(user, storage) === null, `keys=${storage.size()}`);

// 4. variants are per account, and anonymous is its own account
savePromptVariant(user, 'variant for A', storage);
check('another account keeps the built-in prompt', systemPromptFor(other, storage) === FIELDWORK_SYSTEM_PROMPT);
check('anonymous is not the same slot', systemPromptFor(undefined, storage) === FIELDWORK_SYSTEM_PROMPT);
savePromptVariant(undefined, 'variant for anonymous', storage);
check('the anonymous slot can hold its own variant', systemPromptFor(undefined, storage) === 'variant for anonymous');
check('and does not leak into a signed-in account', systemPromptFor(other, storage) === FIELDWORK_SYSTEM_PROMPT);
check('the storage key names the account', promptStorageKey(user) !== promptStorageKey(other) && promptStorageKey(user).endsWith(user));

// 5. explicit reset
clearPromptVariant(user, storage);
check('clearing restores the built-in prompt', systemPromptFor(user, storage) === FIELDWORK_SYSTEM_PROMPT);

// 6. word counting drives the budget warning
check('the built-in prompt counts its words', promptWordCount(FIELDWORK_SYSTEM_PROMPT) > 380 && promptWordCount(FIELDWORK_SYSTEM_PROMPT) < 450, String(promptWordCount(FIELDWORK_SYSTEM_PROMPT)));
check('blank text counts zero words', promptWordCount('  \n ') === 0);
check('describing nothing reports the default', describePromptVariant(null).source === 'default' && describePromptVariant(null).overBudget === false);
const long = Array.from({ length: ANSWER_BUDGET_WORDS + 25 }, () => 'word').join(' ');
check('a variant over the ceiling is flagged', describePromptVariant(long).overBudget === true && describePromptVariant(long).source === 'variant');
check('a variant inside the ceiling is not', describePromptVariant('short variant prompt').overBudget === false);
check('the ceiling matches the prompt the model is given', ANSWER_BUDGET_WORDS === 600);

// 7. a hostile storage must not break answering
const hostile = {
  getItem: () => { throw new Error('blocked'); },
  setItem: () => { throw new Error('quota'); },
  removeItem: () => { throw new Error('blocked'); },
};
check('a throwing storage reads as the built-in prompt', systemPromptFor(user, hostile) === FIELDWORK_SYSTEM_PROMPT);
let threw = false;
try {
  savePromptVariant(user, 'variant', hostile);
  clearPromptVariant(user, hostile);
} catch {
  threw = true;
}
check('a throwing storage swallows the write', threw === false);
check('no storage at all still answers', systemPromptFor(user, null) === FIELDWORK_SYSTEM_PROMPT);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) process.exit(1);
