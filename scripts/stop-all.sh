#!/usr/bin/env bash
#
# Stop everything started for the swap — the solver API, the watch loop, and the
# Next app — whether they were launched via `npm run dev:all` or in separate
# terminals. Safe: targets only this repo's ports and script paths, not every
# node/next process on your machine.
#
# Usage:
#   ./scripts/stop-all.sh      (or: npm run stop)
#
# Written for bash 3.2 (the macOS system bash) — no `mapfile`, no arrays passed
# across functions.
#
set -uo pipefail

killed_any=0

# graceful kill of a whitespace-separated list of pids: TERM, wait, then KILL
# anything still alive.
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

# 1) by port — the app (3000) and solver API (8787). Only the LISTENING server,
#    NOT clients connected to it (e.g. a browser tab on :3000 also shows up under
#    a plain `lsof -ti`, and we must not kill that).
for port in 3000 8787; do
  pids="$(lsof -ti ":$port" -sTCP:LISTEN 2>/dev/null | tr '\n' ' ')"
  kill_pids "port $port (listener)" "$pids"
done

# 2) by script path — watch loop / API / orchestrator (catches anything not bound
#    to a port, e.g. the watch loop, which never listens). The solver runs with
#    cwd=swap-solver/, so its command line shows the RELATIVE path `src/index.ts`
#    (no `swap-solver/` prefix) — match the marker comments we add in the npm
#    scripts (`# watch loop` / `# api`) plus the relative paths, scoped to tsx so
#    we never touch unrelated node processes. Then de-dupe.
pids="$(
  {
    pgrep -f "tsx .*src/index\.ts" 2>/dev/null
    pgrep -f "tsx .*src/serve\.ts" 2>/dev/null
    pgrep -f "scripts/dev-all\.sh" 2>/dev/null
  } | sort -u | grep -v '^$' | tr '\n' ' '
)"
kill_pids "solver/app scripts" "$pids"

if [ "$killed_any" -eq 0 ]; then
  echo "[stop] nothing running."
else
  echo "[stop] done."
fi
