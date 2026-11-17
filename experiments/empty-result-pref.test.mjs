// The switch that decides what an empty search does: end in a gap report (the default) or let the
// model answer without sources. It is stored per device, so the parsing and the read/write pair are
// what a wrong value would break — there is no server to correct them.
// Run: node experiments/empty-result-pref.test.mjs (standalone it builds the module itself)
import { asUrl, bundle, tmpPath } from './lib/build.mjs';

const OUT = process.env.EMPTY_RESULT_PREF_MODULE ?? tmpPath('empty-result-pref.mjs');
if (!process.env.EMPTY_RESULT_PREF_MODULE) bundle('src/lib/emptyResultPref.ts', OUT);

const { EMPTY_RESULT_BLOCK_KEY, describeEmptyResultBlock, parseEmptyResultBlock, readEmptyResultBlock, writeEmptyResultBlock } =
  await import(asUrl(OUT));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// 1. nothing stored means the block is on: a new device gets the honest default
{
  check('nothing stored reads as on', parseEmptyResultBlock(null) === true);
  check('undefined reads as on', parseEmptyResultBlock(undefined) === true);
  check('an empty string reads as on', parseEmptyResultBlock('') === true);
  check('an unknown value reads as on', parseEmptyResultBlock('yes please') === true);
  check('an explicit on reads as on', parseEmptyResultBlock('on') === true);
}

// 2. only "off" turns it off, in the spellings a hand-edited value might use
{
  check('"off" turns the block off', parseEmptyResultBlock('off') === false);
  check('padding and case do not matter', parseEmptyResultBlock('  OFF ') === false);
  check('a near miss is not off', parseEmptyResultBlock('offf') === true && parseEmptyResultBlock('no') === true);
}

// 3. the label says what the setting does, both ways
{
  const on = describeEmptyResultBlock(true);
  const off = describeEmptyResultBlock(false);
  check('the on label mentions the gap report', /gap report/.test(on), on);
  check('the off label mentions an answer', /answer/.test(off), off);
  check('the two labels differ', on !== off);
}

// 4. read and write go through localStorage, and survive it being blocked
{
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };

  check('an unset key reads as on', readEmptyResultBlock() === true);
  writeEmptyResultBlock(false);
  check('turning it off stores a readable value', store.get(EMPTY_RESULT_BLOCK_KEY) === 'off' && readEmptyResultBlock() === false);
  writeEmptyResultBlock(true);
  check('turning it back on stores on', readEmptyResultBlock() === true);

  store.set(EMPTY_RESULT_BLOCK_KEY, 'off');
  check('a stored off is honoured on the next read', readEmptyResultBlock() === false);

  // a browser with storage disabled must not throw, and must keep the default
  globalThis.localStorage = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
  };
  let threw = false;
  try {
    const value = readEmptyResultBlock();
    writeEmptyResultBlock(false);
    check('blocked storage falls back to on', value === true);
  } catch {
    threw = true;
  }
  check('blocked storage does not throw', !threw);

  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
}

const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) process.exit(1);
