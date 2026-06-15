/**
 * Poll user_locked Loop swaps and fill atomically.
 *
 *   npm run canton-swap:daemon
 *
 * Env: HTLC_DAEMON_SECRET, NEXT_PUBLIC_APP_URL (or SWAP_API_URL base)
 */
import "dotenv/config";

const APP_URL =
  process.env.CANTON_SWAP_API_URL ??
  process.env.NEXT_PUBLIC_APP_URL ??
  "http://localhost:3000";
const SECRET = process.env.HTLC_DAEMON_SECRET ?? "";
const POLL_MS = Number(process.env.CANTON_SWAP_POLL_MS ?? "5000");

function authHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${SECRET}`,
    "Content-Type": "application/json"
  };
}

async function fillStatus(status: "user_locked" | "filling"): Promise<void> {
  const res = await fetch(
    `${APP_URL}/api/canton/swap/pending?status=${status}`,
    { headers: authHeaders() }
  );
  if (!res.ok) {
    console.warn(
      `[canton-swap-daemon] pending list (${status}) failed`,
      await res.text()
    );
    return;
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
      headers: authHeaders()
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
    headers: authHeaders()
  });
  if (!res.ok) {
    console.warn("[canton-swap-daemon] expire failed", await res.text());
  }
}

async function tick(): Promise<void> {
  await fillPending();
  await expireAndReconcile();
}

/** Serial scheduler — next tick starts only after the previous finishes. */
async function runLoop(): Promise<never> {
  for (;;) {
    const t0 = Date.now();
    try {
      await tick();
    } catch (e) {
      console.error("[canton-swap-daemon]", e);
    }
    const wait = Math.max(0, POLL_MS - (Date.now() - t0));
    await new Promise((r) => setTimeout(r, wait));
  }
}

console.log(`[canton-swap-daemon] polling ${APP_URL} every ${POLL_MS}ms (serial)`);
await runLoop();
