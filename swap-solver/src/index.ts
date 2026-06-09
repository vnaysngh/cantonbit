/**
 * Oranj swap solver — main loop.
 *
 * Ties the four legs together over a poll cadence:
 *   1. watch    — InputSettlerEscrow `Open` events on Base       → [seen]
 *   2. deliver  — create cBTC offer (solver float → user party)  → [delivering]
 *   3. accept   — user accepts on Canton; capture record-time    → [delivered]
 *   4. settle   — attest on oracle, finalise on escrow           → [finalised]
 *
 * TRUST MODEL (printed at startup): this is a single-solver, custodial,
 * two-legged (NOT atomic) settlement. The agent key can release the escrow; the
 * Canton creds can spend the float. Both are treasury-grade. The solver bears
 * the completion risk between legs 2 and 4 — mitigated by delivering only after
 * the Base lock is final and by attesting only after confirmed Canton acceptance.
 */

import { makeNetworkConfig } from "./config.js";
import { loadEnv, describeEnv, type SolverEnv } from "./env.js";
import { CantonClient } from "./canton.js";
import { OrderStore } from "./store.js";
import { OpenWatcher } from "./watcher.js";
import { deliverSeenOrders } from "./delivery.js";
import { resolveDeliveringOrders } from "./accept-watch.js";
import { Settler } from "./settle.js";
import { buildHealthReport, summarize } from "./monitor.js";
import { refundExpiredOrders, type RefundDeps } from "./refund.js";

const STORE_PATH = process.env.STORE_PATH ?? ".oranj-swap/orders.json";

// How much time must remain before an order's fillDeadline for the solver to
// START delivering it. This covers the whole remaining lifecycle: deliver cBTC
// (seconds) + accept (seconds–minutes) + attest + finalise (~1–2 min).
//
// HARD INVARIANT (the bug that stalled every live swap): this MUST be
// comfortably LESS than the quote's fillDeadlineSeconds (config.ts). If the
// margin is >= the fill window, every order is born already too close to its
// deadline to ever be delivered. Current config: fill window 30m, margin 10m →
// 20m of slack. Keep margin <= fillDeadlineSeconds / 3.
const DELIVERY_MARGIN_SECONDS = 10 * 60;

