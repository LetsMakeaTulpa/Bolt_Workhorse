#!/usr/bin/env node
// Prints PASS / FAIL for every object the migrations are supposed to leave behind.
//
//   npm run migrations:verify
//
// The suites prove *behaviour* (can this user read that row); this proves the schema itself — the
// tables, columns, policies, indexes, function and privileges — so a migration that silently fails
// to create something is caught by name instead of surfacing later as a mysterious 404 from
// PostgREST. It replays supabase/migrations in filename order into PGlite, so it needs no
// credentials and no network.
//
// This checks the migration set, not the hosted project. Whether the hosted database has them is a
// different question, answered by `supabase migration list` (see DEPLOY.md).
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const MIGRATION_DIR = 'supabase/migrations';
const MIGRATIONS = readdirSync(MIGRATION_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => `${MIGRATION_DIR}/${file}`);

// ── what the migrations must define ──────────────────────────────────────────
const TABLES = [
  'activity_logs',
  'app_config',
  'conversations',
  'evidence',
  'findings',
  'messages',
  'research_presets',
  'research_projects',
  'request_rate_limits',
  'search_settings',
  'sources',
  'user_engine_keys',
];

const VIEWS = ['app_config_public'];

const COLUMNS = [
  ['app_config', 'featherless_api_key'],
  ['messages', 'user_id'],
  ['messages', 'conversation_id'],
  ['messages', 'system_prompt'],
  ['messages', 'tool_searches'],
  ['sources', 'user_id'],
  ['findings', 'user_id'],
  ['activity_logs', 'user_id'],
  ['research_projects', 'user_id'],
  ['user_engine_keys', 'user_id'],
  ['user_engine_keys', 'name'],
  ['user_engine_keys', 'value'],
  ['user_engine_keys', 'updated_at'],
];

/** Owner-scoped and shared-read policies that survive every migration, by table. */
const POLICIES = [
  ['activity_logs', 'own_activity'],
  ['conversations', 'own_conversations'],
  ['evidence', 'own_evidence'],
  ['findings', 'own_findings'],
  ['messages', 'own_messages'],
  ['research_projects', 'own_projects'],
  ['sources', 'own_sources'],
  ['app_config', 'service_role_all_config'],
  ['research_presets', 'shared_presets_read'],
  ['search_settings', 'shared_settings_read'],
  ['user_engine_keys', 'user_engine_keys_select_own'],
  ['user_engine_keys', 'user_engine_keys_insert_own'],
  ['user_engine_keys', 'user_engine_keys_update_own'],
  ['user_engine_keys', 'user_engine_keys_delete_own'],
];

const INDEXES = [
  'idx_activity_conversation_id',
  'idx_activity_logs_user',
  'idx_conversations_user',
  'idx_evidence_conversation_id',
  'idx_evidence_source_id',
  'idx_evidence_user',
  'idx_findings_conversation_id',
  'idx_findings_created_at',
  'idx_findings_status',
  'idx_findings_user',
  'idx_messages_conversation_id',
  'idx_messages_created_at',
  'idx_messages_user',
  'idx_request_rate_limits_window',
  'idx_research_projects_user',
  'idx_sources_conversation_id',
  'idx_sources_message_id',
  'idx_sources_user',
];

/** table privileges: [role, table, privilege, shouldHaveIt] */
const PRIVILEGES = [
  ['anon', 'public.app_config', 'SELECT', false],
  ['authenticated', 'public.app_config', 'SELECT', false],
  ['service_role', 'public.app_config', 'SELECT', true],
  ['anon', 'public.app_config_public', 'SELECT', true],
  ['anon', 'public.user_engine_keys', 'SELECT', false],
  ['authenticated', 'public.user_engine_keys', 'SELECT', true],
  ['authenticated', 'public.user_engine_keys', 'DELETE', true],
  // add_user_auth_rls revokes anon from every private table; the earlier grant is not the last word
  ['anon', 'public.messages', 'SELECT', false],
  ['authenticated', 'public.messages', 'SELECT', true],
];

