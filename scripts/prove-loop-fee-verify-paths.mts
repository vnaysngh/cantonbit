#!/usr/bin/env npx tsx
/**
 * Prove that an unknown update id fails closed.
 * Does NOT submit on ledger.
 */
import Module from "node:module";
import { readFileSync } from "node:fs";

const origRequire = Module.prototype.require;
Module.prototype.require = function (id: string, ...rest: unknown[]) {
  if (id === "server-only") return {};
  return origRequire.call(this, id, ...rest);
};

function loadEnvFile(name: string) {
  try {
    for (const line of readFileSync(name, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i <= 0) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {
    /* optional */
  }
}

loadEnvFile(".env.local");
loadEnvFile(".env.devnet");

async function main() {
  const userParty =
    process.argv[2] ??
    "8f5ca108eb208e8826f868952ede00a5::12200fe103931833a6cb6f080dff41df997dbb9abd8d06384e6405434a04efcf8e2b";
  const feeCc = process.argv[3] ?? "3.530206";
  const suppliedUpdateId = process.argv[4]?.trim();
  const orderId = process.argv[5]?.trim();

  const { networkFeeReceiverParty } = await import("../lib/canton-network-fee.js");
  const { verifyLoopNetworkFeeSettlement } = await import(
    "../lib/network-fee-verify.js"
  );

  const receiverParty = networkFeeReceiverParty();
  if (!receiverParty) throw new Error("NETWORK_FEE_RECEIVER_PARTY not set");
  const { getCcTransferPreapprovalContractId } = await import(
    "../lib/cc-registry.js"
  );
  const expectedPreapprovalCid =
    orderId
      ? (await (await import("../lib/htlc-service-singleton.js"))
          .htlcService()
          .getOrder(orderId))?.networkFeePreapprovalCid
      : await getCcTransferPreapprovalContractId(receiverParty);
  if (!expectedPreapprovalCid) {
    throw new Error(
      "expected fee TransferPreapproval CID unavailable — prepare the order fee first"
    );
  }

  const updateId =
    suppliedUpdateId ??
    "00000000000000000000000000000000000000000000000000000000000000ff";

  console.log("\n=== Authoritative ledger lookup ===");
  let verified = false;
  try {
    await verifyLoopNetworkFeeSettlement({
      updateId,
      userParty,
      receiverParty,
      minFeeCc: feeCc,
      expectedPreapprovalCid
    });
    verified = true;
    console.log("PASS: authoritative fee update verified");
    if (orderId) {
      const { htlcService } = await import("../lib/htlc-service-singleton.js");
      const order = await htlcService().recordLoopNetworkFeeCollected(
        orderId,
        updateId
      );
      console.log(
        `PASS: fee recorded for ${order.id.slice(0, 14)}… (${order.status})`
      );
    }
  } catch (e) {
    console.log(
      suppliedUpdateId ? "FAIL: supplied update rejected:" : "PASS: unknown update id rejected:",
      e instanceof Error ? e.message : e
    );
  }
  if (suppliedUpdateId && !verified) process.exitCode = 1;
  if (!suppliedUpdateId && verified) {
    throw new Error("UNEXPECTED: unknown update id succeeded");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
