// A chat that answers is two things staying true: a turn that got interrupted still ends visibly,
// and an answer that streamed is still there after a reload. Both used to fail.
// Run: node experiments/chat-reliability.test.mjs (builds both modules itself)
import { asUrl, bundle, tmpPath } from './lib/build.mjs';

const TURN = process.env.TURN_DECISION_MODULE ?? tmpPath('turn-decision.mjs');
const INSERT = process.env.MESSAGE_INSERT_MODULE ?? tmpPath('message-insert.mjs');
if (!process.env.TURN_DECISION_MODULE) bundle('src/lib/turnDecision.ts', TURN);
if (!process.env.MESSAGE_INSERT_MODULE) bundle('src/lib/messageInsert.ts', INSERT);

const { decideAfterSearch, STOPPED_SEARCH_NOTE } = await import(asUrl(TURN));
const { insertRowTolerant, missingColumnFrom, noteDroppedColumns, resetDroppedColumnNotices } = await import(asUrl(INSERT));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// ── 1. an interrupted search never leaves the question unanswered ───────────
{
  check('a clean search answers', decideAfterSearch({ aborted: false, cancelled: false, superseded: false }) === 'answer');
  check('a stopped search says so', decideAfterSearch({ aborted: true, cancelled: true, superseded: false }) === 'stopped-note');
  check('a superseded turn steps aside silently', decideAfterSearch({ aborted: true, cancelled: false, superseded: true }) === 'silent');
  check('a newer question wins even after a stop', decideAfterSearch({ aborted: true, cancelled: true, superseded: true }) === 'silent');
  check('any other interruption still answers', decideAfterSearch({ aborted: true, cancelled: false, superseded: false }) === 'answer');
  check('the stopped note tells the reader how to just talk', /Search off/i.test(STOPPED_SEARCH_NOTE));
  check('the stopped note is not a mistaken empty answer', /nothing was answered/i.test(STOPPED_SEARCH_NOTE));
}

// ── 2. an answer saves even when the schema is a migration behind ──────────
function fakeClient({ reject = [], failWith = null } = {}) {
  const calls = [];
  const client = {
    from(table) {
      return {
        insert(payload) {
          calls.push({ table, payload: { ...payload } });
          const bad = reject.find((column) => column in payload);
          const result = bad
            ? { data: null, error: { code: '42703', message: `column ${table}.${bad} does not exist` } }
            : failWith
              ? { data: null, error: failWith }
              : { data: { id: 'row-1', ...payload }, error: null };
          return {
            select: () => ({ single: async () => result }),
            then: (resolve, rejectPromise) => Promise.resolve(result).then(resolve, rejectPromise),
          };
        },
      };
    },
  };
  return { client, calls };
}

{
  const { client, calls } = fakeClient();
  const outcome = await insertRowTolerant(client, 'messages', { role: 'assistant', content: 'hi', system_prompt: 'p' });
  check('a complete row saves first time', outcome.data?.content === 'hi' && outcome.dropped.length === 0);
  check('and is sent once', calls.length === 1);
}

{
  const { client, calls } = fakeClient({ reject: ['system_prompt'] });
  const outcome = await insertRowTolerant(client, 'messages', { role: 'assistant', content: 'hi', system_prompt: 'p' });
  check('a column the database lacks is dropped', outcome.dropped.join() === 'system_prompt', JSON.stringify(outcome.dropped));
  check('and the answer is saved anyway', outcome.data?.content === 'hi');
  check('the retry no longer names the missing column', !('system_prompt' in calls[1].payload));
  check('the retry keeps everything else', calls[1].payload.content === 'hi' && calls[1].payload.role === 'assistant');
}

{
  const { client, calls } = fakeClient({
    failWith: { code: 'PGRST204', message: "Could not find the 'system_prompt' column of 'messages' in the schema cache" },
  });
  const outcome = await insertRowTolerant(client, 'messages', { role: 'assistant', content: 'hi', system_prompt: 'p' });
  check('the schema-cache wording is recognised too', outcome.dropped.join() === 'system_prompt', JSON.stringify(outcome.dropped));
  check('and it retried', calls.length === 2);
}

{
  const { client, calls } = fakeClient({ failWith: { code: '42501', message: 'new row violates row-level security policy' } });
  const outcome = await insertRowTolerant(client, 'messages', { role: 'assistant', content: 'hi', system_prompt: 'p' });
  check('a rejected row is reported, not retried', calls.length === 1 && outcome.data === null);
  check('and the real error survives', /row-level security/.test(outcome.error?.message ?? ''), outcome.error?.message);
  check('nothing was quietly dropped from a failed write', outcome.dropped.length === 0);
}

{
  const { client, calls } = fakeClient({ reject: ['model'] });
  const outcome = await insertRowTolerant(client, 'messages', { role: 'assistant', content: 'hi' });
  check('a missing column that is not in the row stops the loop', calls.length === 1 && outcome.dropped.length === 0);
}

{
  const { client } = fakeClient();
  const outcome = await insertRowTolerant(client, 'messages', { role: 'assistant', content: 'hi' }, { select: false });
  check('saving without select still succeeds', outcome.error === null);
}

check('missingColumnFrom reads the Postgres wording', missingColumnFrom({ message: 'column messages.system_prompt does not exist' }, 'messages') === 'system_prompt');
check('missingColumnFrom ignores unrelated errors', missingColumnFrom({ message: 'permission denied for table messages' }, 'messages') === null);

{
  resetDroppedColumnNotices();
  const logged = [];
  const log = async (message, detail) => { logged.push({ message, detail }); };
  const warn = console.warn;
  let warnings = 0;
  console.warn = () => { warnings += 1; };
  await noteDroppedColumns(['system_prompt'], log);
  await noteDroppedColumns(['system_prompt'], log);
  console.warn = warn;
  check('dropping a column is said once per session', warnings === 1, String(warnings));
  check('and recorded in the trail once', logged.length === 1, String(logged.length));
  check('the note names the migration', /pending migration/.test(logged[0]?.message ?? ''), logged[0]?.message);
  resetDroppedColumnNotices();
}

const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) process.exit(1);
