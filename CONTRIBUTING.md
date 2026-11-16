# Contributing

Fieldwork is a research console: many search engines, one fused ranking, an LLM answer over the
sources. Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing the ranking or the search path —
it explains the pipeline (canonicalise → IDF relevance → intent-weighted RRF → entity resolution →
coverage quota → tail fill) and why each stage exists. [README.md](README.md) covers running it.

## Setup

```bash
npm install
npm run dev          # vite on :5173
npm run build        # tsc -b && vite build
```

`.env` needs `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`; both are public values that ship in
the browser bundle. Anything secret belongs on the search function (see [Secrets](#secrets)).

## The gate

`npm run smoke` is the merge gate. It builds, then runs every check in `scripts/smoke.mjs`:

```bash
npm run smoke            # build + unit/db tests, no network
npm run smoke -- --live  # + read-only probes against the live Supabase project (needs .env)
```

Rules a change has to respect:

- **Green means every check that ran passed, 0 failed** — 23 on a full install (19 that always run,
  plus 4 database checks). The script exits non-zero if anything fails; do not merge on a red run,
  and do not treat a red run as "probably the environment" without reading the log. Failing checks
  print the last 20 lines of their output.
- **A skip is not a pass.** Two test-only packages are deliberately not in `package.json` and are
  installed with `npm install --no-save` when the network allows: `@electric-sql/pglite` for the
  four database checks, and `react-test-renderer` for the check that mounts `useSearch`. When one
  of them cannot be installed the affected checks report SKIPPED. Do not add them to dependencies
  to make a skip go away, and do not claim a skipped check passed.
- **The gate is portable.** `npm run smoke` runs on Windows as well as Linux and macOS, so a red
  run is your change, not the platform.
- **Never weaken a check to get green.** No skipped assertions, no widened tolerances, no
  `2>/dev/null` around the failing command. If a check is wrong, fix the check in its own commit and
  say why in the message.

### Adding a check

1. Write `experiments/<area>.test.mjs`. Plain Node, `node:assert/strict`, no test framework.
2. Bundle the **real** source and import it, so the test cannot drift from what ships:

   ```js
   import { asUrl, bundle, tmpPath } from './lib/build.mjs';

   const out = tmpPath('api.mjs'); // os.tmpdir(): absolute, and correct on every platform
   bundle('src/lib/api.ts', out, [
     '--define:import.meta.env.VITE_SUPABASE_URL="https://proxy.test"',
     '--define:import.meta.env.VITE_SUPABASE_ANON_KEY="anon"',
   ]);
   const { chatCompletion } = await import(`${asUrl(out)}?t=${Date.now()}`);
   ```

   Two Windows traps this helper exists to avoid: a literal `/tmp` is `C:\tmp` to Node but the OS
   temp directory to a native binary, and spawning `npx` goes through `cmd.exe`, which strips the
   quotes out of `--define` and turns the value into invalid JSON. Build with the esbuild that
   ships with vite, under `node`, and import bundles by `file://` URL (`asUrl`).

   Stub the edges, not the logic: `globalThis.fetch` for the proxy, `localStorage` for reliability
   state, `WebSocket` on Node 20 (supabase-js constructs a realtime client at import).
3. Print one `PASS`/`FAIL` line per assertion and `N/M assertions passed`, then
   `process.exit(failed.length ? 1 : 0)`.
4. Register it in `scripts/smoke.mjs` as one line in the list, with a comment saying what it
   protects. The runner is Node, so the step is the command it runs, not a shell function:

   ```js
   // a superseded search stops its requests instead of finishing and overwriting
   nodeTest('search abort', 'experiments/search-abort.test.mjs');
   ```

   Use `run(name, command, args, { env })` when the command is not `node <script>` — `build` and
   `ranking benchmark` do that — and `skip(name, reason)` for a check whose test-only package is
   missing.

5. Update the expected total in this document only after the check passes locally.

A component can be asserted on without a browser: bundle it with `--jsx=automatic` and
`--external:react --external:react-dom` **into the project, e.g. `node_modules/.cache/fieldwork/`,
not the temp directory** (an external `react` needs a `node_modules` above it to resolve), then
render it with `renderToStaticMarkup` and assert on the HTML. `experiments/engine-key-status.test.mjs`
does this for the composer's key row; it proves the wiring and the copy, not the layout. When the
behaviour unfolds over time — a request that lands after it was replaced — mount the real hook
instead: `experiments/use-search-supersede.test.mjs` drives `useSearch` with `react-test-renderer`
and `act`, which needs no DOM at all.

The default run makes no network calls. Anything that needs a live service goes behind `--live` and
must be read-only.

`npm run engines:verify` is the other end-to-end probe, outside smoke: it calls the deployed
`web-search` function engine by engine, then runs what came back through the client's own fusion
layer. Read-only, needs `.env`, and exits 2 when that file has no Supabase URL or key. It is the
check that catches a deployed function drifting behind the source, because it looks at
`engine_status` and reports an older deployment as undiagnosed rather than as a pass.

## Ranking changes

Ranking is the part most likely to regress invisibly, so it has its own gate inside smoke:

```bash
node experiments/ranking-harness.mjs --check     # fails on nDCG or margin regression vs flat trust
node experiments/ranking-harness.mjs --compare spec.json   # score your own before/after weights
node experiments/ranking-sweep.mjs --ablate      # what each constant buys
node experiments/ranking-sweep.mjs --stability    # leave-one-out across queries
```

`--compare` is the harness for a weight change you are about to make. A spec is
`{ "before": config, "after": config }` where a config is `{ "label", "weights", "recency" }` and
`weights` is `"flat"` (pre-intent table, keyword routing only), `"intent"` (engine character as
fusion applies it) or an explicit `{ engine: number }` map; omit `recency` to keep fusion's default.
It prints the same nDCG/MRR/margin table with your labels in the header, and the
`fresh-tie`/`semantic-tie` discrimination gate is skipped, because a spec is allowed to move nothing.
`experiments/fixtures/weight-experiment.example.json` is a working starting point, and
`experiments/ranking-compare.test.mjs` keeps the mode honest: the named modes must reproduce the
default pair exactly, identical configs must score identically, and a bad spec must exit 2.

The fixture in `experiments/fixtures/ranking-queries.json` is **contested on purpose**: each query
pairs two results with near-identical term coverage, so only engine trust or a publication date can
separate them. Keep title-token Jaccard below 0.6 so entity resolution does not merge the pair, keep
at least one control query where the answer must not move, and record the rationale in the query's
`contested` field. A query set whose every top hit is on-topic scores the same under any weighting
and silently measures nothing.

The sharpest queries are the ones tagged `"tie": "recency"` or `"tie": "intent"` (classes
`fresh-tie` and `semantic-tie`). Their on-topic pair is *exactly* equal on IDF-weighted coverage, so
relevance cannot order them: in a recency tie the stale result is placed at a better rank, and in an
intent tie the keyword engine's result holds the higher flat trust. Only freshness or intent
weighting can move them, which means an unchanged score there is a real finding rather than noise.

Three audits enforce that instead of trusting the prose: `--check` fails when a tie pair's coverage
differs, when its titles are close enough to merge into one entity (measured, 0.6 Jaccard), or when a
`*-tie` class stops improving by at least 0.05 nDCG. `termCoverage` is exported from `fusion.ts` for
exactly this, so the fixture cannot quietly stop being contested.

Report `margin` alongside nDCG: it is the order-free gap between the best and the best lesser
result, so it moves when a weighting widens a lead without changing which result is first. `--check`
gates it as well as nDCG — an overall mean margin down by more than 0.02, or a class mean down by
more than 0.05, fails — because a lead that shrinks is the leading edge of the next reorder, which
order metrics cannot see. Every query whose margin narrowed by 0.05 or more is listed under the
overall block, so a cause is visible even when the mean holds. State the
measured effect of a constant in the commit body, and say plainly when a gain rests on a single
query.

## Migrations

- One file per change: `supabase/migrations/YYYYMMDDHHMMSS_snake_case.sql`.
- Every table reachable from the browser is protected by RLS scoped to `auth.uid()`. Policies are
  tested in `experiments/` against PGlite (`auth-rls`, `rls-write-audit`, `app-config-lockdown`);
  add a case for any new table or grant.
- The anon key must not be able to write. Grants for the service role live in their own migration.
- Do not run `supabase login`, `supabase db push`, or any interactive CLI auth in a shared
  environment — applying migrations to the hosted project needs an access token supplied out of
  band, and the agent sandbox has none.

## Secrets

- Provider keys live as secrets on the `web-search` function and the `llm-proxy`, never in `src/`,
  never in a commit, never in a screenshot, never pasted into an issue or a chat message. The names
  the search function reads are `EXA_API_KEY`, `TAVILY_API_KEY`, `GOOGLE_API_KEY`,
  `GOOGLE_CSE_ID`, `SEARXNG_URL`, `FIRECRAWL_API_KEY`, `SHODAN_API_KEY`, `URLSCAN_API_KEY`,
  `GREPAPP_BASE_URL` and `GREPAPP_COOKIE`.
- Per-user keys are entered in Settings → provider keys and stored per account in
  `user_engine_keys`; the function prefers the caller's row over its own env secret. If the provider
  rejects that row (401/403), the engine is retried once on the deployment's secret and reports
  `key_fallback` rather than failing — a stale personal key must not break a working deployment,
  and it must not disappear silently either.
- `.env` holds only `VITE_`-prefixed public values. `keys.txt`, `keys*.txt` and `.env.functions` are
  gitignored because the importer writes key material into them. Keep them off any branch.
- `.env` is currently tracked in this repo with the Supabase URL and anon key only. Do not add
  anything private to it, and do not commit a key file even if `.gitignore` would let it through.

## Commits and history

- Conventional Commits, scoped to the area touched:
  `feat(search)`, `fix(fusion)`, `refactor(search)`, `test(ranking)`, `docs`.
- Subject in the imperative, no trailing period. The body explains **why** the change was needed and
  what it measurably changed (nDCG before → after, checks that failed and how they now pass). A body
  that restates the diff is not useful.
- `main` stays linear and green. No force-pushes, no rewriting published history.
- Do not commit build output or local state: `node_modules/`, `dist/`, `artifacts/`,
  `.vite.pid`, `.preview-host`. `tsconfig.tsbuildinfo` is tracked and regenerated by every build —
  restore it (`git checkout -- tsconfig.tsbuildinfo`) before committing so it does not add churn.
- Attribution trailers used by this repo's AI-assisted commits:
  `🤖 Generated with Codebuff` and `Co-Authored-By: Codebuff <noreply@codebuff.com>`.

## Before you open a change

- [ ] `npm run smoke` is green (or the failures are reported, with the reason).
- [ ] New behaviour has at least one assertion that fails without it.
- [ ] Ranking or search-pipeline changes were measured on the contested fixture, not on vibes.
- [ ] `ARCHITECTURE.md` updated if a stage, constant or data flow changed.
- [ ] No new dependency without a sentence in the commit body justifying it. Tests must not add
      runtime dependencies at all.
- [ ] No secrets, key files or local state in the diff.

## Temp paths, and running the checks on Windows

Every harness resolves its temp paths through the platform, so the gate runs on Windows as well as
Linux and macOS. There are exactly two patterns, and a new check should use one of them rather than
writing a path of its own:

- **`experiments/lib/build.mjs`** is the normal one. `tmpPath(name)` returns an absolute path in
  `os.tmpdir()`, `bundle(entry, out, extra)` builds with the esbuild that ships with vite run under
  `node`, `bundleSync` returns the child's result for tests that assert on a failure, `asUrl` turns a
  path into the `file://` URL that `import()` needs, and `installWebSocketStub` supplies the one
  member supabase-js touches at import on Node 20. Every suite that bundles real source uses these;
  `npm run engines:verify` does too.
- **`mkdtempSync(join(tmpdir(), …))`** when a check owns a scratch directory rather than a single
  bundle. `experiments/ranking-compare.test.mjs` makes one, writes its spec files there and hands the
  path to `experiments/ranking-harness.mjs` through `RANKING_MODULE`.

No Node harness spawns `npx` or names a literal `/tmp` at runtime: `/tmp` is `C:\tmp` to Node but
not to a native binary, and `npx` goes through `cmd.exe`, which strips the quotes out of `--define`
and turns the value into invalid JSON. `scripts/smoke.mjs` passes absolute paths and needs nothing
from the shell, so the gate runs from `npm run smoke` on a plain Windows install; `experiments/use-search-supersede.test.mjs` and
`experiments/engine-key-status.test.mjs` are the deliberate exception, bundling into
`node_modules/.cache/fieldwork/` because a `react` kept external has to resolve from the project's
own `node_modules`.

A harness that can take a bundle built elsewhere still accepts a `*_MODULE` (or `*_DIR`) override —
`API_MODULE`, `PIPELINE_MODULE`, `RANKING_MODULE`, `PARSERS_MODULE`, `SEARXNG_MODULE`, `BADGES_DIR`,
`ABORT_DIR`, `USESEARCH_DIR` and the rest — and builds its own when none is set. Use the helper
rather than a fresh copy of the build commands: that duplication is what left this repository
unverifiable on Windows for a while, with each suite failing for its own local reason.

Never work around a red run by removing assertions, and never report a check as passing when it
could not execute.
