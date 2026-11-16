# Deploy runbook

This is the one-time (then repeatable) procedure for bringing a deployment up to the code in this
repository. It exists because the hosted project is **behind the repo**: three migrations have
never been applied and both edge functions still run code from before `engine_status`, per-user
keys, rate limiting and the rejected-key fallback.

Everything below assumes a Supabase **access token** is available. Until it is, nothing in this
file can run — the token is what authorises `db push`, `secrets set` and `functions deploy`, and it
is never committed, never written to a file in this repo, and never pasted into a chat.

Nothing here changes application code. If a step needs a code change, stop and fix it in a normal
commit first.

**The CLI is not installed on this machine** (`supabase: command not found`). Every command below
works when prefixed with `npx --yes supabase@latest`, e.g.
`npx --yes supabase@latest db push --dry-run`. `npm run keys:apply` is the exception: it shells out
to `supabase` directly, so it needs the CLI on `PATH` first.

---

## 0. What is pending

Project ref: **`mhfsggpnnjyxsnshqatf`** (hardcoded in `scripts/import-keys.mjs`; confirm with
`supabase projects list` before using it, and fix the script if it disagrees).

| Item | Repo state | Hosted state |
| --- | --- | --- |
| `20261115140000_add_user_auth_rls.sql` | present | **not applied** |
| `20261115150000_add_request_rate_limits.sql` | present | **not applied** |
| `20261115160000_user_engine_keys.sql` | present | **not applied** |
| `llm-proxy` | rate limiting, session-scoped keys | **stale** |
| `web-search` | `engine_status`, per-user keys, `key_fallback`, the `GET` configuration probe | **stale** |

Do not trust the table — the authoritative answer is the CLI:

```bash
supabase migration list --project-ref mhfsggpnnjyxsnshqatf   # local vs remote
supabase functions list  --project-ref mhfsggpnnjyxsnshqatf   # deployed version + updated_at
```

Any migration the first command shows as local-only is part of this deploy. The order is the
filename order, always.

### Why the order is migrations → secrets → functions

The functions read schema that does not exist yet. Each pairing degrades rather than breaks, but
in this order there is no degraded window at all:

- `web-search` without `user_engine_keys` → the key lookup fails, is logged, and every request
  silently runs on the deployment's secrets. Works, but per-user keys appear ignored.
- `llm-proxy` without `request_rate_limits` → `consume_rate_limit` errors, the request is
  **allowed** and the failure logged. Works, but the proxy spends credits uncounted.

---

## 1. Preflight (no token needed yet)

```bash
git status --porcelain          # expect only the changes you intend to deploy
npm run build                   # tsc -b && vite build
npx tsc --noEmit -p tsconfig.json
npm run smoke                   # the gate; runs anywhere Node does, Windows included
```

Require **all checks green with 0 failed** before deploying, on whichever platform you are on. The
runner is `scripts/smoke.mjs`: it takes temp paths from `os.tmpdir()`, builds through
`experiments/lib/build.mjs`, and never touches the shell, so it needs no WSL and no Git Bash. A
`SKIPPED` line is not green — it means a test-only package could not be installed or the live probe
could not run.

One check can be run on its own, which is what to do while iterating:

```bash
node experiments/web-engine-pipeline.test.mjs    # bundles its own copy of the handler
```

---

## 2. Back up the database first

Migrations here are additive, but `20261115140000_add_user_auth_rls.sql` changes ownership and
revokes `anon` grants; a bad run is not something to discover without a dump.

Either take a dashboard backup (Database → Backups), or:

```bash
pg_dump "$SUPABASE_DB_URL" --no-owner --no-privileges -Fc -f fieldwork-pre-rls.dump
```

`SUPABASE_DB_URL` is the connection string from Project Settings → Database. Keep the dump outside
the repo.

---

## 3. Apply the migrations

```bash
export SUPABASE_ACCESS_TOKEN=...          # shell env only; never a file in this repo
supabase link --project-ref mhfsggpnnjyxsnshqatf
supabase db push --dry-run                # lists exactly what will run
supabase db push
```

