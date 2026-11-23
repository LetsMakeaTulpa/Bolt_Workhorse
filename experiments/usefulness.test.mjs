// Usefulness, not relevance.
//
// Everything else an answer stores measures how well a page matched the words. Nothing measured
// whether the answer was worth having, so the engine weights and the ranking cuts had no outcome to
// be scored against. These checks pin the one press that records it: what it renders, what it
// writes, and what happens when the database is a migration behind.
// Run: node experiments/usefulness.test.mjs (builds both modules itself)
import { asUrl, bundle, tmpPath } from './lib/build.mjs';

const INSERT = process.env.MESSAGE_INSERT_MODULE ?? tmpPath('message-insert-useful.mjs');
const BUBBLE = process.env.USEFUL_BUBBLE_MODULE ?? tmpPath('useful-bubble.mjs');
const TURN = process.env.TURN_DECISION_MODULE ?? tmpPath('turn-decision-useful.mjs');
if (!process.env.MESSAGE_INSERT_MODULE) bundle('src/lib/messageInsert.ts', INSERT);
if (!process.env.TURN_DECISION_MODULE) bundle('src/lib/turnDecision.ts', TURN);
if (!process.env.USEFUL_BUBBLE_MODULE) {
  bundle('src/components/MessageBubble.tsx', BUBBLE, [
    '--jsx=automatic',
    '--external:react',
    '--external:react-dom',
    '--alias:decode-named-character-reference=./node_modules/decode-named-character-reference/index.js',
  ]);
}

const { updateRowTolerant, resetLearntColumns } = await import(asUrl(INSERT));
const { STOPPED_SEARCH_NOTE } = await import(asUrl(TURN));
const { MessageBubble } = await import(asUrl(BUBBLE));
const React = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// ── 1. the write survives a database that is a migration behind ─────────────
function fakeClient({ reject = [], failWith = null } = {}) {
  const calls = [];
  const client = {
    from(table) {
      return {
        update(patch) {
          const call = { table, patch: { ...patch }, match: null };
          calls.push(call);
          return {
            match(where) {
              call.match = where;
              if (failWith) return Promise.resolve({ error: failWith });
              const missing = Object.keys(patch).find((column) => reject.includes(column));
              return Promise.resolve({
                error: missing ? { message: `column ${table}.${missing} does not exist` } : null,
              });
            },
          };
        },
      };
    },
  };
  return { client, calls };
}

{
  resetLearntColumns();
  const { client, calls } = fakeClient();
  const outcome = await updateRowTolerant(client, 'messages', { id: 'm1' }, { useful: true });
  check('a verdict writes to the answer row', !outcome.error && calls.length === 1, JSON.stringify(outcome));
  check('the update names the row it belongs to', JSON.stringify(calls[0].match) === JSON.stringify({ id: 'm1' }));
  check('the patch carries the verdict', calls[0].patch.useful === true, JSON.stringify(calls[0].patch));
  check('nothing was dropped', outcome.dropped.length === 0, outcome.dropped.join(','));
}

{
  // "No" is a value, not an absence: it must reach the database exactly like "Yes".
  resetLearntColumns();
  const { client, calls } = fakeClient();
  const outcome = await updateRowTolerant(client, 'messages', { id: 'm2' }, { useful: false });
  check('a miss is stored as false, not dropped as empty', !outcome.error && calls[0].patch.useful === false);
}

{
  // the hosted project has no column yet: the write fails once, and the caller is told instead of
  // being left with a row that looks saved and an empty patch that answers 204
  resetLearntColumns();
  const { client, calls } = fakeClient({ reject: ['useful'] });
  const outcome = await updateRowTolerant(client, 'messages', { id: 'm3' }, { useful: true });
  check('a missing verdict column is reported, not hidden', Boolean(outcome.error), JSON.stringify(outcome));
  check('it is named as the dropped column', outcome.dropped.join(',') === 'useful', outcome.dropped.join(','));
  check('no empty update was sent after the drop', calls.length === 1, String(calls.length));
  check('the failure says what is missing', /not in the database yet/.test(outcome.error.message ?? ''), outcome.error.message);

  // learnt for the session: the next press must not pay the same 400 again
  const second = fakeClient({ reject: ['useful'] });
  const again = await updateRowTolerant(second.client, 'messages', { id: 'm4' }, { useful: true });
  check('a column learnt as missing is not sent again', second.calls.length === 0 && again.dropped.join(',') === 'useful');
}

