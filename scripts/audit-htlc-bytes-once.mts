#!/usr/bin/env npx tsx
/**
 * End-to-end HTLC managed swap byte + fee audit (prepare-based).
 *
 *   bash scripts/with-env.sh devnet npx tsx scripts/audit-htlc-bytes-once.mts
 *   bash scripts/with-env.sh devnet npx tsx scripts/audit-htlc-bytes-once.mts 0.0001 0.00009887
 */
import Module from "node:module";

const origRequire = Module.prototype.require;
Module.prototype.require = function (id: string, ...rest: unknown[]) {
  if (id === "server-only") return {};
  return origRequire.call(this, id, ...rest);
};

const wbtcIn = process.argv[2]?.trim() || "0.0001";
const cbtcOut = process.argv[3]?.trim() || "0.00009887";

const user =
  process.env.AUDIT_USER_CANTON_PARTY?.trim() ||
  "party-de08bc18-d724-4acb-a653-d4383cd82df5::1220231c1885f289f90e0d08b448579c31a655b5826802c6d885258a27371039fba9";
const vault = process.env.CANTON_SWAP_SETTLEMENT_PARTY?.trim() || "";
const feeReceiver = process.env.NETWORK_FEE_RECEIVER_PARTY?.trim() || "";

async function main() {
  if (!vault) throw new Error("CANTON_SWAP_SETTLEMENT_PARTY missing");

  const { estimateHtlcManagedFee, measureSolverCounterLockTraffic } =
    await import("../lib/canton-network-fee.js");
  const { fetchExtraTrafficPriceUsdPerMb, fetchAmuletPriceUsd } =
    await import("../lib/canton-price-scan.js");
  const {
    trafficBytesToFeeCc,
    networkFeeBufferBps,
    minCcRequiredForNetworkFee
  } = await import("../lib/canton-network-fee-math.js");
  const { quoteWbtcToCbtc, BRIDGE_FEE_BPS } = await import("../lib/htlc-quote.js");

  const [priceMb, ccUsd] = await Promise.all([
    fetchExtraTrafficPriceUsdPerMb(),
    fetchAmuletPriceUsd()
  ]);
  const wbtcUnits = BigInt(Math.round(parseFloat(wbtcIn) * 1e8));
  const q = await quoteWbtcToCbtc(wbtcUnits);
  const grossCbtc = Number(q.outUnits) / 1e8 / (1 - q.feeBps / 10_000);
  const platformFeeCbtc = grossCbtc - Number(q.outUnits) / 1e8;

  const claim = await estimateHtlcManagedFee({
    action: "htlc-claim",
    userParty: user,
    solverParty: vault,
    cbtcAmount: cbtcOut
  });

  const counter = await measureSolverCounterLockTraffic({
    context: "audit-htlc-bytes",
    solverParty: vault,
    userParty: user,
    cbtcAmount: cbtcOut
  });

  const listPrice = (bytes: number) =>
    trafficBytesToFeeCc({
      trafficBytes: bytes,
      extraTrafficPriceUsdPerMb: priceMb,
      amuletPriceUsd: ccUsd,
      bufferBps: 0
    });

  const buffered = (bytes: number) =>
    trafficBytesToFeeCc({
      trafficBytes: bytes,
      extraTrafficPriceUsdPerMb: priceMb,
      amuletPriceUsd: ccUsd,
      bufferBps: networkFeeBufferBps()
    });

  console.log("\n=== HTLC forward (WBTC→CBTC, managed email) ===\n");
  console.log(`Input:  ${wbtcIn} WBTC`);
  console.log(`Output: ${cbtcOut} CBTC (quoted)`);
  console.log(`WBTC/BTC rate: ${(Number(q.price8) / 1e8).toFixed(8)}`);
  console.log(`Platform fee: ${BRIDGE_FEE_BPS} bps → ~${platformFeeCbtc.toFixed(8)} CBTC`);
  console.log(`Scan list price: $${priceMb}/MB traffic, $${ccUsd}/CC`);
  console.log(`User fee buffer: +${networkFeeBufferBps() / 100}%`);
  console.log(`Fee receiver: ${feeReceiver || "(unset)"}`);
  console.log(`Vault party: ${vault.slice(0, 24)}…`);

  console.log("\n--- EVM (user wallet, not Canton CC) ---");
  console.log("Tx 1  WBTC approve (if needed)     | gas: variable ETH | bytes: n/a");
  console.log("Tx 2  HTLC lock WBTC               | gas: ~80–150k ETH | bytes: n/a");

  console.log("\n--- Canton vault (platform absorbs) ---");
  if (counter) {
    for (const leg of counter.legs) {
      console.log(
        `${leg.label.padEnd(42)} | ${String(leg.trafficBytes).padStart(7)} bytes | list ~${leg.feeCc} CC | charged: no`
      );
    }
    console.log(
      `${"TOTAL vault counter-lock".padEnd(42)} | ${String(counter.totalTrafficBytes).padStart(7)} bytes | list ~${counter.totalFeeCc} CC | charged: no`
    );
  } else {
    console.log("(vault counter-lock measure failed — check vault CBTC float)");
  }

  console.log("\n--- Canton solver daemon (platform absorbs) ---");
  console.log(
    `${"Solver claim WBTC on EVM".padEnd(42)} | gas: variable ETH | bytes: n/a | charged: no`
  );

  console.log("\n--- Canton user-charged (email backend signs) ---");
  console.log(
    "Policy: business-command bytes only; fee CC transfer bytes absorbed by platform.\n"
  );
  for (const tx of claim.transactions ?? []) {
    if (!tx.charged) continue;
    console.log(
      `${tx.label.padEnd(42)} | ${String(tx.trafficBytes).padStart(7)} bytes | quoted in network fee | charged: yes`
    );
  }
  console.log(
    `${"Fee CC transfer (absorbed)".padEnd(42)} | ${"(~8k)".padStart(7)} bytes | not in quote | charged: no`
  );
  console.log(
    `\nUSER NETWORK FEE (quoted): ${claim.feeCc} CC (~$${claim.feeUsd.toFixed(4)} traffic cost)`
  );
  console.log(`Min CC on party: ${minCcRequiredForNetworkFee(claim.feeCc)} CC (fee + ${process.env.NETWORK_FEE_RESERVE_CC ?? 5} reserve)`);
  console.log(`Fee credited to: ${feeReceiver || "NETWORK_FEE_RECEIVER_PARTY"}`);

  const lock = await estimateHtlcManagedFee({
    action: "htlc-lock",
    userParty: user,
    solverParty: vault,
    cbtcAmount: cbtcOut
  });

  console.log("\n=== HTLC reverse (CBTC→WBTC, managed email) ===\n");
  console.log(`Input:  ${cbtcOut} CBTC`);
  console.log(
    "Policy: allocate + create HtlcLock bytes quoted; fee CC transfer absorbed.\n"
  );
  for (const tx of lock.transactions ?? []) {
    const charged = tx.charged ? "yes" : "no";
    const bytes = tx.trafficBytes > 0 ? String(tx.trafficBytes) : "(platform)";
    console.log(
      `${tx.label.padEnd(42)} | ${bytes.padStart(7)} bytes | charged: ${charged}`
    );
  }
  console.log(
    `\nUSER NETWORK FEE (quoted): ${lock.feeCc} CC (~$${lock.feeUsd.toFixed(4)} traffic cost)`
  );
  console.log(`Min CC on party: ${minCcRequiredForNetworkFee(lock.feeCc)} CC (fee + ${process.env.NETWORK_FEE_RESERVE_CC ?? 5} reserve)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
