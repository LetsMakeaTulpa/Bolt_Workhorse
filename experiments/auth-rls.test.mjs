// Replays every migration in real Postgres (PGlite) with a stand-in for Supabase's auth schema,
// then proves that two signed-in users cannot see or touch each other's research.
// Run: node experiments/auth-rls.test.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = readdirSync('supabase/migrations')
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => `supabase/migrations/${f}`);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const db = new PGlite();

// Supabase ships auth.users and auth.uid(); emulate just enough of them.
await db.exec(`
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
  INSERT INTO auth.users (id, email) VALUES
    ('${A}', 'a@example.test'),
    ('${B}', 'b@example.test');
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
  GRANT SELECT, REFERENCES ON auth.users TO authenticated, service_role;
`);

for (const file of MIGRATIONS) {
  try {
    await db.exec(readFileSync(file, 'utf8'));
  } catch (err) {
    check(`migration applies: ${file}`, false, err.message);
    console.log(`\n${results.filter((r) => !r.ok).length} failed`);
    process.exit(1);
  }
}
check(`all ${MIGRATIONS.length} migrations apply cleanly`, true);

/** Run a statement block as a signed-in user, restoring the session afterwards. */
async function as(userId, fn) {
  await db.exec(`SET ROLE authenticated;`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [userId]);
  try {
    return await fn();
  } finally {
    await db.exec(`RESET ROLE;`);
    await db.query(`SELECT set_config('request.jwt.claim.sub', '', false)`);
  }
}

async function asAnon(fn) {
  await db.exec(`SET ROLE anon;`);
  try {
    return await fn();
  } finally {
    await db.exec(`RESET ROLE;`);
  }
}

async function asService(fn) {
  await db.exec(`SET ROLE service_role;`);
  try {
    return await fn();
  } finally {
    await db.exec(`RESET ROLE;`);
  }
}

