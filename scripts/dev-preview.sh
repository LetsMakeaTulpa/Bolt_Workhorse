#!/usr/bin/env bash
# Start (or repair) the dev server for the cloud preview panel.
#
# A sandbox restore wipes node_modules and kills every process, and the preview hostname
# changes, so this script does all three: reinstall if needed, restart on the current host,
# and verify the server actually answers for that host before reporting success.
#
#   PREVIEW_HOST=pv-xxxx.style.dev npm run dev:preview
#   npm run dev:preview                 # reuses the host remembered from last time
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-3000}"
STATE_FILE=".preview-host"
PID_FILE=".vite.pid"
LOG_FILE="${LOG_FILE:-/tmp/vite.log}"

# 1. dependencies do not survive a checkpoint restore
if [ ! -x node_modules/.bin/vite ]; then
  echo "node_modules missing (sandbox restore?) — installing from the lockfile"
  npm ci
fi

# 2. the preview hostname changes between restores; remember it between runs
HOST="${PREVIEW_HOST:-}"
if [ -z "$HOST" ] && [ -s "$STATE_FILE" ]; then HOST="$(cat "$STATE_FILE")"; fi
if [ -z "$HOST" ]; then
  echo "No preview host known." >&2
  echo "Ask the agent for the panel hostname, then: PREVIEW_HOST=<host> npm run dev:preview" >&2
  exit 1
fi
printf '%s\n' "$HOST" > "$STATE_FILE"

answers() {
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 3 -H "Host: $HOST" "http://127.0.0.1:$PORT/")" = "200" ]
}

# grep exits 1 until the server binds, which would abort the script under `set -e`
listen_pid() {
  ss -ltnp 2>/dev/null | grep ":$PORT " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true
}

# 3. reuse a healthy server, otherwise replace it (a stale one rejects the new host)
if answers; then
  if [ ! -s "$PID_FILE" ]; then
    pid="$(listen_pid)"
    [ -n "$pid" ] && printf '%s\n' "$pid" > "$PID_FILE"
  fi
  echo "dev server already answering on :$PORT for $HOST"
  exit 0
fi
if ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  pid="$(listen_pid)"
  cmd="$(tr '\0' ' ' < "/proc/${pid:-0}/cmdline" 2>/dev/null || true)"
  case "$cmd" in
    *vite.preview.config.mjs*)
      echo "port $PORT is held by a server that rejects $HOST — restarting pid $pid"
      kill "$pid"
      sleep 2
      ;;
    *)
      echo "port $PORT is held by an unrelated process (${cmd:-unknown}); not touching it" >&2
      exit 1
      ;;
  esac
fi

# 4. start detached so the server outlives this shell
PREVIEW_HOST="$HOST" setsid nohup node_modules/.bin/vite --config vite.preview.config.mjs \
  > "$LOG_FILE" 2>&1 < /dev/null &

for _ in $(seq 1 40); do
  pid="$(listen_pid)"
  if [ -n "$pid" ]; then printf '%s\n' "$pid" > "$PID_FILE"; break; fi
  sleep 0.5
done

for _ in $(seq 1 30); do
  if answers; then
    echo "dev server ready: http://127.0.0.1:$PORT/ (Host: $HOST, pid $(cat "$PID_FILE" 2>/dev/null || echo '?'))"
    echo "open the Browser panel to view it"
    exit 0
  fi
  sleep 1
done

echo "server did not answer for $HOST on :$PORT — last log lines:" >&2
tail -20 "$LOG_FILE" >&2
exit 1
