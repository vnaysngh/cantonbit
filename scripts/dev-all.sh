#!/usr/bin/env bash
#
# Start everything for the swap, in one command:
#   1. solver API     (swap-solver/src/serve.ts  — quoting + submit, port 8787)
#   2. solver watch   (swap-solver/src/index.ts  — delivers/attests/finalises)
#   3. Next app       (next dev                  — the UI, port 3000)
#
# Output from all three is interleaved with a [api] / [watch] / [app] prefix.
# Ctrl-C stops all three together.
#
# Usage:
#   ./scripts/dev-all.sh              # devnet (default)
#   NETWORK=mainnet ./scripts/dev-all.sh
#
set -euo pipefail

# repo root = parent of this script's dir
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOLVER="$ROOT/swap-solver"
NETWORK="${NETWORK:-devnet}"

# Web stack for chosen network + legacy swap-solver/.env + optional overrides.
ENV_ARGS=(--env-file="../.env.${NETWORK}" --env-file=.env --env-file=../.env.local)

pids=()
cleanup() {
  echo
  echo "[dev-all] shutting down…"
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

# prefix each line of a stream with a colored label
run() {
  local label="$1" color="$2"; shift 2
  ( "$@" 2>&1 | sed "s/^/$(printf '\033[%sm[%s]\033[0m ' "$color" "$label")/" ) &
  pids+=("$!")
}

echo "[dev-all] starting solver API, watch loop, and app…"
( cd "$SOLVER" && run "api"   "36" npx tsx "${ENV_ARGS[@]}" src/serve.ts )
( cd "$SOLVER" && run "watch" "33" npx tsx "${ENV_ARGS[@]}" src/index.ts )
( cd "$ROOT"   && run "app"   "32" npm run "dev:${NETWORK}" )

echo "[dev-all] all started. API :8787 · app :3000 · Ctrl-C to stop."
wait
