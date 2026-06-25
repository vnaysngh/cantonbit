#!/usr/bin/env bash
# Report keys duplicated between .env.local and the network stack files.
# Usage: ./scripts/consolidate-env.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL="$ROOT/.env.local"

keys_in() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  grep -Ev '^\s*(#|$)' "$file" | cut -d= -f1 | sed 's/[[:space:]]*$//'
}

echo "OranjSwap env consolidation check"
echo "  Devnet source of truth:  .env.devnet"
echo "  Mainnet source of truth: .env.mainnet"
echo

for stack in devnet mainnet; do
  stack_file="$ROOT/.env.$stack"
  if [[ ! -f "$stack_file" ]]; then
    echo "Missing $stack_file — run: cp .env.$stack.example .env.$stack"
    continue
  fi
  echo "OK  .env.$stack exists ($(wc -l < "$stack_file" | tr -d ' ') lines)"
done
echo

if [[ ! -f "$LOCAL" ]]; then
  echo "OK  no .env.local (optional)"
  exit 0
fi

LOCAL_LINES=$(grep -Ev '^\s*(#|$)' "$LOCAL" 2>/dev/null | wc -l | tr -d ' ' || true)
LOCAL_LINES=${LOCAL_LINES:-0}
if [[ "$LOCAL_LINES" == "0" ]]; then
  echo "OK  .env.local is empty (comments only)"
  exit 0
fi

echo "Checking .env.local for stack keys that should live in .env.devnet / .env.mainnet only..."
FOUND=0
while IFS= read -r key; do
  [[ -n "$key" ]] || continue
  for stack in devnet mainnet; do
    stack_file="$ROOT/.env.$stack"
    [[ -f "$stack_file" ]] || continue
    if grep -q "^${key}=" "$stack_file" 2>/dev/null; then
      echo "  DUPLICATE: $key (in .env.local and .env.$stack)"
      FOUND=1
    fi
  done
done < <(keys_in "$LOCAL")

if [[ "$FOUND" == "1" ]]; then
  echo
  echo "Remove duplicates from .env.local — keep values in .env.devnet or .env.mainnet only."
  exit 1
fi

echo "OK  .env.local keys do not duplicate stack files"
