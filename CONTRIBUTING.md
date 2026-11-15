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

`npm run smoke` is the merge gate. It builds, then runs every check in `scripts/smoke.sh`:

```bash
npm run smoke            # build + unit/db tests, no network
npm run smoke -- --live  # + read-only probes against the live Supabase project (needs .env)
```

Rules a change has to respect:

- **Green means every check that ran passed, 0 failed** — 17 on a full install (13 that always run,
  plus 4 database checks). The script exits non-zero if anything fails; do not merge on a red run,
  and do not treat a red run as "probably the environment" without reading the log. Failing checks
  print the last 20 lines of their output.
- **A skip is not a pass.** Four database checks need `@electric-sql/pglite`, which is
  test-only and deliberately not in `package.json`; the script installs it with
  `npm install --no-save` when it can, and reports SKIPPED when it cannot. Do not add PGlite to
  dependencies to make the skip go away, and do not claim a skipped check passed.
- **Never weaken a check to get green.** No skipped assertions, no widened tolerances, no
  `2>/dev/null` around the failing command. If a check is wrong, fix the check in its own commit and
  say why in the message.

### Adding a check

1. Write `experiments/<area>.test.mjs`. Plain Node, `node:assert/strict`, no test framework.
2. Bundle the **real** source and import it, so the test cannot drift from what ships:

   ```js
   execFileSync('npx', ['--yes', 'esbuild', 'src/lib/api.ts', '--bundle', '--format=esm',
     '--outfile=/tmp/api.mjs', '--log-level=error'], { stdio: 'inherit' });
   const { chatCompletion } = await import(`/tmp/api.mjs?t=${Date.now()}`);
   ```

   Stub the edges, not the logic: `globalThis.fetch` for the proxy, `localStorage` for reliability
   state, `WebSocket` on Node 20 (supabase-js constructs a realtime client at import).
3. Print one `PASS`/`FAIL` line per assertion and `N/M assertions passed`, then
   `process.exit(failed.length ? 1 : 0)`.
4. Register it in `scripts/smoke.sh` as a small function plus one comment saying what it protects:

   ```bash
   search_abort() { node experiments/search-abort.test.mjs; }
   # 4g. a superseded search stops its requests instead of finishing and overwriting
   run "search abort" search_abort
   ```

5. Update the expected total in this document only after the check passes locally.

A component can be asserted on without a browser: bundle it with `--jsx=automatic` and
`--external:react --external:react-dom` **into `node_modules/.cache/` rather than `/tmp`** (an
external `react` cannot resolve from the OS temp dir), then render it with `renderToStaticMarkup`
and assert on the HTML. `experiments/engine-key-status.test.mjs` does this for the composer's key
row; it proves the wiring and the copy, not the layout.

The default run makes no network calls. Anything that needs a live service goes behind `--live` and
must be read-only.

## Ranking changes

Ranking is the part most likely to regress invisibly, so it has its own gate inside smoke:

```bash
node experiments/ranking-harness.mjs --check     # fails on nDCG regression vs flat trust
node experiments/ranking-sweep.mjs --ablate      # what each constant buys
node experiments/ranking-sweep.mjs --stability    # leave-one-out across queries
```

The fixture in `experiments/fixtures/ranking-queries.json` is **contested on purpose**: each query
pairs two results with near-identical term coverage, so only engine trust or a publication date can
separate them. Keep title-token Jaccard below 0.6 so entity resolution does not merge the pair, keep
at least one control query where the answer must not move, and record the rationale in the query's
`contested` field. A query set whose every top hit is on-topic scores the same under any weighting
and silently measures nothing.

Report `margin` alongside nDCG: it is the order-free gap between the best and the best lesser
result, so it moves when a weighting widens a lead without changing which result is first. State the
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

## Known environment limitation

The checks write bundled modules to `/tmp`. On Linux and macOS that works; on Windows under Git
Bash, Node resolves `/tmp` to `C:\tmp` while esbuild (a native binary) writes into the OS temp
directory, so most checks fail with `ERR_MODULE_NOT_FOUND` for reasons unrelated to the code.
**Run the gate under WSL/Linux.** Only three harnesses currently accept an override —
`API_MODULE`, `PARSERS_MODULE` and `FUSION_MODULE` — and the rest hardcode `/tmp`; making them
portable is an open task, not a solved one. Never work around a red run by removing assertions, and
never report a check as passing when it could not execute.
