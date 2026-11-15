// Replays every migration in order in real Postgres (PGlite) and asserts what anon may write.
// Run: node experiments/rls-write-audit.test.mjs

import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = [
  'supabase/migrations/20261111182132_create_workhorse_schema.sql',
  'supabase/migrations/20261111193222_fieldwork_schema_expansion.sql',
  'supabase/migrations/20261112192624_create_app_config.sql',
  'supabase/migrations/20261112192634_grant_service_role_config.sql',
  // lockdown under test
  'supabase/migrations/20261115120000_lock_app_config_service_role.sql',
  'supabase/migrations/20261115130000_tighten_anon_write_grants.sql',
];
// Scope note: this audit measures the locked-down *anon* surface. The later per-user auth
// migration removes anon from every private table entirely; that final state is asserted in
// experiments/auth-rls.test.mjs (anon denied, authenticated scoped to user_id = auth.uid()).

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const db = new PGlite();
await db.exec(`
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
`);

// baseline: how wide the grants are before the lockdown (documents the finding)
const BASE = MIGRATIONS.slice(0, 4);
for (const file of BASE) await db.exec(readFileSync(file, 'utf8'));
const before = await db.query(
  `SELECT has_table_privilege('anon','public.messages','UPDATE') AS msg_update,
          has_table_privilege('anon','public.research_presets','INSERT') AS preset_insert,
          has_table_privilege('anon','public.evidence','DELETE') AS evidence_delete`,
);
check(
  'before: anon could update messages, insert presets, delete evidence',
  before.rows[0].msg_update && before.rows[0].preset_insert && before.rows[0].evidence_delete,
);
const beforeApp = await db.query(`SELECT has_table_privilege('anon','public.app_config','SELECT') AS s`);
check('before: anon could read app_config', beforeApp.rows[0].s);

for (const file of MIGRATIONS.slice(4)) await db.exec(readFileSync(file, 'utf8'));

// per-table privilege matrix after the lockdown
// after the lockdown, anon keeps only what the single-tenant UI still needed
const MATRIX = {
  conversations: { select: true, insert: true, update: true, delete: true },
  messages: { select: true, insert: true, update: false, delete: false },
  findings: { select: true, insert: true, update: true, delete: true },
  sources: { select: true, insert: true, update: false, delete: false },
  activity_logs: { select: true, insert: true, update: false, delete: false },
  research_presets: { select: true, insert: false, update: false, delete: false },
  research_projects: { select: true, insert: false, update: false, delete: false },
  evidence: { select: true, insert: false, update: false, delete: false },
  search_settings: { select: true, insert: false, update: false, delete: false },
  app_config: { select: false, insert: false, update: false, delete: false },
};

for (const [table, expected] of Object.entries(MATRIX)) {
  const row = (
    await db.query(
      `SELECT has_table_privilege('anon','public.${table}','SELECT') AS s,
              has_table_privilege('anon','public.${table}','INSERT') AS i,
              has_table_privilege('anon','public.${table}','UPDATE') AS u,
              has_table_privilege('anon','public.${table}','DELETE') AS d`,
    )
  ).rows[0];
  const actual = { select: row.s, insert: row.i, update: row.u, delete: row.d };
  const ok = Object.keys(expected).every((verb) => actual[verb] === expected[verb]);
  check(
    `anon privileges: ${table}`,
    ok,
    Object.entries(actual).map(([v, on]) => `${v}=${on ? 'y' : 'n'}`).join(' '),
  );
}

// service_role is never the one blocked
const svc = await db.query(
  `SELECT bool_and(has_table_privilege('service_role', 'public.'||t, 'INSERT')
                AND has_table_privilege('service_role', 'public.'||t, 'UPDATE')) AS all_write
   FROM unnest(ARRAY['conversations','messages','findings','sources','activity_logs',
                     'research_presets','research_projects','evidence','search_settings','app_config']) AS t`,
);
check('service_role can write every table', svc.rows[0].all_write);

// the app's own path (single-tenant, no auth) must still work as anon at this stage
async function asAnon(sql, params = []) {
  await db.exec('SET ROLE anon');
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec('RESET ROLE');
  }
}

let failed = null;
try {
  const conv = await asAnon("INSERT INTO conversations (title) VALUES ('audit') RETURNING id");
  const convId = conv.rows[0].id;
  await asAnon("INSERT INTO messages (conversation_id, role, content) VALUES ($1,'user','hi')", [convId]);
  await asAnon("INSERT INTO sources (conversation_id, title, url) VALUES ($1,'s','https://x')", [convId]);
  await asAnon("INSERT INTO activity_logs (conversation_id, activity_type) VALUES ($1,'search')", [convId]);
  const finding = await asAnon(
    "INSERT INTO findings (conversation_id, query, status) VALUES ($1,'q','saved') RETURNING id",
    [convId],
  );
  await asAnon("UPDATE findings SET status = 'shared' WHERE id = $1", [finding.rows[0].id]);
  await asAnon('DELETE FROM findings WHERE id = $1', [finding.rows[0].id]);
  await asAnon('UPDATE conversations SET title = $2 WHERE id = $1', [convId, 'renamed']);
  await asAnon('DELETE FROM conversations WHERE id = $1', [convId]);
} catch (error) {
  failed = String(error.message || error);
}
check('app happy path still works as anon', failed === null, failed ?? '');

// and the writes that were removed are actually refused
const refused = [];
for (const [sql, label] of [
  ["INSERT INTO research_presets (name, category) VALUES ('evil','x')", 'insert preset'],
  ["UPDATE messages SET content = 'tampered' WHERE true", 'update message'],
  ["DELETE FROM activity_logs WHERE true", 'delete activity log'],
  ["INSERT INTO evidence (claim) VALUES ('forged')", 'insert evidence'],
  ["UPDATE research_projects SET name = 'x' WHERE true", 'update project'],
]) {
  try {
    await asAnon(sql);
    refused.push(label);
  } catch {
    // expected
  }
}
check('removed writes are refused', refused.length === 0, refused.join(', '));

const out = results.filter((r) => !r.ok);
console.log(`\n${results.length - out.length}/${results.length} assertions passed`);
process.exit(out.length ? 1 : 0);
