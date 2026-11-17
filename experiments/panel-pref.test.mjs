// The investigation panel's collapsed state is remembered per device. The failure this guards
// against is the quiet one: a wrong parse turns every reload into a collapsed panel with no obvious
// way back, or into a panel that never stays shut.
// Run: node experiments/panel-pref.test.mjs (standalone it builds the module itself)
import { asUrl, bundle, tmpPath } from './lib/build.mjs';

const OUT = process.env.PANEL_PREF_MODULE ?? tmpPath('panel-pref.mjs');
if (!process.env.PANEL_PREF_MODULE) bundle('src/lib/panelPref.ts', OUT);

const { PANEL_COLLAPSE_KEY, parsePanelCollapsed, readPanelCollapsed, writePanelCollapsed } = await import(asUrl(OUT));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// 1. nothing stored means open: the panel behaved this way before it remembered anything
{
  check('nothing stored reads as open', parsePanelCollapsed(null) === false);
  check('undefined reads as open', parsePanelCollapsed(undefined) === false);
  check('an empty string reads as open', parsePanelCollapsed('') === false);
  check('junk reads as open', parsePanelCollapsed('yes') === false && parsePanelCollapsed('{"collapsed":true}') === false);
  check('an explicit open reads as open', parsePanelCollapsed('open') === false);
}

// 2. only the word we write closes it, in the spellings a hand-edited value might take
{
  check('"collapsed" closes the panel', parsePanelCollapsed('collapsed') === true);
  check('padding and case do not matter', parsePanelCollapsed('  COLLAPSED ') === true);
  check('a near miss does not close it', parsePanelCollapsed('collapse') === false);
}

// 3. read and write go through localStorage
{
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };

  check('a fresh device opens the panel', readPanelCollapsed() === false);
  writePanelCollapsed(true);
  check('collapsing stores a readable value', store.get(PANEL_COLLAPSE_KEY) === 'collapsed' && readPanelCollapsed() === true);
  writePanelCollapsed(false);
  check('reopening stores open', store.get(PANEL_COLLAPSE_KEY) === 'open' && readPanelCollapsed() === false);
  check('a stored collapsed is honoured on the next read', (store.set(PANEL_COLLAPSE_KEY, 'collapsed'), readPanelCollapsed() === true));
  check('the key is namespaced and versioned', /^fieldwork\.panel-collapse\.v\d+$/.test(PANEL_COLLAPSE_KEY), PANEL_COLLAPSE_KEY);
}

// 4. blocked storage must not throw, and must leave the panel usable
{
  globalThis.localStorage = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
  };
  let threw = false;
  let value = null;
  try {
    value = readPanelCollapsed();
    writePanelCollapsed(true);
  } catch {
    threw = true;
  }
  check('blocked storage does not throw', !threw);
  check('blocked storage opens the panel rather than hiding it', value === false, String(value));

  // and no storage at all (a server render, or a test environment without the shim)
  delete globalThis.localStorage;
  let threwWithout = false;
  try {
    check('no storage opens the panel', readPanelCollapsed() === false);
    writePanelCollapsed(true);
  } catch {
    threwWithout = true;
  }
  check('no storage does not throw', !threwWithout);
}

const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) process.exit(1);
