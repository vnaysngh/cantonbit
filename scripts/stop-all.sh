#!/usr/bin/env bash
#
# Stop everything started for the swap — HTLC/C2C daemons and the Next app —
# whether they were launched via `npm run dev:all` or in separate terminals.
# Safe: targets only this repo's ports and script paths, not every node/next
# process on your machine.
#
# Usage:
#   ./scripts/stop-all.sh      (or: npm run stop)
#
set -uo pipefail

killed_any=0

kill_pids() {
  what="$1"
  pids="$2"
  [ -z "${pids// /}" ] && return 0
  echo "[stop] $what → $pids"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 1
  for pid in $pids; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  killed_any=1
}

for port in 3000 8080 8081; do
  pids="$(lsof -ti ":$port" -sTCP:LISTEN 2>/dev/null | tr '\n' ' ')"
  kill_pids "port $port (listener)" "$pids"
done

pids="$(
  {
    pgrep -f "tsx .*htlc-solver-daemon\.mts" 2>/dev/null
    pgrep -f "tsx .*canton-swap-daemon\.mts" 2>/dev/null
    pgrep -f "scripts/dev-all\.sh" 2>/dev/null
  } | sort -u | grep -v '^$' | tr '\n' ' '
)"
kill_pids "solver/app scripts" "$pids"

if [ "$killed_any" -eq 0 ]; then
  echo "[stop] nothing running."
else
  echo "[stop] done."
fi
