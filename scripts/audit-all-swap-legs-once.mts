#!/usr/bin/env npx tsx
/**
 * Full swap leg byte audit — managed + Loop paths, HTLC + C2C.
 *   bash scripts/with-env.sh devnet npx tsx scripts/audit-all-swap-legs-once.mts
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
const vault = process.env.CANTON_SWAP_SETTLEMENT_PARTY?.trim() || "";

function listCc(
  bytes: number,
  priceMb: number,
  ccUsd: number,
  bufferBps: number,
  trafficBytesToFeeCc: (p: {
    trafficBytes: number;
    extraTrafficPriceUsdPerMb: number;
    amuletPriceUsd: number;
    bufferBps?: number;
  }) => { feeCc: string; feeUsd: number }
): { feeCc: string; feeUsd: number } {
  return trafficBytesToFeeCc({
    trafficBytes: bytes,
    extraTrafficPriceUsdPerMb: priceMb,
    amuletPriceUsd: ccUsd,
    bufferBps
  });
}

async function prep(
  label: string,
  actAs: string[],
  commands: unknown[],
  disclosed: unknown[],
  sync?: string
): Promise<number> {
  const { prepareLedgerCommands } = await import("../lib/transfer.js");
  const r = await prepareLedgerCommands({
    actAs,
    commands,
    disclosedContracts: disclosed as never[],
    synchronizerId: sync,
    commandId: `audit-${label}-${Date.now()}`
  });
  return r.totalTrafficBytes;
}

async function main() {
  if (!vault) throw new Error("CANTON_SWAP_SETTLEMENT_PARTY missing");

  const { fetchExtraTrafficPriceUsdPerMb, fetchAmuletPriceUsd } =
    await import("../lib/canton-price-scan.js");
  const {
    trafficBytesToFeeCc,
    networkFeeBufferBps,
    minCcRequiredForNetworkFee
  } = await import("../lib/canton-network-fee-math.js");
  const {
    estimateHtlcManagedFee,
    estimateManagedC2cSettleFee,
    measureSolverCounterLockTraffic
  } = await import("../lib/canton-network-fee.js");
  const { getHoldings } = await import("../lib/canton.js");
  const { buildTransferExercise } = await import("../lib/transfer.js");
  const {
    holdingsForSwapAsset,
    resolveSwapInstrumentId,
    registrarAdminForAsset,
    registryKindForAsset
  } = await import("../lib/canton-swap-holdings.js");
  const { getSwapAsset } = await import("../lib/canton-assets.js");

  const [priceMb, ccUsd] = await Promise.all([
    fetchExtraTrafficPriceUsdPerMb(),
    fetchAmuletPriceUsd()
  ]);
  const buf = networkFeeBufferBps();
  const list = (bytes: number, buffer = 0) =>
    listCc(bytes, priceMb, ccUsd, buffer, trafficBytesToFeeCc);

  const row = (
    phase: string,
    id: string,
    party: string,
    bytes: number | string,
    listCc: string,
    userCc: string,
    payer: string
  ) => ({ phase, id, party, bytes, listCc, userCc, payer });

  const legs: ReturnType<typeof row>[] = [];

  // --- HTLC forward managed ---
  const counter = await measureSolverCounterLockTraffic({
    context: "audit-all",
    solverParty: vault,
    userParty: user,
    cbtcAmount: "0.0000989"
  });
  if (counter) {
    for (const l of counter.legs) {
      legs.push(
        row(
          "HTLC fwd managed",
          l.label,
          "vault",
          l.trafficBytes,
          l.feeCc,
          "—",
          "Platform"
        )
      );
    }
  }

  const htlcClaim = await estimateHtlcManagedFee({
    action: "htlc-claim",
    userParty: user,
    solverParty: vault,
    cbtcAmount: "0.0000989"
  });
  for (const tx of htlcClaim.transactions ?? []) {
    if (tx.charged) {
      const u = trafficBytesToFeeCc({
        trafficBytes: tx.trafficBytes,
        extraTrafficPriceUsdPerMb: priceMb,
        amuletPriceUsd: ccUsd,
        bufferBps: buf
      });
      legs.push(
        row(
          "HTLC fwd managed",
          tx.label,
          "user (email backend)",
          tx.trafficBytes,
          list(tx.trafficBytes).feeCc,
          u.feeCc,
          "User (Oranj fee)"
        )
      );
    }
  }

  // --- HTLC forward Loop: vault createTransfer ---
  try {
    const holdings = await getHoldings(vault);
    const leg = await buildTransferExercise({
      senderParty: vault,
      receiverParty: user,
      amount: "0.0000989",
      inputHoldings: holdings.slice(0, 3),
      expirationSeconds: 3600,
      instrumentId: await resolveSwapInstrumentId("CBTC"),
      registrarAdmin: await registrarAdminForAsset("CBTC"),
      registryKind: registryKindForAsset("CBTC"),
      assetSymbol: "CBTC",
      memo: "audit-loop-deliver"
    });
    const deliverBytes = await prep(
      "loop-htlc-deliver",
      [vault],
      [leg.command],
      leg.disclosedContracts,
      leg.synchronizerId || undefined
    );
    legs.push(
      row(
        "HTLC fwd Loop",
        "Vault CBTC transfer (createTransfer)",
        "vault",
        deliverBytes,
        list(deliverBytes).feeCc,
        "—",
        "Platform"
      )
    );
    // User accept (if pending offer)
    if (leg.transferKind.toLowerCase().includes("offer")) {
      // can't prepare accept without real offer cid — use C2C accept fallback ~8090 for CBTC side... use measure from docs
    }
  } catch (e) {
    console.warn("loop deliver measure:", e instanceof Error ? e.message : e);
  }

  // --- HTLC reverse managed lock ---
  const htlcLock = await estimateHtlcManagedFee({
    action: "htlc-lock",
    userParty: user,
    solverParty: vault,
    cbtcAmount: "0.0000989"
  });
  for (const tx of htlcLock.transactions ?? []) {
    if (tx.charged && tx.trafficBytes > 0) {
      const u = trafficBytesToFeeCc({
        trafficBytes: tx.trafficBytes,
        extraTrafficPriceUsdPerMb: priceMb,
        amuletPriceUsd: ccUsd,
        bufferBps: buf
      });
      legs.push(
        row(
          "HTLC rev managed",
          tx.label,
          "user (email backend)",
          tx.trafficBytes,
          list(tx.trafficBytes).feeCc,
          u.feeCc,
          "User (Oranj fee)"
        )
      );
    } else if (!tx.charged) {
      legs.push(
        row(
          "HTLC rev managed",
          tx.label,
          tx.id.includes("solver") ? "vault" : "user EVM",
          tx.trafficBytes || "n/a",
          "—",
          "—",
          "Platform / User ETH"
        )
      );
    }
  }

  // --- C2C managed ---
  for (const [from, to, amt, out] of [
    ["CBTC", "CC", "0.0001", "39.7995606431"],
    ["CC", "CBTC", "200", "0.0004894"]
  ] as const) {
    const est = await estimateManagedC2cSettleFee({
      userParty: user,
      vaultParty: vault,
      fromAsset: from,
      toAsset: to,
      inAmount: amt,
      outAmount: out,
      livePrepare: true
    });
    for (const tx of est.transactions ?? []) {
      const listPrice = tx.trafficBytes > 0 ? list(tx.trafficBytes).feeCc : "—";
      const userQ =
        tx.charged && tx.trafficBytes > 0
          ? trafficBytesToFeeCc({
              trafficBytes: tx.trafficBytes,
              extraTrafficPriceUsdPerMb: priceMb,
              amuletPriceUsd: ccUsd,
              bufferBps: buf
            }).feeCc
          : "—";
      legs.push(
        row(
          `C2C managed ${from}→${to}`,
          tx.label,
          tx.charged ? "user+vault" : "vault",
          tx.trafficBytes || 0,
          listPrice,
          userQ,
          tx.charged ? "User (in total quote)" : "Platform"
        )
      );
    }
    if (est.feeCc) {
      legs.push(
        row(
          `C2C managed ${from}→${to}`,
          "TOTAL user network fee (quoted)",
          "user",
          est.trafficBytes,
          list(est.trafficBytes).feeCc,
          est.feeCc,
          "User → warpx"
        )
      );
    }
  }

  // --- C2C Loop user offer ---
  for (const [from, amt] of [
    ["CBTC", "0.0001"],
    ["CC", "200"]
  ] as const) {
    try {
      const sym = getSwapAsset(from);
      const built = await buildTransferExercise({
        senderParty: user,
        receiverParty: vault,
        amount: from === "CBTC" ? "0.0001" : "200",
        inputHoldings: await holdingsForSwapAsset(user, from),
        expirationSeconds: 3600,
        instrumentId: await resolveSwapInstrumentId(from),
        registrarAdmin: await registrarAdminForAsset(from),
        registryKind: registryKindForAsset(from),
        assetSymbol: sym.symbol,
        memo: `audit-c2c-loop-${from}`
      });
      const offerBytes = await prep(
        `c2c-loop-offer-${from}`,
        [user],
        [built.command],
        built.disclosedContracts,
        built.synchronizerId || undefined
      );
      legs.push(
        row(
          `C2C Loop ${from}→…`,
          "User sell offer (Loop signs)",
          "user Loop party",
          offerBytes,
          list(offerBytes).feeCc,
          "Loop billing*",
          "User (Loop CC)"
        )
      );
    } catch (e) {
      console.warn(`C2C loop offer ${from}:`, e instanceof Error ? e.message : e);
    }
  }

  console.log(
    JSON.stringify(
      {
        pricing: {
          trafficUsdPerMb: priceMb,
          ccUsd,
          userBufferBps: buf,
          reserveCc: minCcRequiredForNetworkFee("0").replace(/^0$/, "5")
        },
        legs
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
