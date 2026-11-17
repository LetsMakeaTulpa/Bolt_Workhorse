#!/usr/bin/env node
/**
 * Apply the pending Supabase migrations in one command.
 *
 *   npm run migrations:plan     # what would run, and what the hosted project is missing
 *   npm run migrations:apply    # apply them, then prove the hosted project caught up
 *
 * The hosted project is behind the repo, and the symptom is concrete: `messages.system_prompt` does
 * not exist there, so the app's answer rows used to fail with a 400 and every answer vanished on
 * reload (the app now saves them without that column, which is a repair, not a fix).
 *
 * Two things are needed, and neither is committed:
 *
 *   SUPABASE_ACCESS_TOKEN   a personal access token: https://supabase.com/dashboard/account/tokens
 *                           (shell env only — never a file in this repo, never pasted into a chat)
 *
 * The project ref comes from SUPABASE_PROJECT_REF, or from VITE_SUPABASE_URL in `.env`.
 *
 * The CLI is not installed here, so every Supabase command runs through `npx --yes supabase@<pin>`,
 * and `--use-api` is always passed: this machine has no Docker, so the CLI may not talk to the
 * database over a direct connection.
 *
 * Modes:
 *   (default)        apply, then verify
 *   --plan           CLIs dry run: lists the migrations that would be applied, changes nothing
 *   --check          no token needed: probe the hosted project for the objects the pending
 *                    migrations add, and say which of them are missing
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const SUPABASE_CLI = 'supabase@2.39.2';
const DEFAULT_PROJECT_REF = 'mhfsggpnnjyxsnshqatf';

const args = process.argv.slice(2);
const planOnly = args.includes('--plan');
const checkOnly = args.includes('--check');

/** `.env` holds the public URL and anon key; read them without ever printing a value. */
function readEnvFile(path) {
  const values = {};
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = line.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=(.*)$/);
    if (match) values[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return values;
}

const dotenv = { ...readEnvFile('.env'), ...readEnvFile('.env.local') };
const url = process.env.VITE_SUPABASE_URL ?? dotenv.VITE_SUPABASE_URL ?? '';
const anonKey = process.env.VITE_SUPABASE_ANON_KEY ?? dotenv.VITE_SUPABASE_ANON_KEY ?? '';
const projectRef =
  process.env.SUPABASE_PROJECT_REF ??
  /^https:\/\/([a-z0-9]+)\.supabase\.co/i.exec(url)?.[1] ??
  DEFAULT_PROJECT_REF;
const token = process.env.SUPABASE_ACCESS_TOKEN ?? '';

const isWindows = process.platform === 'win32';

function run(command, commandArgs, { capture = false } = {}) {
  const result = spawnSync(command, commandArgs, {
    stdio: capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    shell: isWindows,
    env: process.env,
  });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  return result;
}

/**
 * The objects each pending migration adds, probed through PostgREST with the anon key.
 *
 * This is the credential-free half: the Management API can say exactly which migrations the remote
 * database has recorded, but that needs the token. What can be seen without one is whether the
 * schema those migrations produce is there — which is the thing that actually breaks the app.
 * Add a probe here when a migration adds something queryable.
 */
const PENDING = [
  { migration: '20261115140000_add_user_auth_rls.sql', label: 'messages.user_id', table: 'messages', column: 'user_id' },
  { migration: '20261115150000_add_request_rate_limits.sql', label: 'request_rate_limits', table: 'request_rate_limits' },
  { migration: '20261115160000_user_engine_keys.sql', label: 'user_engine_keys', table: 'user_engine_keys' },
  { migration: '20261116170000_add_message_system_prompt.sql', label: 'messages.system_prompt', table: 'messages', column: 'system_prompt' },
  { migration: '20261117120000_add_message_tool_searches.sql', label: 'messages.tool_searches', table: 'messages', column: 'tool_searches' },
];

/** true when the object exists on the hosted project; a missing table or column is the only "false". */
async function objectExists({ table, column }) {
  const query = `select=${encodeURIComponent(column ?? '*')}&limit=1`;
  const response = await fetch(`${url}/rest/v1/${table}?${query}`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
  });
  if (response.status === 404) return false;
  if (response.status === 400) {
    const body = await response.json().catch(() => ({}));
    // 42703 is "column does not exist"; anything else is a different problem, not a missing object
    if (String(body.code ?? '') === '42703') return false;
  }
  return true;
}

async function checkHosted() {
  if (!url || !anonKey) {
    console.log('No VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in .env — cannot probe the hosted project.');
    return null;
  }
  console.log(`Hosted project: ${projectRef}`);
  const missing = [];
  for (const item of PENDING) {
    const present = await objectExists(item);
    console.log(`  ${present ? 'present' : 'MISSING'}  ${item.label}  (${item.migration})`);
    if (!present) missing.push(item.migration);
  }
  console.log(
    missing.length === 0
      ? '\nEvery object the pending migrations add is present.'
      : `\n${missing.length} migration${missing.length === 1 ? '' : 's'} look unapplied: ${missing.join(', ')}`,
  );
  return missing;
}

async function main() {
  await checkHosted();
  if (checkOnly) return 0;

  if (!token) {
    console.log(`
No SUPABASE_ACCESS_TOKEN in the environment, so nothing was applied.

  export SUPABASE_ACCESS_TOKEN=...            # Git Bash: export; PowerShell: $env:SUPABASE_ACCESS_TOKEN="..."
  npm run migrations:${planOnly ? 'plan' : 'apply'}

Create the token at https://supabase.com/dashboard/account/tokens. It stays in your shell: this
script never writes it to a file and never prints it.
`);
    return 2;
  }

  // the migrations must replay cleanly against the local schema before they run anywhere real
  console.log('Replaying the migration set locally (PGlite)…');
  const local = run(process.execPath, ['scripts/verify-migrations.mjs']);
  if (local.status !== 0) {
    console.error('\nThe local replay failed: fix the migration before applying it to the hosted project.');
    return 1;
  }

  const cli = ['--yes', SUPABASE_CLI];
  console.log('\nWhat the remote database has recorded:');
  const listed = run('npx', [...cli, 'migration', 'list', '--project-ref', projectRef]);
  if (listed.status !== 0) {
    console.error('\nmigration list failed — check the token and the project ref.');
    return 1;
  }

  const pushArgs = [...cli, 'db', 'push', '--project-ref', projectRef, '--use-api'];
  if (planOnly) pushArgs.push('--dry-run');
  console.log(`\n${planOnly ? 'Dry run' : 'Applying'}:\n  npx ${pushArgs.join(' ')}\n`);
  const pushed = run('npx', pushArgs);
  if (pushed.status !== 0) {
    console.error('\ndb push failed. DEPLOY.md §Troubleshooting covers divergence and failed migrations.');
    return 1;
  }
  if (planOnly) {
    console.log('\nNothing was changed. Run `npm run migrations:apply` to apply the list above.');
    return 0;
  }

  console.log('\nVerifying the hosted project now has what the migrations describe:');
  const missing = await checkHosted();
  if (missing && missing.length > 0) {
    console.error('\nThe push reported success but the schema is still missing objects — check the push log above.');
    return 1;
  }
  console.log('\nMigrations applied. The functions still need redeploying: see DEPLOY.md §4.');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`\n${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