// ── the database ─────────────────────────────────────────────────────────────
const results = [];
function report(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function heading(text) {
  console.log(`\n${text}`);
}

const db = new PGlite();

// Supabase ships these roles and the auth schema; the migrations depend on both.
await db.exec(`
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
  GRANT SELECT, REFERENCES ON auth.users TO authenticated, service_role;
`);

heading('migrations');
let applied = 0;
for (const file of MIGRATIONS) {
  const name = file.slice(MIGRATION_DIR.length + 1);
  try {
    await db.exec(readFileSync(file, 'utf8'));
    applied += 1;
    report(`applies ${name}`, true);
  } catch (err) {
    report(`applies ${name}`, false, String(err.message ?? err).split('\n')[0]);
  }
}

/** One catalog question, answered as a single boolean. */
async function probe(sql, params = []) {
  try {
    const { rows } = await db.query(sql, params);
    return { ok: rows[0]?.ok === true, error: '' };
  } catch (err) {
    return { ok: false, error: String(err.message ?? err).split('\n')[0] };
  }
}

heading('tables');
for (const table of TABLES) {
  const { ok, error } = await probe('select to_regclass($1) is not null as ok', [`public.${table}`]);
  report(`table ${table}`, ok, error);
}

heading('views');
for (const view of VIEWS) {
  const { ok, error } = await probe('select to_regclass($1) is not null as ok', [`public.${view}`]);
  report(`view ${view}`, ok, error);
}

heading('columns');
for (const [table, column] of COLUMNS) {
  const { ok, error } = await probe(
    `select exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = $1 and column_name = $2
     ) as ok`,
    [table, column],
  );
  report(`column ${table}.${column}`, ok, error);
}

heading('policies');
for (const [table, policy] of POLICIES) {
  const { ok, error } = await probe(
    `select exists (
       select 1 from pg_policies
       where schemaname = 'public' and tablename = $1 and policyname = $2
     ) as ok`,
    [table, policy],
  );
  report(`policy ${policy} on ${table}`, ok, error);
}

// the anonymous policies were the original leak; every later migration drops them by name
{
  const { rows } = await db.query(
    `select count(*)::int as left from pg_policies where schemaname = 'public' and policyname like 'anon!_%' escape '!'`,
  );
  const remaining = rows[0]?.left ?? -1;
  report('no anon_* policy survives', remaining === 0, `${remaining} left`);
}

heading('row level security');
for (const table of TABLES.filter((name) => name !== 'search_settings' && name !== 'research_presets')) {
  const { ok } = await probe(
    `select coalesce((select relrowsecurity from pg_class where oid = $1::regclass), false) as ok`,
    [`public.${table}`],
  );
  report(`rls enabled on ${table}`, ok);
}

heading('functions');
{
  const { ok, error } = await probe(
    `select exists (
       select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'consume_rate_limit' and p.pronargs = 3
     ) as ok`,
  );
  report('function consume_rate_limit(text, integer, integer)', ok, error);

  const definer = await probe(
    `select exists (
       select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'consume_rate_limit' and p.prosecdef
     ) as ok`,
  );
  report('consume_rate_limit is SECURITY DEFINER', definer.ok, definer.error);
}

heading('indexes');
for (const index of INDEXES) {
  const { ok, error } = await probe(
    `select exists (select 1 from pg_indexes where schemaname = 'public' and indexname = $1) as ok`,
    [index],
  );
  report(`index ${index}`, ok, error);
}

heading('privileges');
for (const [role, table, privilege, expected] of PRIVILEGES) {
  const { ok: has, error } = await probe('select has_table_privilege($1, $2, $3) as ok', [role, table, privilege]);
  const word = expected ? 'may' : 'may not';
  report(`${role} ${word} ${privilege} on ${table}`, has === expected, error);
}
{
  const signature = 'public.consume_rate_limit(text, integer, integer)';
  const anon = await probe('select has_function_privilege($1, $2, $3) as ok', ['anon', signature, 'EXECUTE']);
  report('anon may not execute consume_rate_limit', anon.ok === false, anon.error);
  const service = await probe('select has_function_privilege($1, $2, $3) as ok', ['service_role', signature, 'EXECUTE']);
  report('service_role may execute consume_rate_limit', service.ok === true, service.error);
}

// ── summary ──────────────────────────────────────────────────────────────────
const failed = results.filter((result) => !result.ok);
console.log('\n────────────────────────────────────');
console.log(`migrations applied: ${applied}/${MIGRATIONS.length}`);
console.log(`objects checked: ${results.length - MIGRATIONS.length}`);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log(`\n${failed.length} failed:`);
  for (const result of failed) console.log(`  ✗ ${result.name}`);
}
await db.close();
process.exit(failed.length ? 1 : 0);
