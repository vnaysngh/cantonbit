#!/usr/bin/env npx tsx
/** One-off: full reconcile + print proof fields for an HTLC order. */
import Module from "node:module";

const origRequire = Module.prototype.require;
Module.prototype.require = function (id: string, ...rest: unknown[]) {
  if (id === "server-only") return {};
  return origRequire.call(this, id, ...rest);
};

const orderId = process.argv[2];
if (!orderId) {
  console.error("Usage: repair-htlc-order-once.mts <orderId>");
  process.exit(1);
}

async function main() {
  const { htlcService } = await import("../lib/htlc-service-singleton.js");
  const { htlcForwardLoopDeliveryProven, htlcVisibleCompleted } = await import(
    "../lib/swap-product-invariants.js"
  );

  const before = await htlcService().peekOrder(orderId);
  if (!before) throw new Error(`Order not found: ${orderId}`);

  console.log("\n=== Before ===");
  console.log(
    JSON.stringify(
      {
        status: before.status,
        counterTransferUpdateId: before.counterTransferUpdateId,
        counterTransferOfferCid: before.counterTransferOfferCid,
        counterClaimUpdateId: before.counterClaimUpdateId,
        revealedPreimage: before.revealedPreimage ? "set" : null,
        mainClaimTx: before.mainClaimTx,
        loopDeliveryProven: htlcForwardLoopDeliveryProven(before),
        visibleCompleted: htlcVisibleCompleted(before)
      },
      null,
      2
    )
  );

  const after = await htlcService().getOrder(orderId, { mode: "full" });
  if (!after) throw new Error(`Order vanished: ${orderId}`);

  console.log("\n=== After full reconcile ===");
  console.log(
    JSON.stringify(
      {
        status: after.status,
        counterTransferUpdateId: after.counterTransferUpdateId,
        counterTransferOfferCid: after.counterTransferOfferCid,
        counterClaimUpdateId: after.counterClaimUpdateId,
        revealedPreimage: after.revealedPreimage ? "set" : null,
        mainClaimTx: after.mainClaimTx,
        loopDeliveryProven: htlcForwardLoopDeliveryProven(after),
        visibleCompleted: htlcVisibleCompleted(after)
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
