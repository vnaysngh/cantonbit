#!/usr/bin/env npx tsx
/** One-off: repair a falsely-completed C2C Loop order missing counter proof. */
import Module from "node:module";

const origRequire = Module.prototype.require;
Module.prototype.require = function (id: string, ...rest: unknown[]) {
  if (id === "server-only") return {};
  return origRequire.call(this, id, ...rest);
};

const orderId = process.argv[2];
if (!orderId) {
  console.error("Usage: repair-c2c-order-once.mts <orderId>");
  process.exit(1);
}

async function main() {
  const { cantonSwapService } = await import("../lib/canton-swap-service.js");
  const { c2cVisibleCompleted } = await import("../lib/swap-product-invariants.js");
  const svc = cantonSwapService();
  const before = await svc.get(orderId);
  if (!before) throw new Error(`Order not found: ${orderId}`);

  console.log("\n=== Before ===");
  console.log(
    JSON.stringify(
      {
        status: before.status,
        settlementUpdateId: before.settlementUpdateId,
        counterLegOfferCid: before.counterLegOfferCid,
        counterReceiptUpdateId: before.counterReceiptUpdateId,
        visibleCompleted: c2cVisibleCompleted(before)
      },
      null,
      2
    )
  );

  const n = await svc.reconcileFilledLoopCounterProof();
  console.log(`\nreconcileFilledLoopCounterProof touched ${n} order(s)`);

  const after = await svc.get(orderId);
  console.log("\n=== After ===");
  console.log(
    JSON.stringify(
      {
        status: after?.status,
        settlementUpdateId: after?.settlementUpdateId,
        counterLegOfferCid: after?.counterLegOfferCid,
        counterReceiptUpdateId: after?.counterReceiptUpdateId,
        counterReissueAttempt: after?.counterReissueAttempt,
        failureReason: after?.failureReason,
        visibleCompleted: after ? c2cVisibleCompleted(after) : null
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
