#!/usr/bin/env bash
#
# Start the swap stack for local development:
#   1. HTLC daemon(s)    (one per enabled EVM chain — base + arbitrum sepolia on devnet)
#   2. C2C swap daemon   (swap-solver/src/canton-swap-daemon.mts)
#   3. Next app          (next dev — the UI, port 3000)
#
# Output from all three is interleaved with a [htlc] / [c2c] / [app] prefix.
# Ctrl-C stops all three together.
#
# Usage:
#   ./scripts/dev-all.sh              # devnet (default)
#   NETWORK=mainnet ./scripts/dev-all.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOLVER="$ROOT/swap-solver"
NETWORK="${NETWORK:-devnet}"

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

run() {
  local label="$1" color="$2"; shift 2
  ( "$@" 2>&1 | sed "s/^/$(printf '\033[%sm[%s]\033[0m ' "$color" "$label")/" ) &
  pids+=("$!")
}

echo "[dev-all] starting HTLC daemon(s), C2C daemon, and app…"
if [ "$NETWORK" = "mainnet" ]; then
  HTLC_SCRIPT="htlc-daemon:mainnet"
  C2C_SCRIPT="canton-swap-daemon:mainnet"
  ( cd "$SOLVER" && run "htlc" "36" npm run "$HTLC_SCRIPT" )
else
  C2C_SCRIPT="canton-swap-daemon"
  ( cd "$SOLVER" && run "htlc-base" "36" npm run htlc-daemon )
  if [ -f "$SOLVER/.env.htlc-arbitrum-sepolia" ]; then
    ( cd "$SOLVER" && run "htlc-arb" "35" npm run htlc-daemon:arbitrum-sepolia )
  else
    echo "[dev-all] skip arbitrum-sepolia HTLC daemon — copy swap-solver/.env.htlc-arbitrum-sepolia.example → .env.htlc-arbitrum-sepolia"
  fi
fi
( cd "$SOLVER" && run "c2c"  "33" npm run "$C2C_SCRIPT" )
( cd "$ROOT"   && run "app"  "32" npm run "dev:${NETWORK}" )

echo "[dev-all] all started. app :3000 · Ctrl-C to stop."
wait
