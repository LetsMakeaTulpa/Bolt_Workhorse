#!/usr/bin/env bash
# One command that proves the repo still works: build, then every experiment test.
#
#   npm run smoke            # build + unit/db tests
#   npm run smoke -- --live  # + read-only probes against the live Supabase project
#
# Anything that cannot run (missing optional dependency, no network) is reported as SKIP,
# never as a pass, and the exit code is non-zero if any check fails.
set -uo pipefail
cd "$(dirname "$0")/.."

LIVE=0
[ "${1:-}" = "--live" ] && LIVE=1

PASS=()
FAIL=()
SKIP=()
LOG=/tmp/smoke-step.log

run() {
  local name="$1"
  shift
  printf '→ %s\n' "$name"
  if "$@" >"$LOG" 2>&1; then
    PASS+=("$name")
    printf '  ok\n'
  else
    FAIL+=("$name")
    printf '  FAILED\n'
    tail -20 "$LOG" | sed 's/^/    /'
  fi
}

skip() {
  SKIP+=("$1 — $2")
  printf '→ %s\n  SKIPPED (%s)\n' "$1" "$2"
}

model_fallback() {
  npx --yes esbuild src/lib/api.ts \
    --bundle --format=esm --outfile=/tmp/smoke-api.mjs \
    --define:import.meta.env.VITE_SUPABASE_URL='"https://proxy.test"' \
    --define:import.meta.env.VITE_SUPABASE_ANON_KEY='"anon"' \
    --log-level=error || return 1
  API_MODULE=/tmp/smoke-api.mjs node experiments/model-fallback.test.mjs
}

listeners() {
  node scripts/import-keys.mjs experiments/fixtures/keys-sample.txt --out-dir /tmp/smoke-keys >/dev/null
}

# 1. the app must typecheck and build
run "build (tsc + vite)" npm run build

parsers() {
  npx --yes esbuild supabase/functions/web-search/parsers.ts \
    --bundle --format=esm --outfile=/tmp/parsers.mjs --log-level=error || return 1
  node experiments/websearch-parsers.test.mjs
}

# 2. parser fixtures for the server-side engines
run "web-search parsers" parsers

engine_pipeline() {
  node experiments/web-engine-pipeline.test.mjs
}

# 2b. exa + tavily end to end through the handler, parsers and RRF
run "exa/tavily pipeline" engine_pipeline

# 3. model fallback + reliability (bundles the real api.ts)
run "model fallback chain" model_fallback

# 4. the key importer classifies the sample dump and leaks nothing
run "key importer" listeners

engine_status_ui() {
  node experiments/engine-status-ui.test.mjs
}

# 4b. the status strip turns engine reports into readable chips
run "engine status strip" engine_status_ui

fusion_intent() {
  node experiments/fusion-intent.test.mjs
}

# 4c. intent-aware weighting of the semantic and recency engines
run "fusion intent weighting" fusion_intent

followups() {
  node experiments/followups.test.mjs
}

# 4d. the FOLLOW-UPS section is parsed out of the answer without eating prose
run "follow-up parsing" followups

provider_keys() {
  node experiments/provider-keys.test.mjs
}

# 4e. pasted provider keys land under the names the function reads
run "provider key parsing" provider_keys

rank_badges() {
  node experiments/rank-badges.test.mjs
}

# 4f. the Sources badges report the same intent and multiplier fusion applied
run "ranking badges" rank_badges

search_abort() {
  node experiments/search-abort.test.mjs
}

# 4g. a superseded search stops its requests instead of finishing and overwriting
run "search abort" search_abort

ranking_benchmark() {
  node experiments/ranking-harness.mjs --check
}

# 4h. contested query set: intent weighting must not rank worse than flat trust
run "ranking benchmark" ranking_benchmark

# 5. database tests need PGlite, which is test-only and not in package.json
if [ ! -d node_modules/@electric-sql/pglite ]; then
  printf '→ installing @electric-sql/pglite (test-only, not saved)\n'
  if npm install --no-save @electric-sql/pglite >/tmp/smoke-pglite.log 2>&1; then
    printf '  installed\n'
  else
    PGLITE_MISSING=1
  fi
fi

if [ -d node_modules/@electric-sql/pglite ]; then
  run "app_config lockdown" node experiments/app-config-lockdown.test.mjs
  run "anon write privileges" node experiments/rls-write-audit.test.mjs
  run "per-user RLS isolation" node experiments/auth-rls.test.mjs
  run "proxy rate limits" node experiments/rate-limit.test.mjs
else
  skip "app_config lockdown" "PGlite unavailable (offline install failed)"
  skip "anon write privileges" "PGlite unavailable (offline install failed)"
  skip "per-user RLS isolation" "PGlite unavailable (offline install failed)"
  skip "proxy rate limits" "PGlite unavailable (offline install failed)"
fi

# 6. optional: talk to the real database
if [ "$LIVE" = "1" ]; then
  if [ -f .env ]; then
    # shellcheck disable=SC1091
    set -a; . ./.env; set +a
    run "live RLS probes" bash experiments/rls-probe.sh
  else
    skip "live RLS probes" "no .env with Supabase credentials"
  fi
fi

printf '\n────────────────────────────────────\n'
printf 'passed: %d\n' "${#PASS[@]}"
[ "${#SKIP[@]}" -gt 0 ] && printf 'skipped: %d\n' "${#SKIP[@]}" && printf '  %s\n' "${SKIP[@]}"
if [ "${#FAIL[@]}" -gt 0 ]; then
  printf 'failed: %d\n' "${#FAIL[@]}"
  printf '  %s\n' "${FAIL[@]}"
  exit 1
fi
printf 'failed: 0\n'