`db push` runs each file in filename order. Each file opens with `BEGIN` and ends with `COMMIT`, so
a failure rolls that migration back rather than leaving it half-applied — which is also why a
migration must never be edited after it has run anywhere.

Verify — as the service role, in the SQL editor:

```sql
-- 1. auth/RLS
select tablename, rowsecurity from pg_tables where schemaname = 'public' order by 1;

-- 2. rate limiting
select proname from pg_proc where proname = 'consume_rate_limit';
select count(*) from public.request_rate_limits;

-- 3. per-user keys
select tablename, policyname, cmd from pg_policies where tablename = 'user_engine_keys';
select column_default from information_schema.columns
 where table_name = 'user_engine_keys' and column_name = 'user_id';   -- expects auth.uid()
```

Expected: `user_engine_keys` exists with owner-only policies and **no** `anon` grant;
`consume_rate_limit()` exists; `request_rate_limits` exists with RLS on and no policies.

### Adopt pre-RLS rows (only on the first ever run of `…140000`)

Rows created before `add_user_auth_rls` have `user_id IS NULL` and are invisible to every account.
Hand them to your own account once, as the service role — the SQL is in
[`README.md`](README.md#accounts). Skip this if the tables are empty or every row already has an
owner.

---

## 4. Secrets

Only needed if provider keys changed. Names, never values, are safe to print:

```bash
supabase secrets list --project-ref mhfsggpnnjyxsnshqatf
supabase secrets set --env-file .env.functions --project-ref mhfsggpnnjyxsnshqatf
```

`.env.functions` is written by `npm run keys:import` and is gitignored. Secrets take effect for
already-deployed functions without a redeploy; the redeploy in step 5 is for the code, not the
keys. The Featherless key is **not** a secret here — it lives in `app_config` (see README).

---

## 5. Deploy both functions

```bash
supabase functions deploy llm-proxy --project-ref mhfsggpnnjyxsnshqatf
supabase functions deploy web-search --project-ref mhfsggpnnjyxsnshqatf
```

Both are `verify_jwt = false` in `supabase/config.toml`, and both verify the caller's token
themselves where they need to (`web-search` to resolve per-user keys, `llm-proxy` to bucket the
rate limit by user id). Do not "fix" that flag.

Expect the CLI to report a new version per function and an `updated_at` within the last minute in
`supabase functions list`.

`supabase/functions-deploy-state.json` is tracked and the CLI rewrites it. Commit it with the
deploy so the recorded hashes match what is actually running; that file is how the next person can
tell a stale function from a current one.

---

## 6. Verify the deployment

Run these in order; each one is a property of the *deployed* code, not of the local build.

**a. The function answers at all**

```bash
curl -sS -X POST "$VITE_SUPABASE_URL/functions/v1/web-search" \
  -H "apikey: $VITE_SUPABASE_ANON_KEY" -H "content-type: application/json" \
  -d '{"query":"graph neural network survey","engines":["exa","tavily"],"maxResultsPerEngine":5}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const b=JSON.parse(s);console.log(b.engine_status)})'
```

Expected: a non-empty `engine_status` array. Its absence means the old function is still deployed.
The payload must contain no key values — only names and statuses.

**a2. The configuration probe answers**

```bash
curl -sS "$VITE_SUPABASE_URL/functions/v1/web-search" \
  -H "apikey: $VITE_SUPABASE_ANON_KEY"
```

Expected: `{"configured":["EXA_API_KEY",...]}` — the secret *names* this deployment holds, never a
value. A 500 here means the function predates the probe; the composer then keeps reporting those
engines as "unknown", which is honest but not what the UI is for. Ten names live in
`KNOWN_SECRETS` in `supabase/functions/web-search/index.ts`; add one there when a new engine needs a
secret, or the probe will not report it.

**b. Every engine's report is honest**

```bash
npm run engines:verify
```

This calls the deployed function once per engine and prints status, result count and detail. Read
it as: `ok` = answered, `empty` = answered with nothing, `missing_key` = no key for this account
*or* the deployment, `error` = the provider refused the request, `key_fallback` = a personal key
was refused and the deployment's key answered.

**c. Per-user keys actually take precedence**

1. Sign in, open Settings → provider keys, paste a real provider key, save.
2. The composer's key row should show that engine as configured (a stored name is enough to claim
   this; it is not proof the key works).
