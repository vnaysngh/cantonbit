#!/usr/bin/env npx tsx
/** Smoke test C2C network fee estimate (both directions). */
import Module from "node:module";
const origRequire = Module.prototype.require;
Module.prototype.require = function (id: string, ...rest: unknown[]) {
  if (id === "server-only") return {};
  return origRequire.call(this, id, ...rest);
};

const user =
  process.env.AUDIT_USER_CANTON_PARTY?.trim() ||
  "party-de08bc18-d724-4acb-a653-d4383cd82df5::1220231c1885f289f90e0d08b448579c31a655b5826802c6d885258a27371039fba9";

async function main() {
  const { quoteMvpCantonSwap } = await import("../lib/canton-swap-quote.js");
  const { estimateManagedC2cSettleFee } = await import("../lib/canton-network-fee.js");
  const { expectedCantonSwapParty } = await import("../lib/htlc-auth.js");
  const vault = expectedCantonSwapParty();
  if (!vault) throw new Error("CANTON_SWAP_SETTLEMENT_PARTY missing");

  for (const [from, to, amt] of [
    ["CBTC", "CC", "0.0001"],
    ["CC", "CBTC", "100"]
  ] as const) {
    const q = await quoteMvpCantonSwap(from, to, amt);
    const est = await estimateManagedC2cSettleFee({
      userParty: user,
      vaultParty: vault,
      fromAsset: from,
      toAsset: to,
      inAmount: q.inAmount,
      outAmount: q.outAmount
    });
    console.log(
      JSON.stringify({
        dir: `${from}→${to}`,
        feeCc: est.feeCc,
        feeUsd: est.feeUsd,
        trafficBytes: est.trafficBytes,
        txOffer: est.transactions?.find((t) => t.id === "c2c-user-offer")?.trafficBytes,
        txAccept: est.transactions?.find((t) => t.id === "c2c-vault-accept")?.trafficBytes
      })
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
