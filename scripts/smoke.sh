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
# Node reads a literal /tmp as C:\tmp on Windows, so ask the runtime where temp actually is, and
# run esbuild under node: `npx` cannot be spawned through cmd.exe
TMP="$(node -e 'process.stdout.write(require("node:os").tmpdir())')"
ESBUILD_BIN="$PWD/node_modules/esbuild/bin/esbuild"
LOG="$TMP/smoke-step.log"

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
  node "$ESBUILD_BIN" src/lib/api.ts \
    --bundle --format=esm --outfile="$TMP/smoke-api.mjs" \
    --define:import.meta.env.VITE_SUPABASE_URL='"https://proxy.test"' \
    --define:import.meta.env.VITE_SUPABASE_ANON_KEY='"anon"' \
    --log-level=error || return 1
  API_MODULE="$TMP/smoke-api.mjs" node experiments/model-fallback.test.mjs
}

listeners() {
  # not `keys*.txt`: that pattern is ignored, so a fixture under it could never be committed
  node scripts/import-keys.mjs experiments/fixtures/key-dump-sample.txt --out-dir "$TMP/smoke-keys" >/dev/null
}

# 1. the app must typecheck and build
run "build (tsc + vite)" npm run build

parsers() {
  node "$ESBUILD_BIN" supabase/functions/web-search/parsers.ts \
    --bundle --format=esm --outfile="$TMP/parsers.mjs" --log-level=error || return 1
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

key_status() {
  # inside the project so the external `react` in the component bundle resolves to the same copy
  # the test renders with; a /tmp bundle cannot see node_modules
  local out=node_modules/.cache/fieldwork
  mkdir -p "$out"
  node "$ESBUILD_BIN" src/lib/engineKeyStatus.ts --bundle --format=esm \
    --outfile="$out/engine-key-status.mjs" --log-level=error || return 1
  node "$ESBUILD_BIN" src/components/EngineKeyRow.tsx --bundle --format=esm --jsx=automatic \
    --external:react --external:react-dom \
    --outfile="$out/engine-key-row.mjs" --log-level=error || return 1
  KEYSTATUS_MODULE="$PWD/$out/engine-key-status.mjs" KEYROW_MODULE="$PWD/$out/engine-key-row.mjs" \
    node experiments/engine-key-status.test.mjs
}

# 4i. the composer shows which selected engines have a key before a search runs
run "engine key status" key_status

system_prompt() {
  node experiments/system-prompt.test.mjs
}

# 4j. the answer contract the model is given: word budget, claim ledger, citations, follow-ups last
run "system prompt" system_prompt

empty_result() {
  node experiments/empty-result.test.mjs
}

# 4k. a search that found nothing ends in its gaps rather than in prose
run "empty result" empty_result

prompt_variant() {
  node experiments/prompt-variant.test.mjs
}

# 4l. the prompt can be swapped per account on this device, and blank means built-in
run "prompt variant" prompt_variant

ranking_compare() {
  node experiments/ranking-compare.test.mjs
}

# 4m. the harness can score any two weight configurations on the fixed query set
run "ranking compare" ranking_compare

ranking_benchmark() {
  node experiments/ranking-harness.mjs --check
}

# 4h. contested query set: intent weighting must not rank worse than flat trust
run "ranking benchmark" ranking_benchmark

searxng_adapter() {
  node experiments/searxng.test.mjs
}

# 4n. the keyless meta-engine: comma-separated instances, a dead one, and HTML-only answers
run "searxng adapter" searxng_adapter

# 5. database tests need PGlite, which is test-only and not in package.json
if [ ! -d node_modules/@electric-sql/pglite ]; then
  printf '→ installing @electric-sql/pglite (test-only, not saved)\n'
  if npm install --no-save @electric-sql/pglite >"$TMP/smoke-pglite.log" 2>&1; then
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
