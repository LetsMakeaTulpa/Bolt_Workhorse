#!/usr/bin/env bash
# The gate is now a Node runner so it works on Windows without Git Bash:
#   node scripts/smoke.mjs        (what `npm run smoke` calls)
# This shim stays because muscle memory and older docs say `bash scripts/smoke.sh`.
set -uo pipefail
exec node "$(dirname "$0")/smoke.mjs" "$@"