{
  resetLearntColumns();
  const { client, calls } = fakeClient({ failWith: { message: 'permission denied for table messages' } });
  const outcome = await updateRowTolerant(client, 'messages', { id: 'm5' }, { useful: true });
  check('a rejected write is returned as it is', outcome.error?.message === 'permission denied for table messages');
  check('a rejection that is not a missing column is not retried', calls.length === 1, String(calls.length));
}

// ── 2. the control under an answer ─────────────────────────────────────────
const message = {
  id: 'a1',
  conversation_id: 'c1',
  role: 'assistant',
  content: 'Costs fell 47% in 2024, according to the agency.',
  created_at: '2026-11-18T00:00:00Z',
  search_enabled: true,
  search_results: [],
};
const props = { message, isStreaming: false, query: 'how did costs change', onUsefulness: async () => {} };
const htmlOf = (overrides = {}) =>
  renderToStaticMarkup(React.createElement(MessageBubble, { ...props, ...overrides }));
const textOf = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

{
  const html = htmlOf();
  check('an unrated answer asks the question', /Did this answer the question\?/.test(textOf(html)));
  check('it renders unrated', /data-usefulness="unrated"/.test(html), html.match(/data-usefulness="[^"]*"/)?.[0]);
  check('both presses are offered', (html.match(/aria-pressed="false"/g) ?? []).length === 2);
  check('the yes press says what it records', /worth having/.test(html));
  check('the no press says what it records', /missed the question/.test(html));
}

{
  const html = htmlOf({ message: { ...message, useful: true } });
  check('an answer the reader endorsed says so', /You said this answered it/.test(textOf(html)));
  check('and renders as yes', /data-usefulness="yes"/.test(html));
  check('a stored verdict is not a failure', !/not saved/.test(textOf(html)));
}

{
  const html = htmlOf({ message: { ...message, useful: false } });
  check('a miss says so', /You said this missed it/.test(textOf(html)));
  check('and renders as no', /data-usefulness="no"/.test(html));
}

check(
  'a miss is not the same as an unrated answer',
  htmlOf({ message: { ...message, useful: null } }).includes('data-usefulness="unrated"'),
);
check('a streaming answer is not rated', !htmlOf({ isStreaming: true }).includes('data-usefulness'));
check(
  'a turn that never answered is not rated',
  !htmlOf({ message: { ...message, content: STOPPED_SEARCH_NOTE } }).includes('data-usefulness'),
);

// ── 3. the press ───────────────────────────────────────────────────────────
const { act, create } = await import('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const nodesOf = (renderer) => {
  const all = [];
  const walk = (node) => {
    if (!node || typeof node === 'string') return;
    all.push(node);
    (node.children ?? []).forEach(walk);
  };
  walk(renderer.root);
  return all;
};
const pressOf = (renderer, verdict) =>
  nodesOf(renderer).find(
    (node) => node.type === 'button' && String(node.props.title ?? '').includes(verdict === true ? 'worth having' : 'missed the question'),
  );

{
  const seen = [];
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(MessageBubble, { ...props, onUsefulness: async (useful) => seen.push(useful) }));
  });
  const yes = pressOf(renderer, true);
  check('the yes press is mounted', Boolean(yes));
  await act(async () => {
    yes.props.onClick();
  });
  check('pressing yes records true', seen.length === 1 && seen[0] === true, JSON.stringify(seen));

  // the page holds the verdict, so the press shows as chosen only once the answer row says so
  await act(async () => {
    renderer.update(
      React.createElement(MessageBubble, {
        ...props,
        message: { ...message, useful: true },
        onUsefulness: async (useful) => seen.push(useful),
      }),
    );
  });
  check('the chosen verdict is pressed', pressOf(renderer, true).props['aria-pressed'] === true);
  await act(async () => {
    pressOf(renderer, true).props.onClick();
  });
  check('pressing the chosen verdict again is not a second write', seen.length === 1, JSON.stringify(seen));
}

{
  // the hosted schema has no column: the press must not stay on screen as though it had saved
  let renderer;
  await act(async () => {
    renderer = create(
      React.createElement(MessageBubble, {
        ...props,
        onUsefulness: async () => {
          throw new Error('messages.useful is not in the database yet');
        },
      }),
    );
  });
  await act(async () => {
    pressOf(renderer, false).props.onClick();
  });
  check(
    'a refused write says it was not saved',
    nodesOf(renderer).some(
      (node) => node.type === 'span' && /not saved/.test(String(node.children?.[0] ?? '')),
    ),
  );
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
