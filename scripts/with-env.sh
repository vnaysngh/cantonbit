#!/usr/bin/env bash
# Load a network stack (.env.devnet or .env.mainnet), then optional .env.local overrides,
# and run a command. Later files win on duplicate keys.
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
  echo "Missing $ENV_FILE" >&2
  echo "Run: cp .env.$NETWORK.example .env.$NETWORK" >&2
  exit 1
fi

# Next.js Turbopack workers only auto-load .env.local — not our .env.mainnet file.
# Mirror the chosen stack into .env.development.local (loaded after .env.local in dev,
# so network secrets win over stale CRON_SECRET in .env.local).
cp "$ENV_FILE" "$ROOT/.env.development.local"

# dotenv-cli: first -e file wins on duplicate keys; later files only fill gaps.
ARGS=(-e "$ENV_FILE")
if [[ -f "$ROOT/.env.local" ]]; then
  ARGS+=(-e "$ROOT/.env.local")
fi

cd "$ROOT"
exec dotenv "${ARGS[@]}" -- "$@"
