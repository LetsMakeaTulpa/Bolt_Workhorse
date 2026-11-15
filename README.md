# Fieldwork — Research Intelligence Workstation

A single-page research console: pick a model, pick search engines and surfaces, optionally run
dork playbooks, and get fused, ranked sources you can interrogate. React + Vite + TypeScript,
Supabase for data and edge functions, Featherless for inference.

## Stack

| part | where |
|---|---|
| UI | `src/` (React 18, Tailwind) |
| search + fusion | `src/lib/api.ts`, `src/lib/fusion.ts`, `src/lib/clientEngines.ts`, `src/lib/dorks.ts` |
| edge functions | `supabase/functions/web-search`, `supabase/functions/llm-proxy` |
| database | `supabase/migrations/*.sql` |
| experiments / tests | `experiments/` (plain Node scripts, no framework) |

How the pieces fit — request path, fusion, keys, data model — is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Setup

```bash
npm ci
```

Environment (`.env`, never committed):

```
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

The Featherless API key is **not** a client env var. It lives in the `app_config` table, which
is readable only by the service role; the browser reads `app_config_public` instead. Set it
server-side:

```sql
UPDATE app_config SET featherless_api_key = '<key>' WHERE id = 1;
```

## Keys in one go

Pasting keys one at a time into a dashboard is the slowest part of setup, so there is an
importer. Dump keys into `keys.txt` (gitignored) — labels, bare tokens, several per line,
`NAME=value`, `export NAME=value`, separator lines and all — then:

```bash
npm run keys:import     # classify, write .env.functions, send nothing
npm run keys:apply      # same, then push to Supabase and redeploy web-search
npm run keys:paste      # paste straight into the terminal (Ctrl-D to finish)
```

The report lists only **provider names and counts** — never a key value — so it is safe to
read or paste into a chat. It writes `.env.functions` (mode 600, gitignored) with the exact
names the functions read: `EXA_API_KEY`, `TAVILY_API_KEY`, `FIRECRAWL_API_KEY`,
`GOOGLE_API_KEY`, `SHODAN_API_KEY`, `URLSCAN_API_KEY`, `SEARXNG_URL`.

Three things it deliberately does not do:

- it never stores the Featherless key in an env file — that one belongs in `app_config`
  (see above), because the edge functions read it from the database;
- it does not invent `GOOGLE_CSE_ID`, which is a search-engine ID rather than an API key;
- it names whatever it recognises but this app cannot use (OpenAI, Kimi, OpenRouter, Venice,
  Groq, …) so you can revoke or wire them deliberately rather than leaving stray live keys.

`--apply` needs `SUPABASE_ACCESS_TOKEN`; without it the script prints the two `supabase`
commands to run yourself and exits non-zero.

## Checking a search engine actually works

Once `EXA_API_KEY` and `TAVILY_API_KEY` are set on the `web-search` function, one command proves
they return real results *and* that those results survive fusion:

```bash
npm run engines:verify
npm run engines:verify -- --query "quantum error correction" --engines exa,tavily
```

It calls the deployed function once per engine, prints a table of status, result count and
publisher domains, then runs the returned sources through `src/lib/fusion.ts` and checks that
nothing is duplicated, attribution survives, and corroborated sources are marked as such. Exit
codes: `0` verified, `1` failed, `2` not configured yet.

Every response now carries an `engine_status` array, so "0 results" is diagnosable from a single
request instead of guesswork:

```json
"engine_status": [
  { "engine": "exa",    "status": "ok",          "results": 8 },
  { "engine": "tavily", "status": "missing_key", "results": 0, "detail": "TAVILY_API_KEY is not set" }
]
```

Statuses: `ok`, `empty` (ran, found nothing), `missing_key`, `error` (with the upstream HTTP code),
`unknown_engine`. A missing or rejected key for one engine never empties the response — the other
engines still answer.

The verification script reads only `.env` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`); it
never sees the engine secrets, and the status report never contains a key value.

## Development

```bash
npm run dev        # plain vite on localhost
npm run build      # tsc + vite build
```

## Preview in the cloud sandbox

`npm run dev:preview` exists because a sandbox restore reliably breaks the preview in three
ways, and plain `npm run dev` only fixes none of them:

1. **`node_modules` is dropped** with the checkpoint (dependencies are never archived), so vite
   fails with `Cannot find package 'vite'`.
2. **The dev server process is killed** — no process outlives a restore, so it must be started
   again detached.
3. **The preview hostname changes** (`pv-<chat>-<uuid>.style.dev`). Vite answers `403` to any
   host not in `allowedHosts`, and the old hostname is no longer valid, so the panel shows a
   rejected request even though the server is healthy.

The script handles all three: it installs if `node_modules` is missing, reuses a server that is
already answering for the current host, restarts one that is not (a stale server rejects the
new hostname), starts vite detached on `0.0.0.0:3000`, then **verifies with a real HTTP request
carrying the `Host` header** before reporting success.

```bash
# first time, or whenever the panel hostname changes
PREVIEW_HOST=pv-<chat>-<uuid>.style.dev npm run dev:preview

# after that, the host is remembered in .preview-host
npm run dev:preview
```

