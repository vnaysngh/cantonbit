#!/usr/bin/env bash
# Load one network stack (.env.devnet or .env.mainnet) and run a command.
#
# Devnet → .env.devnet   |   Mainnet → .env.mainnet
# Do not duplicate stack config in .env.local (Next.js loads it automatically
# and stale keys there cause 401s and wrong-network bugs). See docs/ENV.md.
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

# Next.js Turbopack workers prefer .env.development.local over .env.local.
# Mirror the selected stack so dev:* always matches .env.devnet / .env.mainnet.
cp "$ENV_FILE" "$ROOT/.env.development.local"

# Warn when .env.local duplicates stack keys (common source of daemon 401s).
LOCAL="$ROOT/.env.local"
if [[ -f "$LOCAL" ]]; then
  CONFLICTS="$(
    grep -Ev '^\s*(#|$)' "$LOCAL" | cut -d= -f1 | while read -r key; do
      [[ -n "$key" ]] || continue
      grep -q "^${key}=" "$ENV_FILE" && echo "  $key"
    done
  )" || true
  if [[ -n "$CONFLICTS" ]]; then
    echo "[with-env] WARNING: .env.local duplicates keys in $ENV_FILE:" >&2
    echo "$CONFLICTS" >&2
    echo "[with-env] Move those vars into $ENV_FILE only — see docs/ENV.md" >&2
  fi
fi

DOTENV="$ROOT/node_modules/.bin/dotenv"
if [[ ! -x "$DOTENV" ]]; then
  echo "Missing $DOTENV — run npm install" >&2
  exit 1
fi

cd "$ROOT"
exec "$DOTENV" -e "$ENV_FILE" -- "$@"