async function main(): Promise<void> {
  const env = loadEnv();

  // Startup banner — masked summary + the trust model, in plain sight.
  console.log("[oranj-swap-solver] starting");
  console.log("[config]", JSON.stringify(describeEnv(env), null, 2));
  console.log(
    "[trust] single-solver custodial, two-legged (NOT atomic) settlement. " +
      "Agent key releases the escrow; Canton creds spend the cBTC float. " +
      "Both treasury-grade.",
  );

  const store = new OrderStore(STORE_PATH);
  const cfg = makeNetworkConfig({
    network: env.network,
    originChainId: await chainIdOf(env),
    escrow: env.escrow,
    oracle: env.oracle,
    wbtc: env.wbtc,
  });

  // FAIL-FAST on the timing contradiction that silently stalled every live swap:
  // if the delivery margin is not comfortably below the order's fill window, no
  // order can ever be delivered (born past the deliverable threshold). Refuse to
  // start rather than accept orders we can never fill (and then refund).
  if (DELIVERY_MARGIN_SECONDS >= cfg.fillDeadlineSeconds) {
    console.error(
      `[preflight] FATAL config: delivery margin (${DELIVERY_MARGIN_SECONDS}s) >= fill window ` +
        `(${cfg.fillDeadlineSeconds}s). Every order would be unfillable. ` +
        `Increase fillDeadlineSeconds or lower DELIVERY_MARGIN_SECONDS (keep margin <= fill/3).`,
    );
    process.exit(1);
  }
  if (cfg.fillDeadlineSeconds >= cfg.expiresSeconds) {
    console.error(
      `[preflight] FATAL config: fillDeadline (${cfg.fillDeadlineSeconds}s) >= expires ` +
        `(${cfg.expiresSeconds}s). The escrow requires fillDeadline < expires.`,
    );
    process.exit(1);
  }
  console.log(
    `[preflight] timing OK: fill ${cfg.fillDeadlineSeconds / 60}m, expires ${cfg.expiresSeconds / 60}m, ` +
      `delivery margin ${DELIVERY_MARGIN_SECONDS / 60}m (${(cfg.fillDeadlineSeconds - DELIVERY_MARGIN_SECONDS) / 60}m slack).`,
  );

  const canton = new CantonClient(
    {
      ledgerHost: env.canton.ledgerHost,
      registryUrl: env.canton.registryUrl,
      decentralizedPartyId: env.canton.decentralizedPartyId,
      instrumentId: env.canton.instrumentId,
      solverParty: env.canton.solverParty,
    },
    env.canton.auth,
  );

  // --- Float pre-flight (B6): fail loudly before accepting any orders if the
  // cBTC float can't be read or is empty. On mainnet an empty float means we'd
  // lock users' WBTC we can't fill — refuse to start.
  try {
    const floatSats = await canton.getFloatSats();
    const floatBtc = Number(floatSats) / 1e8;
    console.log(`[preflight] cBTC float: ${floatBtc} cBTC (${floatSats} sats)`);
    if (floatSats === 0n) {
      const msg = "[preflight] FLOAT IS EMPTY — the solver cannot deliver cBTC. Refusing to start.";
      if (env.network === "mainnet") { console.error(msg); process.exit(1); }
      console.warn(msg + " (continuing on non-mainnet)");
    }
  } catch (e) {
    const msg = `[preflight] could not read the cBTC float: ${e instanceof Error ? e.message : e}`;
    if (env.network === "mainnet") { console.error(msg + " — refusing to start on mainnet."); process.exit(1); }
    console.warn(msg + " (continuing on non-mainnet)");
  }

  const watcher = new OpenWatcher(
    { rpcUrl: env.originRpcUrl, escrow: env.escrow, startBlock: env.startBlock },
    store,
    (orderId) => console.log(`[watch] new order ${orderId}`),
  );
  const settler = new Settler({
    rpcUrl: env.originRpcUrl,
    escrow: env.escrow,
    oracle: env.oracle,
    account: env.agentAccount,
    payoutAddress: env.payoutAddress,
    // Skip settlement (don't strand a delivered order) if the agent hot key can't
    // afford attest+finalise gas. Set MIN_GAS_ETH_WEI to enable.
    minEthForGasWei: process.env.MIN_GAS_ETH_WEI
      ? BigInt(process.env.MIN_GAS_ETH_WEI)
      : undefined,
  });

  // Clients for the auto-refund sweep (returns locked WBTC to users on expiry).
  const { createWalletClient, createPublicClient, http } = await import("viem");
  const refundDeps: RefundDeps = {
    store,
    escrow: env.escrow,
    account: env.agentAccount,
    wallet: createWalletClient({ account: env.agentAccount, transport: http(env.originRpcUrl) }),
    pub: createPublicClient({ transport: http(env.originRpcUrl) }),
  };

  // Resumable backfill, then live follow.
  console.log("[watch] backfilling…");
  await watcher.backfill();
  const unwatch = watcher.watch();
  console.log("[watch] live");

  let stopping = false;
  const stop = () => {
    stopping = true;
    unwatch();
    console.log("[oranj-swap-solver] shutting down");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Main work loop.
  while (!stopping) {
    const now = Math.floor(Date.now() / 1000);
    try {
      // 0. re-read the store so we see the API process's writes (the API
      //    registers orders + the cantonParty preimage; without this reload the
      //    loop would never see the party and would refuse to deliver).
      store.reload();

      // 2. deliver seen orders
      const delivered = await deliverSeenOrders(store, canton, {
        now,
        minSecondsBeforeDeadline: DELIVERY_MARGIN_SECONDS, // see invariant above
        cbtcDecimals: 8,
        // C3: optional total in-flight exposure cap (sats). Defense in depth on
        // top of the float bound. Set MAX_INFLIGHT_SATS to enable.
        maxInflightSats: process.env.MAX_INFLIGHT_SATS
          ? BigInt(process.env.MAX_INFLIGHT_SATS)
          : undefined,
        // FAIRNESS: per-user in-flight cBTC cap (sats). Stops one user draining the
        // shared float. Set PER_USER_INFLIGHT_SATS to enable.
        perUserInflightCapSats: process.env.PER_USER_INFLIGHT_SATS
          ? BigInt(process.env.PER_USER_INFLIGHT_SATS)
          : undefined,
        // PRE-FLIGHT: never deliver cBTC unless the WBTC is securely claimable
        // (Deposited + comfortable margin before expiry) → the two legs pass-or-
        // fail together. 10 min margin so finalise can't lose to the refund window.
        verifyClaimable: (orderId, expires) =>
          settler.verifyClaimable(orderId, expires, now, 10 * 60),
      });
      logOutcomes("deliver", delivered.map((d) => ({ id: d.order.orderId, o: d.outcome.kind })));

      // 3. resolve delivering orders (user accept / expiry)
      const resolved = await resolveDeliveringOrders(store, canton, { now, fromOffset: 0 });
      logOutcomes("accept", resolved.map((r) => ({ id: r.orderId, o: r.outcome.kind })));

      // 4. settle delivered orders (attest + finalise)
      const settled = await settler.settleReady(store);
      logOutcomes("settle", settled.map((s) => ({ id: s.orderId, o: s.outcome.kind })));

      // 4b. auto-refund: return locked WBTC to users on any order past its expiry
      //     that never finalised. Permissionless — funds always go to the user.
      //     This is what makes a stalled cross-chain swap self-heal: it can't be
      //     atomic like a single-chain DEX, but it refunds without user action.
      const refunds = await refundExpiredOrders(refundDeps, now);
      for (const r of refunds) {
        if (r.outcome.kind === "refunded") {
          console.log(`[refund] ${r.orderId.slice(0, 12)}… auto-refunded → ${r.outcome.refundTx}`);
        } else if (r.outcome.kind === "error") {
          console.error(`[refund] ${r.orderId.slice(0, 12)}… FAILED: ${r.outcome.message}`);
        }
      }

      // 5. health check each tick — surface at-risk / stuck / critical states.
      const health = buildHealthReport(store, {
        now,
        staleSeenSeconds: 30 * 60,
        deadlineWarnSeconds: 30 * 60,
      });
      const line = `[health] ${summarize(health)}`;
      if (health.status === "critical") console.error(line);
      else if (health.status === "warn") console.warn(line);
      else console.log(line);
      // Loud, explicit alert for capital-at-risk orders past their deadline.
      for (const o of health.atRisk) {
        if (o.order.fillDeadline < now) {
          console.error(`[ALERT] order ${o.orderId.slice(0, 16)}… is ${o.status} PAST fillDeadline — cBTC delivered but finalise may be impossible. Manual review needed.`);
        }
      }
    } catch (e) {
      console.error("[loop] tick error:", e instanceof Error ? e.message : e);
    }
    await sleep(env.pollIntervalMs);
  }
}

function logOutcomes(leg: string, items: { id: string; o: string }[]): void {
  const active = items.filter((i) => i.o !== "skipped" && i.o !== "pending");
  if (active.length > 0) {
    for (const i of active) console.log(`[${leg}] ${i.id.slice(0, 12)}… → ${i.o}`);
  }
}

async function chainIdOf(env: SolverEnv): Promise<number> {
  const { createPublicClient, http } = await import("viem");
  const c = createPublicClient({ transport: http(env.originRpcUrl) });
  return c.getChainId();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error("[oranj-swap-solver] fatal:", e);
  process.exit(1);
});
