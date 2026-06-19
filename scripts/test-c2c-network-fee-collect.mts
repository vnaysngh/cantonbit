#!/usr/bin/env npx tsx
/**
 * Live E2E: managed C2C swap with NETWORK_FEE_ENABLED — verify CC fee collection.
 *
 *   AUDIT_USER_CANTON_PARTY='party-…' bash scripts/with-env.sh devnet npx tsx scripts/test-c2c-network-fee-collect.mts
 */
import Module from "node:module";
const origRequire = Module.prototype.require;
Module.prototype.require = function (id: string, ...rest: unknown[]) {
  if (id === "server-only") return {};
  return origRequire.call(this, id, ...rest);
};

const user =
  process.env.AUDIT_USER_CANTON_PARTY?.trim() ||
  "party-de08bc18-d724-4acb-a653-d4383cd82df5::1220231c1885f289f90e0d08b448579c31a655b5826802c6d885258a27371039fba9";

async function fetchLedgerRow(orderId: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const r = await fetch(
    `${url}/rest/v1/network_fee_ledger?order_id=eq.${encodeURIComponent(orderId)}&order_kind=eq.c2c&select=*`,
    {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cache: "no-store"
    }
  );
  if (!r.ok) return null;
  const rows = (await r.json()) as Record<string, unknown>[];
  return rows[0] ?? null;
}

async function main() {
  const { isNetworkFeeEnabled } = await import("../lib/canton-network-fee-math.js");
  if (!isNetworkFeeEnabled()) {
    throw new Error("NETWORK_FEE_ENABLED must be 1 for this test");
  }

  const { getAmuletBalance } = await import("../lib/canton.js");
  const { quoteMvpCantonSwap } = await import("../lib/canton-swap-quote.js");
  const { cantonSwapService } = await import("../lib/canton-swap-service.js");
  const { networkFeeReceiverParty } = await import("../lib/canton-network-fee-math.js");

  const ccBefore = await getAmuletBalance(user);
  const receiverBefore = await getAmuletBalance(networkFeeReceiverParty());

  // ~$100 notional — comfortable size for devnet smoke tests
  const fromAsset = (process.env.TEST_C2C_FROM ?? "CBTC") as "CC" | "CBTC";
  const toAsset = (process.env.TEST_C2C_TO ?? "CC") as "CC" | "CBTC";
  const amount = process.env.TEST_C2C_AMOUNT ?? (fromAsset === "CC" ? "100" : "0.0001");
  const q = await quoteMvpCantonSwap(fromAsset, toAsset, amount);
  console.log("quote:", {
    dir: `${fromAsset}→${toAsset}`,
    inAmount: q.inAmount,
    outAmount: q.outAmount
  });

  const order = await cantonSwapService().createOrder({
    fromAsset,
    toAsset,
    inAmount: q.inAmount,
    outAmount: q.outAmount,
    userParty: user,
    walletMode: "managed"
  });

  console.log("order created:", {
    id: order.id,
    networkFeeCc: order.networkFeeCc,
    minRequired: order.networkFeeCc
      ? `(fee + reserve from quote)`
      : undefined
  });

  if (!order.networkFeeCc || Number.parseFloat(order.networkFeeCc) <= 0) {
    throw new Error("order.networkFeeCc not bound — fee collection will not run");
  }

  const settled = await cantonSwapService().settleManaged(order.id);
  console.log("settled:", {
    id: settled.id,
    status: settled.status,
    networkFeeCc: settled.networkFeeCc
  });

  if (settled.status !== "filled") {
    throw new Error(`expected filled, got ${settled.status}`);
  }

  const ccAfter = await getAmuletBalance(user);
  const receiverAfter = await getAmuletBalance(networkFeeReceiverParty());
  const ledger = await fetchLedgerRow(order.id);

  const feeNum = Number.parseFloat(order.networkFeeCc);
  const userDelta = Number.parseFloat(ccBefore) - Number.parseFloat(ccAfter);
  const receiverDelta =
    Number.parseFloat(receiverAfter) - Number.parseFloat(receiverBefore);

  console.log("\n=== Collection audit ===");
  console.log(JSON.stringify({
    userCcBefore: ccBefore,
    userCcAfter: ccAfter,
    userCcDelta: userDelta.toFixed(6),
    receiverCcBefore: receiverBefore,
    receiverCcAfter: receiverAfter,
    receiverCcDelta: receiverDelta.toFixed(6),
    boundFeeCc: order.networkFeeCc,
    ledgerRow: ledger
      ? {
          fee_cc: ledger.fee_cc,
          settlement_update_id: ledger.settlement_update_id
        }
      : null
  }, null, 2));

  const ledgerOk =
    ledger != null &&
    String(ledger.fee_cc) === String(order.networkFeeCc);
  const userPaidOk = userDelta >= feeNum * 0.99; // swap also moves CC leg
  const receiverGotOk = receiverDelta >= feeNum * 0.99;

  if (!ledgerOk) {
    console.error("FAIL: network_fee_ledger row missing or fee_cc mismatch");
    process.exit(1);
  }
  if (!receiverGotOk) {
    console.error(
      "FAIL: fee receiver CC did not increase by bound fee (check direct transfer)"
    );
    process.exit(1);
  }

  console.log(
    "\nPASS: C2C managed fee collected (ledger row + receiver CC inflow). " +
      `User CC moved by ${userDelta.toFixed(4)} CC total (swap + fee).`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
