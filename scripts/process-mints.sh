#!/usr/bin/env bash
# Cron worker: trigger the mint processor.
#
# Run from any external scheduler — Railway scheduled jobs, k8s CronJob,
# fly.io machines, GitHub Actions, systemd timers, plain crontab, etc.
# The script is self-contained: shell + curl, nothing else.
#
# Required env:
#   APP_URL      Base URL of the Oranj deployment (e.g. https://app.example.com)
#   CRON_SECRET  Same value set on the server in .env
#
# Suggested schedule: every 60 seconds.
#
# Example crontab entry:
#   * * * * * APP_URL=https://app.example.com CRON_SECRET=xxx /path/to/process-mints.sh
#
# Exit codes:
#   0  request succeeded (HTTP 200)
#   1  config error (missing env)
#   2  request failed (non-200 response) — scheduler should alert on repeated failures

set -euo pipefail

if [[ -z "${APP_URL:-}" || -z "${CRON_SECRET:-}" ]]; then
  echo "process-mints: APP_URL and CRON_SECRET must be set" >&2
  exit 1
fi

# Strip trailing slash so we don't end up with double slashes in the URL.
APP_URL="${APP_URL%/}"

# Single attempt — the scheduler retries by re-running on the next tick.
# We capture body separately from the status code so we can log the body
# on failure without polluting the success path.
http_status=$(
  curl --silent --show-error \
    --max-time 120 \
    --output /tmp/process-mints-response.$$ \
    --write-out '%{http_code}' \
    --request POST \
    --header "Authorization: Bearer ${CRON_SECRET}" \
    --header "Content-Type: application/json" \
    "${APP_URL}/api/mint/process-transfers"
)

body=$(cat /tmp/process-mints-response.$$ 2>/dev/null || true)
rm -f /tmp/process-mints-response.$$

if [[ "$http_status" != "200" ]]; then
  echo "process-mints: HTTP $http_status from ${APP_URL}" >&2
  echo "process-mints: response body: ${body}" >&2
  exit 2
fi

# Success — print the result so the scheduler captures it in logs.
echo "process-mints: ok ${body}"
