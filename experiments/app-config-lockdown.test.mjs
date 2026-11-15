// Verifies the app_config lockdown in a real Postgres (PGlite) instance:
// replays the original permissive migration, applies the lockdown, then acts as each role.
// Run: node experiments/app-config-lockdown.test.mjs

import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const ORIGINAL = 'supabase/migrations/20261112192624_create_app_config.sql';
const LOCKDOWN = 'supabase/migrations/20261115120000_lock_app_config_service_role.sql';

const db = new PGlite();
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function asRole(role, sql) {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await db.query(sql);
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function expectDenied(name, role, sql) {
  try {
    await asRole(role, sql);
    check(name, false, 'query unexpectedly succeeded');
  } catch (error) {
    const message = String(error.message || error);
    // a denied read surfaces as a grant error, an RLS error, or a column that simply isn't in the view
    check(name, /permission denied|row-level security|does not exist/i.test(message), message.split('\n')[0]);
  }
}

// Supabase's anon / authenticated / service_role, with service_role bypassing RLS as it does there
await db.exec(`
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
`);

await db.exec(readFileSync(ORIGINAL, 'utf8'));
// the migration seeds an empty key; simulate a configured deployment for the leak test
await db.exec("UPDATE app_config SET featherless_api_key = 'test-key-0123456789abcdef' WHERE id = 1");
check('migration file itself carries no key', !/rc_[0-9a-f]{16,}/.test(readFileSync(ORIGINAL, 'utf8')));

// baseline: the vulnerability this migration closes
const beforeLeak = await asRole('anon', 'SELECT featherless_api_key FROM app_config');
check('before: anon could read the key (the bug)', beforeLeak.rows.length === 1 && beforeLeak.rows[0].featherless_api_key.length > 10);

await db.exec(readFileSync(LOCKDOWN, 'utf8'));

// after
await expectDenied('anon cannot select app_config', 'anon', 'SELECT * FROM app_config');
await expectDenied('anon cannot read the key column', 'anon', 'SELECT featherless_api_key FROM app_config');
await expectDenied('authenticated cannot select app_config', 'authenticated', 'SELECT * FROM app_config');
await expectDenied(
  'anon cannot overwrite the key',
  'anon',
  "UPDATE app_config SET featherless_api_key = 'attacker' WHERE id = 1",
);
await expectDenied(
  'anon cannot insert a config row',
  'anon',
  "INSERT INTO app_config (id, featherless_api_key) VALUES (1, 'attacker')",
);

const view = await asRole('anon', 'SELECT * FROM app_config_public');
check('anon reads the public view', view.rows.length === 1, JSON.stringify(view.rows[0]));
check(
  'public view exposes no key material',
  Object.keys(view.rows[0] ?? {}).sort().join(',') === 'default_model,has_api_key,id,updated_at',
  Object.keys(view.rows[0] ?? {}).join(','),
);
check('public view reports the key as configured', view.rows[0]?.has_api_key === true);
check('public view carries the default model', Boolean(view.rows[0]?.default_model));

await expectDenied('anon cannot select the key from the view', 'anon', 'SELECT featherless_api_key FROM app_config_public');

const authView = await asRole('authenticated', 'SELECT * FROM app_config_public');
check('authenticated reads the public view', authView.rows.length === 1);

const serviceRead = await asRole('service_role', 'SELECT featherless_api_key, default_model FROM app_config');
check('service_role still reads the key', serviceRead.rows[0]?.featherless_api_key?.length > 10);

const serviceWrite = await asRole(
  'service_role',
  "UPDATE app_config SET default_model = 'xortron/RESTRICTED-RESEARCH-MODEL' WHERE id = 1 RETURNING default_model",
);
check('service_role can still write config', serviceWrite.rows[0]?.default_model === 'xortron/RESTRICTED-RESEARCH-MODEL');

await expectDenied('anon cannot drop the view data via insert', 'anon', "INSERT INTO app_config_public (id) VALUES (2)");

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
process.exit(failed.length === 0 ? 0 : 1);
