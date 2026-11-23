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
 *   --check          no token needed: probe the hosted project for the objects the migrations
 *                    describe, read from the SQL files themselves. Exits 1 when any is missing and
 *                    2 when it cannot reach a verdict (no URL or anon key, or a migration whose SQL
 *                    the reader cannot name) — so a build can depend on it
 *   --dry            the same probe and the same list, but never a failure: for a log you want to
 *                    read rather than gate on. Still exits 2 when it cannot probe, because then
 *                    there is no list to print
 *
 * Every request gives up after TIMEOUT_MS (scripts/probeExit.mjs), and the first object that gets no
 * answer ends the pass: the run is already red, and asking the rest would only spend the job's own
 * timeout reaching the verdict it already has.
 */
import { spawnSync } from 'node:child_process';
import { migrationProbes } from './migrationProbes.mjs';
import { BLIND, OK, TIMEOUT_MS, verdict } from './probeExit.mjs';
import { anonKey, projectRef, url } from './supabaseEnv.mjs';

const SUPABASE_CLI = 'supabase@2.39.2';

const args = process.argv.slice(2);
const planOnly = args.includes('--plan');
const checkOnly = args.includes('--check');
const dryRun = args.includes('--dry');

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
 * Every object the migrations add, probed through PostgREST with the anon key.
 *
 * This is the credential-free half: the Management API can say exactly which migrations the remote
 * database has recorded, but that needs the token. What can be seen without one is whether the
 * schema those migrations produce is there — which is the thing that actually breaks the app.
 *
 * The list is read from `supabase/migrations` rather than kept here by hand, so a migration cannot
 * join the repository without joining the gate. A construct the reader cannot name comes back as
 * `unprobed` and is a blind spot, not a pass.
 */

/** true when the object exists on the hosted project; a missing table or column is the only "false". */
async function objectExists({ table, column }) {
  const query = `select=${encodeURIComponent(column ?? '*')}&limit=1`;
  const response = await fetch(`${url}/rest/v1/${table}?${query}`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
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
    console.log('No VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in .env or the environment — cannot probe the hosted project.');
    return null;
  }
  const { probes, unprobed, files } = migrationProbes();
  console.log(`Hosted project: ${projectRef}`);
  console.log(
    `Probes derived from ${files.length} migrations: ${probes.length} object${probes.length === 1 ? '' : 's'}`,
  );
  for (const item of unprobed) console.log(`  UNPROBED  ${item.migration}: ${item.reason}`);

  const missing = [];
  let stoppedAt = null;
  for (const [index, item] of probes.entries()) {
    let present;
    try {
      present = await objectExists(item);
    } catch (error) {
      // A timeout or a dropped connection says nothing about whether the object is there, so it is a
      // blind spot rather than a missing object. It also ends the pass: the next twenty requests would
      // each wait out the same timeout to reach a verdict this run already has, and the job's own limit
      // would kill it with no verdict at all.
      const reason = error?.name === 'TimeoutError' ? `no answer in ${TIMEOUT_MS / 1000}s` : (error?.message ?? String(error));
      console.log(`  ?????  ${item.label}  (${item.migration}) — ${reason}`);
      stoppedAt = { item, reason, unasked: probes.length - index - 1 };
      break;
    }
    console.log(`  ${present ? 'present' : 'MISSING'}  ${item.label}  (${item.migration})`);
    if (!present) missing.push(item.migration);
  }
  // One migration can add several objects, so the file names are deduplicated: a list that repeats
  // `20261115140000` seven times reads as seven migrations and sends the reader looking for six that
  // are not there.
  const unapplied = [...new Set(missing)];
  console.log(
    unapplied.length === 0
      ? '\nEvery object the migrations describe is present.'
      : `\n${missing.length} object${missing.length === 1 ? '' : 's'} missing, from ${unapplied.length} migration${
          unapplied.length === 1 ? '' : 's'
        }: ${unapplied.join(', ')}`,
  );
  if (stoppedAt) {
    console.log(
      `\nStopped at ${stoppedAt.item.label} (${stoppedAt.reason}): ${stoppedAt.unasked} object${
        stoppedAt.unasked === 1 ? '' : 's'
      } never asked.`,
    );
  }
  return { missing, unprobed, stoppedAt };
}

async function main() {
  const report = await checkHosted();
  if (checkOnly || dryRun) {
    if (report === null) return BLIND;
    // `--dry` is a log, not a gate: it never fails on what it found, but it still refuses to report
    // success for a probe it never ran.
    if (report.unprobed.length > 0) {
      console.error(
        '\nThe gate cannot cover every migration: teach scripts/migrationProbes.mjs the construct above, so the schema it adds is checked rather than assumed.',
      );
    }
    if (report.stoppedAt) {
      console.error('\nThe hosted project stopped answering, so the schema was not checked to the end.');
    }
    // `--dry` never fails on what it found — but with no answer there is no list to read, the same
    // reason it refuses to report success for a probe it never ran.
    const code = verdict({
      failed: report.missing.length > 0,
      blind: report.unprobed.length > 0 || report.stoppedAt !== null,
    });
    if (dryRun) return report.stoppedAt ? BLIND : OK;
    return code;
  }

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
  const stillMissing = await checkHosted();
  if (stillMissing && stillMissing.unprobed.length > 0) {
    console.error('\nThe push reported success, but a migration adds objects this gate cannot probe — the schema is not proven, only partly checked.');
  }
  if (stillMissing && stillMissing.missing.length > 0) {
    console.error('\nThe push reported success but the schema is still missing objects — check the push log above.');
  }
  if (stillMissing && stillMissing.stoppedAt) {
    console.error('\nThe push reported success, but the project stopped answering — the schema is not proven, only partly checked.');
  }
  if (stillMissing) {
    const code = verdict({
      failed: stillMissing.missing.length > 0,
      blind: stillMissing.unprobed.length > 0 || stillMissing.stoppedAt !== null,
    });
    if (code !== OK) return code;
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
