// The drift gate reads its probes out of the migration files. What it must never do is pass a
// migration it did not understand: a construct it cannot name is a hole in the gate, so it comes
// back as `unprobed` and the check fails on it.
// Run: node experiments/migration-probes.test.mjs
import { migrationProbes, probesFromSql, splitStatements } from '../scripts/migrationProbes.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// 1. a table is a probe; grants, policies and indexes are not
{
  const sql = [
    'CREATE TABLE IF NOT EXISTS public.request_rate_limits (',
    '  key text PRIMARY KEY,',
    '  window_start timestamptz NOT NULL',
    ');',
    'CREATE INDEX IF NOT EXISTS idx_window ON public.request_rate_limits(key);',
    'ALTER TABLE public.request_rate_limits ENABLE ROW LEVEL SECURITY;',
    'GRANT SELECT, INSERT ON TABLE public.request_rate_limits TO service_role;',
    'CREATE POLICY "svc" ON public.request_rate_limits FOR ALL TO service_role USING (true);',
  ].join('\n');
  const { probes, unprobed } = probesFromSql(sql, 'a.sql');
  check(
    'a created table is probed once, and nothing else is',
    probes.length === 1 && probes[0].table === 'request_rate_limits' && unprobed.length === 0,
    JSON.stringify(probes),
  );
}

// 2. a column added across two lines is read as a column
{
  const sql = ['alter table public.messages', '  add column if not exists tool_searches jsonb not null default \'[]\'::jsonb;'].join('\n');
  const { probes } = probesFromSql(sql, 'b.sql');
  check(
    'a multi-line add column is probed as table.column',
    probes.length === 1 && probes[0].label === 'messages.tool_searches' && probes[0].column === 'tool_searches',
    JSON.stringify(probes),
  );
}

// 3. add constraint is not a column called "constraint"
{
  const sql = 'alter table public.messages add constraint messages_conversation_id_fkey foreign key (conversation_id) references conversations(id);';
  const { probes } = probesFromSql(sql, 'c.sql');
  check('add constraint adds no column probe', probes.length === 0, JSON.stringify(probes));
}

// 4. a view is queryable through PostgREST, so it needs a probe
{
  const sql = 'CREATE OR REPLACE VIEW public.app_config_public\n  WITH (security_invoker = true) AS\n  SELECT id, updated_at FROM public.app_config;';
  const { probes } = probesFromSql(sql, 'd.sql');
  check('a view is probed like a table', probes.length === 1 && probes[0].table === 'app_config_public', JSON.stringify(probes));
}

// 5. a function body full of semicolons does not swallow the statement after it
{
  const sql = [
    'CREATE OR REPLACE FUNCTION public.consume_rate_limit(p_key text) RETURNS boolean',
    'LANGUAGE plpgsql AS $$',
    'BEGIN',
    '  RETURN true;',
    'END;',
    '$$;',
    'create table if not exists public.search_runs (id uuid primary key);',
  ].join('\n');
  const statements = splitStatements(sql);
  const { probes, unprobed } = probesFromSql(sql, 'e.sql');
  check(
    'a dollar-quoted body stays one statement and the table after it is found',
    statements.length === 2 && probes.length === 1 && probes[0].table === 'search_runs' && unprobed.length === 0,
    `${statements.length} statements, probes ${JSON.stringify(probes)}`,
  );
}

// 6. a commented-out create is not schema
{
  const sql = ['-- create table public.ghost (id int);', '/* create table public.phantom (id int); */', 'select 1;'].join('\n');
  const { probes } = probesFromSql(sql, 'f.sql');
  check('commented SQL adds no probe', probes.length === 0, JSON.stringify(probes));
}

// 7. an unknown create kind fails the gate instead of being skipped
{
  const { probes, unprobed } = probesFromSql('create stream public.events (id int);', 'g.sql');
  check(
    'an unrecognised create is reported as unprobed',
    probes.length === 0 && unprobed.length === 1 && /stream/.test(unprobed[0].reason),
    JSON.stringify(unprobed),
  );
}

// 8. a DO block that builds a table cannot be named without running it
{
  const sql = ["do $$", 'begin', '  execute \'create table public.sneaky (id int)\';', 'end', '$$;'].join('\n');
  const { unprobed } = probesFromSql(sql, 'h.sql');
  check('a do block that adds objects is unprobed', unprobed.length === 1, JSON.stringify(unprobed));
}

// 9. an object outside the public schema is not reachable by the anon probe
{
  const { probes, unprobed } = probesFromSql('create table auth.audit_log (id uuid);', 'i.sql');
  check(
    'a non-public table is unprobed, not silently probed',
    probes.length === 0 && unprobed.length === 1 && /outside the public schema/.test(unprobed[0].reason),
    JSON.stringify(unprobed),
  );
}

// 10. the repository's own migrations are fully covered
{
  const { probes, unprobed, files } = migrationProbes();
  const labels = probes.map((probe) => probe.label);
  const required = [
    'messages.user_id',
    'messages.system_prompt',
    'messages.useful',
    'request_rate_limits',
    'user_engine_keys',
    'search_runs',
    'app_config_public',
  ];
  const missing = required.filter((label) => !labels.includes(label));
  check(
    'every migration in the repository parses into probes, with none unprobed',
    files.length > 0 && unprobed.length === 0 && missing.length === 0,
    `${files.length} files, ${probes.length} probes, unprobed ${JSON.stringify(unprobed.map((item) => item.migration))}, missing ${JSON.stringify(missing)}`,
  );
}

// 11. each probe belongs to the migration that created it
{
  const { probes } = migrationProbes();
  const searchRuns = probes.find((probe) => probe.table === 'search_runs');
  check(
    'a probe names the migration that adds it',
    searchRuns?.migration === '20261118190000_create_search_runs.sql',
    JSON.stringify(searchRuns),
  );
}

const failures = results.filter((row) => !row.ok);
console.log(`\n${results.length - failures.length}/${results.length} assertions passed`);
if (failures.length) process.exit(1);
