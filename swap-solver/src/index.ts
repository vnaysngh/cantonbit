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

const STORE_PATH = process.env.STORE_PATH ?? ".oranj-swap/orders.json";

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
  });

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
      // 2. deliver seen orders
      const delivered = await deliverSeenOrders(store, canton, {
        now,
        minSecondsBeforeDeadline: 30 * 60, // 30 min margin for accept + settle
        cbtcDecimals: 8,
      });
      logOutcomes("deliver", delivered.map((d) => ({ id: d.order.orderId, o: d.outcome.kind })));

      // 3. resolve delivering orders (user accept / expiry)
      const resolved = await resolveDeliveringOrders(store, canton, { now, fromOffset: 0 });
      logOutcomes("accept", resolved.map((r) => ({ id: r.orderId, o: r.outcome.kind })));

      // 4. settle delivered orders (attest + finalise)
      const settled = await settler.settleReady(store);
      logOutcomes("settle", settled.map((s) => ({ id: s.orderId, o: s.outcome.kind })));

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
