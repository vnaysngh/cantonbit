#!/usr/bin/env bash
# Load a network stack (.env.devnet or .env.mainnet), then optional .env.local
# values, and run a command. Network stack values normally win on duplicate keys;
# NETWORK_FEE_* and NEXT_PUBLIC_NETWORK_FEE_ENABLED are intentionally overridden
# from .env.local for quick local fee toggles.
#
# Usage (from repo root):
#   ./scripts/with-env.sh devnet next dev
#   ./scripts/with-env.sh mainnet next build
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NETWORK="${1:?Usage: with-env.sh <devnet|mainnet> <command...>}"
shift

if [[ "$NETWORK" != "devnet" && "$NETWORK" != "mainnet" ]]; then
  echo "Network must be 'devnet' or 'mainnet', got '$NETWORK'" >&2
  exit 1
fi

ENV_FILE="$ROOT/.env.$NETWORK"
if [[ ! -f "$ENV_FILE" ]]; then
  # Railway / CI inject vars into the process env — no .env.devnet on disk.
  if [[ -n "${NEXT_PUBLIC_NETWORK:-}" || -n "${RAILWAY_ENVIRONMENT:-}" || -n "${CI:-}" ]]; then
    echo "[with-env] $ENV_FILE missing — using process environment"
    cd "$ROOT"
    exec "$@"
  fi
  echo "Missing $ENV_FILE" >&2
  echo "Run: cp .env.$NETWORK.example .env.$NETWORK" >&2
  exit 1
fi

# Next.js Turbopack workers load .env.development.local with higher priority than
# .env.local. Mirror the selected stack there, but let local network-fee toggles
# override it so flipping NETWORK_FEE_* in .env.local cannot be masked by a stale
# generated file.
DEV_LOCAL="$ROOT/.env.development.local"
cp "$ENV_FILE" "$DEV_LOCAL"
if [[ -f "$ROOT/.env.local" ]]; then
  TMP_DEV_LOCAL="$(mktemp)"
  grep -Ev '^(NETWORK_FEE_|NEXT_PUBLIC_NETWORK_FEE_ENABLED=)' "$DEV_LOCAL" > "$TMP_DEV_LOCAL" || true
  grep -E '^(NETWORK_FEE_|NEXT_PUBLIC_NETWORK_FEE_ENABLED=)' "$ROOT/.env.local" >> "$TMP_DEV_LOCAL" || true
  mv "$TMP_DEV_LOCAL" "$DEV_LOCAL"
fi

# Also export those same local fee keys into the parent process. dotenv-cli does
# not reliably give later -e files precedence for already-defined keys, while
# process env values are respected. Keep this targeted to fee toggles so network
# stack secrets still come from the selected .env.<network> file by default.
if [[ -f "$ROOT/.env.local" ]]; then
  while IFS='=' read -r KEY VALUE; do
    [[ -n "$KEY" ]] || continue
    VALUE="${VALUE%%#*}"
    VALUE="${VALUE%"${VALUE##*[![:space:]]}"}"
    VALUE="${VALUE#"${VALUE%%[![:space:]]*}"}"
    export "$KEY=$VALUE"
  done < <(grep -E '^(NETWORK_FEE_|NEXT_PUBLIC_NETWORK_FEE_ENABLED=)' "$ROOT/.env.local" || true)
fi

# dotenv-cli: first -e file wins on duplicate keys; later files only fill gaps.
# Use repo-local binary — bare `dotenv` on PATH may be Python dotenv-cli (different -e semantics).
DOTENV="$ROOT/node_modules/.bin/dotenv"
if [[ ! -x "$DOTENV" ]]; then
  echo "Missing $DOTENV — run npm install" >&2
  exit 1
fi

ARGS=(-e "$ENV_FILE")
if [[ -f "$ROOT/.env.local" ]]; then
  ARGS+=(-e "$ROOT/.env.local")
fi

cd "$ROOT"
exec "$DOTENV" "${ARGS[@]}" -- "$@"