async function rejects(fn) {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

// 1. inserts carry the caller's id without the client sending it
const convA = await as(A, async () => {
  const { rows } = await db.query(
    `INSERT INTO public.conversations (title, model) VALUES ('A study', 'xortron/RESTRICTED-RESEARCH-MODEL') RETURNING id, user_id`,
  );
  return rows[0];
});
check('conversation inherits the caller as owner', convA.user_id === A, `user_id=${convA.user_id}`);

const childRows = await as(A, async () => {
  const msg = await db.query(
    `INSERT INTO public.messages (conversation_id, role, content, search_enabled) VALUES ($1,'user','hello',true) RETURNING user_id`,
    [convA.id],
  );
  const src = await db.query(
    `INSERT INTO public.sources (conversation_id, title, url) VALUES ($1,'doc','https://example.test/doc') RETURNING user_id`,
    [convA.id],
  );
  const finding = await db.query(
    `INSERT INTO public.findings (conversation_id, query, title, url) VALUES ($1,'q','t','https://example.test/f') RETURNING user_id`,
    [convA.id],
  );
  const log = await db.query(
    `INSERT INTO public.activity_logs (conversation_id, activity_type, description) VALUES ($1,'search','ran') RETURNING user_id`,
    [convA.id],
  );
  return [msg, src, finding, log].map((r) => r.rows[0].user_id);
});
check(
  'messages, sources, findings and logs inherit the owner too',
  childRows.every((id) => id === A),
  childRows.join(','),
);

// 2. isolation between two real users
const seenByA = await as(A, async () => {
  const c = await db.query('SELECT count(*)::int AS n FROM public.conversations');
  const m = await db.query('SELECT count(*)::int AS n FROM public.messages');
  const s = await db.query('SELECT count(*)::int AS n FROM public.sources');
  return [c.rows[0].n, m.rows[0].n, s.rows[0].n];
});
check('owner sees their own rows', seenByA.join(',') === '1,1,1', seenByA.join(','));

const seenByB = await as(B, async () => {
  const c = await db.query('SELECT count(*)::int AS n FROM public.conversations');
  const m = await db.query('SELECT count(*)::int AS n FROM public.messages');
  const s = await db.query('SELECT count(*)::int AS n FROM public.sources');
  const f = await db.query('SELECT count(*)::int AS n FROM public.findings');
  return [c.rows[0].n, m.rows[0].n, s.rows[0].n, f.rows[0].n];
});
check('the other account sees none of it', seenByB.join(',') === '0,0,0,0', seenByB.join(','));

// 3. no writes across the boundary
const bUpdate = await as(B, () =>
  db.query('UPDATE public.conversations SET title = $1 WHERE id = $2 RETURNING id', ['hijacked', convA.id]),
);
check('another account cannot update the row', bUpdate.rows.length === 0);

const bDelete = await as(B, () =>
  db.query('DELETE FROM public.conversations WHERE id = $1 RETURNING id', [convA.id]),
);
check('another account cannot delete the row', bDelete.rows.length === 0);

const bReadChildren = await as(B, () =>
  db.query('SELECT count(*)::int AS n FROM public.messages WHERE conversation_id = $1', [convA.id]),
);
check('another account cannot read its messages', bReadChildren.rows[0].n === 0);

check(
  'another account cannot insert a row stamped with the owner id',
  await rejects(() =>
    as(B, () =>
      db.query(
        `INSERT INTO public.conversations (title, model, user_id) VALUES ('spoof', 'm', $1)`,
        [A],
      ),
    ),
  ),
);

// 4. anon is out entirely
const anonSelect = await rejects(() => asAnon(() => db.query('SELECT * FROM public.conversations')));
check('anon cannot select conversations', anonSelect);
const anonInsert = await rejects(() =>
  asAnon(() => db.query(`INSERT INTO public.conversations (title, model) VALUES ('nope','m')`)),
);
check('anon cannot insert conversations', anonInsert);
const anonMessages = await rejects(() => asAnon(() => db.query('SELECT * FROM public.messages')));
check('anon cannot read messages', anonMessages);

// 5. shared reference data
const presetRead = await as(A, () => db.query('SELECT count(*)::int AS n FROM public.research_presets'));
check('signed-in users can read presets', presetRead.rows[0].n > 0, `${presetRead.rows[0].n} presets`);
check(
  'signed-in users cannot write presets',
  await rejects(() =>
    as(A, () => db.query(`INSERT INTO public.research_presets (name, category, description, config) VALUES ('x','y','z','{}'::jsonb)`)),
  ),
);
const presetAnon = await rejects(() => asAnon(() => db.query('SELECT * FROM public.research_presets')));
check('anon cannot read presets', presetAnon);

// 6. unowned legacy rows stay invisible instead of leaking
await asService(() =>
  db.query(`INSERT INTO public.conversations (title, model) VALUES ('legacy','m')`),
);
const anonOwnedScan = await as(A, () =>
  db.query(`SELECT count(*)::int AS n FROM public.conversations WHERE user_id IS NULL`),
);
check('legacy rows with no owner are invisible to users', anonOwnedScan.rows[0].n === 0);

// 7. the service role still sees everything (edge functions keep working)
const serviceCount = await asService(async () => {
  const c = await db.query('SELECT count(*)::int AS n FROM public.conversations');
  const p = await db.query('SELECT count(*)::int AS n FROM public.research_presets');
  return [c.rows[0].n, p.rows[0].n];
});
check('service role sees every row', serviceCount[0] === 2 && serviceCount[1] > 0, serviceCount.join(','));

// 8. deleting an auth user takes their research with it
await db.exec(`DELETE FROM auth.users WHERE id = '${A}'`);
const afterDelete = await asService(() =>
  db.query('SELECT count(*)::int AS n FROM public.conversations WHERE id = $1', [convA.id]),
);
check('deleting the account cascades to its conversations', afterDelete.rows[0].n === 0);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) process.exit(1);