3. Search with that engine. A `key_fallback` detail naming that key means the provider rejected it.
4. Save a deliberately invalid value for that key and search again: expected `key_fallback` with
   `your … was rejected (http 401); used the function's own key` — results still returned. This is
   the only check that exercises the fallback on a real 401.
5. Remove the invalid key afterwards.

**d. Rate limiting is live and counted**

Call `llm-proxy` repeatedly until it refuses:

```bash
for i in $(seq 1 8); do
  curl -s -o /dev/null -w "%{http_code} " -X POST "$VITE_SUPABASE_URL/functions/v1/llm-proxy" \
    -H "apikey: $VITE_SUPABASE_ANON_KEY" -H "content-type: application/json" \
    -d '{"messages":[{"role":"user","content":"ping"}],"max_tokens":1}'
done; echo
```

Expected: a run of non-429s followed by 429s carrying `Retry-After` and a `rate_limited` body (an
anonymous caller is budgeted 4/minute). Then confirm the counter table is populated and closed to
clients:

```sql
select count(*) from public.request_rate_limits;
set role anon; select * from public.request_rate_limits;   -- expect permission denied
reset role;
```

**e. Isolation still holds**

With the anon key and no session, `GET /rest/v1/conversations?select=id` must return `[]` or
`401`/`403`, never another account's rows. Two signed-in accounts must not see each other's
searches.

---

## 7. If something goes wrong

**A function must be rolled back.** Redeploy the previous commit:

```bash
git checkout <previous-sha> -- supabase/functions
supabase functions deploy llm-proxy --project-ref mhfsggpnnjyxsnshqatf
supabase functions deploy web-search --project-ref mhfsggpnnjyxsnshqatf
git checkout HEAD -- supabase/functions
```

**A migration failed.** Fix forward with a new migration; do not hand-edit the applied file. If a
migration ran but the CLI does not know it:

```bash
supabase migration list --project-ref mhfsggpnnjyxsnshqatf
supabase migration repair --status applied 20261115160000 --project-ref mhfsggpnnjyxsnshqatf
```

Use `repair` only when you have confirmed the objects exist in SQL — it records history, it does
not change schema.

**`db push` reports divergence.** Someone applied a migration by hand. Reconcile with
`migration repair` per version, never by resetting a database that holds user research.

**Searches return nothing and `engine_status` says `missing_key`.** That is the intended report: no
key for this account and none in the function environment. Set one (step 4) or supply a personal
key.

**Everything 401s in the browser.** The client's `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`
belong to a different project than the one just deployed.

---

## 8. One-pass checklist

```text
[ ] git status clean except intended changes
[ ] npm run build passes; tsc --noEmit passes
[ ] npm run smoke green (27 checks, 0 failed, no skips)
[ ] database dumped outside the repo
[ ] supabase migration list reconciles local vs remote
[ ] supabase db push --dry-run reviewed, then db push
[ ] user_engine_keys, request_rate_limits, consume_rate_limit, RLS verified in SQL
[ ] pre-RLS rows adopted (first run only)
[ ] secrets set if provider keys changed
[ ] llm-proxy and web-search deployed, updated_at current
[ ] supabase/functions-deploy-state.json committed
[ ] engine_status present in a live response
[ ] npm run engines:verify read line by line
[ ] invalid-key search returns key_fallback, not an error
[ ] llm-proxy returns 429 + Retry-After; counters invisible to anon
[ ] anon cannot read another account's rows
```
