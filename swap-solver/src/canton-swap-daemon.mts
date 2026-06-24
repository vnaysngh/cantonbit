/**
 * Poll user_locked Loop swaps and fill atomically.
 *
 *   npm run canton-swap:daemon
 *
 * Env: HTLC_DAEMON_SECRET, CANTON_SWAP_API_URL (or NEXT_PUBLIC_APP_URL)
 */
import { startHealthServer } from "./health-server.mjs";
import { runDaemonPhases } from "./daemon-phases.js";

const APP_URL_EXPLICIT =
  process.env.CANTON_SWAP_API_URL ?? process.env.NEXT_PUBLIC_APP_URL;
const APP_URL = APP_URL_EXPLICIT ?? "http://localhost:3000";
const SECRET = (process.env.HTLC_DAEMON_SECRET ?? "").trim();
const POLL_MS = Number(process.env.CANTON_SWAP_POLL_MS ?? "3000");
const API_TIMEOUT_MS = Number(
  process.env.CANTON_SWAP_DAEMON_API_TIMEOUT_MS ?? "60000"
);
const IS_MAINNET =
  process.env.SWAP_NETWORK === "mainnet" ||
  process.env.ALLOW_MAINNET === "true";

// M-01: fail fast on missing config. Without the secret the web side rejects every
// daemon request (fail-closed auth), so the daemon would otherwise spin on 401s
// forever with no signal.
if (!SECRET) {
  console.error(
    "[canton-swap-daemon] FATAL: HTLC_DAEMON_SECRET is not set — all daemon API calls would 401. Set it (must match the web app) and restart."
  );
  process.exit(1);
}
// M-01: never silently run mainnet against the localhost default — that points the
// daemon at nothing in a deployed environment.
if (IS_MAINNET && !APP_URL_EXPLICIT) {
  console.error(
    "[canton-swap-daemon] FATAL: mainnet requires CANTON_SWAP_API_URL (or NEXT_PUBLIC_APP_URL) — refusing the localhost default."
  );
  process.exit(1);
}
if (!Number.isFinite(POLL_MS) || POLL_MS <= 0) {
  console.error(`[canton-swap-daemon] FATAL: invalid CANTON_SWAP_POLL_MS`);
  process.exit(1);
}
if (!Number.isFinite(API_TIMEOUT_MS) || API_TIMEOUT_MS <= 0) {
  console.error(
    `[canton-swap-daemon] FATAL: invalid CANTON_SWAP_DAEMON_API_TIMEOUT_MS`
  );
  process.exit(1);
}

function authHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${SECRET}`,
    "Content-Type": "application/json"
  };
}

async function fillStatus(status: "user_locked" | "filling"): Promise<void> {
  const res = await fetch(
    `${APP_URL}/api/canton/swap/pending?status=${status}`,
    { headers: authHeaders(), signal: AbortSignal.timeout(API_TIMEOUT_MS) }
  );
  if (!res.ok) {
    // P1b: a non-2xx on the pending list means the daemon is NOT actually working
    // (bad secret → 401, app down → 5xx). THROW so tick() fails and the heartbeat is
    // NOT marked healthy — /ready must report unhealthy in this state. (A single
    // per-order fill failing below is different: that stays warn-and-continue.)
    throw new Error(
      `pending list (${status}) failed ${res.status}: ${await res.text().catch(() => "")}`
    );
  }
  const { orders } = (await res.json()) as {
    orders?: Array<{
      id: string;
      walletMode?: string;
      settlementUpdateId?: string;
      counterLegOfferCid?: string;
    }>;
  };
  for (const o of orders ?? []) {
    if (o.walletMode !== "loop") continue;
    if (status === "user_locked" && o.settlementUpdateId && o.counterLegOfferCid) {
      continue;
    }
    const fillRes = await fetch(`${APP_URL}/api/canton/swap/${o.id}/fill`, {
      method: "POST",
      headers: authHeaders(),
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    });
    if (!fillRes.ok) {
      console.warn(
        `[canton-swap-daemon] fill ${o.id.slice(0, 12)} failed`,
        await fillRes.text()
      );
    } else {
      console.log(`[canton-swap-daemon] fill ${o.id.slice(0, 12)} ok`);
    }
  }
}

async function fillPending(): Promise<void> {
  await fillStatus("user_locked");
  await fillStatus("filling");
}

async function expireAndReconcile(): Promise<void> {
  const res = await fetch(`${APP_URL}/api/canton/swap/expire`, {
    method: "POST",
    headers: authHeaders(),
    signal: AbortSignal.timeout(API_TIMEOUT_MS)
  });
  if (!res.ok) {
    // P2b: a non-2xx here means the expire/reconcile endpoint is failing (auth/app
    // down). Throw so tick() fails and the heartbeat is NOT marked healthy — /ready
    // must report unhealthy when this core daemon call is broken.
    throw new Error(
      `expire failed ${res.status}: ${await res.text().catch(() => "")}`
    );
  }
}

async function tick(): Promise<void> {
  // Keep reconciliation/expiry and fills SERIAL: both mutate the same orders and
  // ledger offers, so overlapping them can reject an offer while fill is consuming
  // it. Still attempt both phases and report every failure to readiness.
  await runDaemonPhases([
    ["expire/reconcile", expireAndReconcile],
    ["fill", fillPending]
  ]);
}

// M-01: health/readiness server + heartbeat.
const heartbeat = startHealthServer({
  name: "canton-swap-daemon",
  port: Number(process.env.HEALTH_PORT ?? "8081"),
  readyStaleMs: Math.max(POLL_MS * 3, 30_000),
  nowMs: () => Date.now()
});

/** Serial scheduler — next tick starts only after the previous finishes. */
async function runLoop(): Promise<never> {
  for (;;) {
    const t0 = Date.now();
    try {
      await tick();
      heartbeat.pollOk();
    } catch (e) {
      console.error("[canton-swap-daemon]", e);
    }
    const wait = Math.max(0, POLL_MS - (Date.now() - t0));
    await new Promise((r) => setTimeout(r, wait));
  }
}

console.log(`[canton-swap-daemon] polling ${APP_URL} every ${POLL_MS}ms (serial)`);
await runLoop();