It stores runtime state in `.preview-host` and `.vite.pid` (both gitignored) and logs to
`/tmp/vite.log`. Exit code is non-zero, with the tail of the log, if the server never answers —
so a failed start is never reported as a working preview.

Ask the agent for the current hostname, or read it from the Browser panel URL. The hostname is
also what makes the preview reachable: the browser in the panel loads
`https://<host>/`, and Vite must be told that exact host or it will 403.

**A preview is not a deployment.** It runs the dev server on this VM; nothing is published.

## Database

Apply migrations in filename order (`supabase db push`, or paste them into the SQL editor):

- `20261111182132_create_workhorse_schema.sql` — conversations, messages, findings, search_settings
- `20261111193222_fieldwork_schema_expansion.sql` — sources, evidence, activity logs, projects, presets
- `20261112192624_create_app_config.sql` — `app_config` (seeded **without** a key)
- `20261112192634_grant_service_role_config.sql` — service-role read access
- `20261115120000_lock_app_config_service_role.sql` — `app_config` service-role only, plus `app_config_public`
- `20261115130000_tighten_anon_write_grants.sql` — trims anon writes to what the client uses
- `20261115140000_add_user_auth_rls.sql` — per-user ownership (`user_id`, `DEFAULT auth.uid()`) and
  `user_id = auth.uid()` policies; `anon` loses every private table
- `20261115150000_add_request_rate_limits.sql` — counter table plus the atomic
  `consume_rate_limit()` used by the inference proxy
- `20261115160000_user_engine_keys.sql` — per-account provider keys, owner-only RLS

Both functions must be redeployed after the schema:
[DEPLOY.md](DEPLOY.md) is the runbook for that order, its verification steps and its rollback.

## Rate limits

The anon key is public, and every inference request spends the owner's Featherless credits, so
`llm-proxy` counts callers before it reads the key or forwards anything
([`rateLimit.ts`](supabase/functions/llm-proxy/rateLimit.ts)):

| caller | per minute | per day |
| --- | --- | --- |
| signed-in account | 30 | 600 |
| no session (IP) | 4 | 40 |

The bucket is a SHA-256 hash of the auth user id, or of the client IP when no valid token is sent
(`cf-connecting-ip`, else the first `x-forwarded-for` hop). Counters live in
`request_rate_limits`, which no client role can read or write, and the insert-or-increment is one
atomic upsert so concurrent requests cannot both slip under the limit. A refusal is HTTP 429 with
`Retry-After` and a `rate_limited` body, which the client shows verbatim and never retries as if
it were model capacity.

If the counter itself errors the request is allowed and the failure is logged — an availability
choice, not a silent bypass: the proxy still needs a working database to spend credits.

## Accounts

The app requires a Supabase Auth account (email + password, entered in the gate at
`src/components/AuthScreen.tsx`). Identity comes from the session; every row is scoped by RLS to
`auth.uid()`, so two accounts on the same deployment never see each other's research. Inserts send
no `user_id` — the column defaults to the caller.

After applying `20261115140000_add_user_auth_rls.sql`, rows created before it have no owner and are
invisible to everyone. Hand them to your account once, as the service role:

```sql
UPDATE public.conversations SET user_id = '<your-auth-user-uuid>' WHERE user_id IS NULL;
UPDATE public.messages m SET user_id = c.user_id FROM public.conversations c
  WHERE m.conversation_id = c.id AND m.user_id IS NULL;
UPDATE public.sources s SET user_id = c.user_id FROM public.conversations c
  WHERE s.conversation_id = c.id AND s.user_id IS NULL;
UPDATE public.findings f SET user_id = c.user_id FROM public.conversations c
  WHERE f.conversation_id = c.id AND f.user_id IS NULL;
```

Sign-up email confirmation follows your project's Auth settings; with confirmation on, the gate
shows “open the confirmation link” instead of signing in immediately.

## Checks

One command runs everything — build plus every experiment test — and prints a pass/fail/skip
summary (`npm run smoke -- --live` also probes the live database, read-only):

```bash
npm run smoke
```

It installs `@electric-sql/pglite` on demand (test-only, not saved to package.json) and reports
**SKIP** rather than a pass when a check genuinely cannot run. The individual scripts are
standalone too, and exit non-zero on failure:

```bash
node experiments/app-config-lockdown.test.mjs   # needs @electric-sql/pglite (npm i --no-save)
node experiments/rls-write-audit.test.mjs
node experiments/auth-rls.test.mjs              # two accounts, isolated
node experiments/rate-limit.test.mjs            # proxy limiter + atomic windows
npx esbuild src/lib/api.ts --bundle --format=esm --outfile=/tmp/api.mjs \
  --define:import.meta.env.VITE_SUPABASE_URL='"https://proxy.test"' \
  --define:import.meta.env.VITE_SUPABASE_ANON_KEY='"anon"' \
&& node experiments/model-fallback.test.mjs
bash experiments/rls-probe.sh                   # read-only probes against the live database
node scripts/import-keys.mjs experiments/fixtures/keys-sample.txt --out-dir /tmp/keytest
```
