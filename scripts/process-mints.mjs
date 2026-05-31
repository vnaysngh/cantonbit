#!/usr/bin/env node
/**
 * Cron worker: trigger the mint processor.
 *
 * Uses Node's built-in fetch (Node 18+) — no curl, no dependencies.
 *
 * Required env:
 *   APP_URL      Base URL of the Oranj deployment (e.g. https://oranjtbc.up.railway.app)
 *   CRON_SECRET  Same value set on the server in .env
 *
 * Exit codes:
 *   0  request succeeded (HTTP 200)
 *   1  config error (missing env)
 *   2  request failed (non-200 response)
 */

const { APP_URL, CRON_SECRET } = process.env;

if (!APP_URL || !CRON_SECRET) {
  console.error("process-mints: APP_URL and CRON_SECRET must be set");
  process.exit(1);
}

const url = `${APP_URL.replace(/\/$/, "")}/api/mint/process-transfers`;

try {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CRON_SECRET}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(120_000),
  });

  const body = await res.text();

  if (res.status !== 200) {
    console.error(`process-mints: HTTP ${res.status} from ${APP_URL}`);
    console.error(`process-mints: response body: ${body}`);
    process.exit(2);
  }

  console.log(`process-mints: ok ${body}`);
} catch (err) {
  console.error("process-mints: request failed:", err.message);
  process.exit(2);
}
