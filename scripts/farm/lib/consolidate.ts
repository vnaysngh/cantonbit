import { fromBaseUnits, toBaseUnitsFloor } from "../../../lib/amount-units";
import { CBTC_ASSET, CC_ASSET } from "../../../lib/canton-assets";
import type { FarmFleetConfig } from "./types";
import {
  ACS_QUERY_BATCH_LIMIT,
  buildTransferExercise,
  countHoldings,
  holdingsForAsset,
  isAcsLimitError,
  isDirectTransferKind,
  registrarForAsset,
  submitLedgerCommands
} from "./ledger";

export type FarmAsset = "CBTC" | "CC";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sumHoldings(
  holdings: Awaited<ReturnType<typeof holdingsForAsset>>,
  decimals: number
): string {
  let total = 0n;
  for (const h of holdings) {
    total += toBaseUnitsFloor(h.payload?.amount ?? "0", decimals);
  }
  return fromBaseUnits(total, decimals);
}

export async function consolidatePartyAsset(params: {
  jwt: string;
  party: string;
  label: string;
  asset: FarmAsset;
  minUtxo: number;
  dryRun?: boolean;
  maxRounds?: number;
  batchLimit?: number;
}): Promise<number> {
  const batchLimit = params.batchLimit ?? ACS_QUERY_BATCH_LIMIT;
  const maxRounds = params.maxRounds ?? 25;
  const decimals = params.asset === "CC" ? CC_ASSET.decimals : CBTC_ASSET.decimals;
  let merges = 0;

  for (let round = 0; round < maxRounds; round++) {
    let holdings: Awaited<ReturnType<typeof holdingsForAsset>>;
    try {
      holdings = await holdingsForAsset(
        params.jwt,
        params.party,
        params.asset,
        batchLimit
      );
    } catch (e) {
      if (!isAcsLimitError(e)) throw e;
      console.warn(
        `  ${params.label}: ACS limit on ${params.asset} read — retry batch ${batchLimit}`
      );
      continue;
    }

    if (holdings.length < params.minUtxo) {
      if (round === 0) {
        console.log(
          `  skip ${params.label}: ${holdings.length} ${params.asset} UTXO(s) (< ${params.minUtxo})`
        );
      }
      break;
    }

    const mergeCount =
      holdings.length > batchLimit ? batchLimit : holdings.length;
    const batch = holdings.slice(0, mergeCount);
    const amount = sumHoldings(batch, decimals);
    console.log(
      `  ${params.label}: merge ${batch.length} ${params.asset} UTXO(s) → ~${amount} ${params.asset}`
    );
    if (params.dryRun) {
      merges++;
      if (holdings.length <= batchLimit) break;
      continue;
    }

    const reg = await registrarForAsset(params.jwt, params.asset);
    const leg = await buildTransferExercise({
      jwt: params.jwt,
      senderParty: params.party,
      receiverParty: params.party,
      amount,
      inputHoldings: batch,
      useAllInputHoldings: true,
      instrumentId: reg.instrumentId,
      registrarAdmin: reg.admin,
      registryKind: reg.kind,
      assetSymbol: params.asset,
      memo: "farm-utxo-consolidate"
    });

    const cmdId = `farm-consolidate-${params.asset}-${params.party.slice(0, 12)}-${Date.now()}`;
    await submitLedgerCommands({
      jwt: params.jwt,
      actAs: [params.party],
      commands: [leg.command],
      disclosedContracts: leg.disclosedContracts,
      commandId: cmdId,
      synchronizerId: leg.synchronizerId,
      workflowId: cmdId
    });

    try {
      const after = await countHoldings(params.jwt, params.party);
      const utxoAfter = params.asset === "CBTC" ? after.cbtc : after.cc;
      console.log(
        `  ✓ ${params.label}: ${params.asset} UTXO ${batch.length} → ${utxoAfter} (${isDirectTransferKind(leg.transferKind) ? "direct" : "offer path"})`
      );
    } catch {
      console.log(`  ✓ ${params.label}: merged ${batch.length} ${params.asset} UTXO(s)`);
    }

    merges++;
    if (holdings.length <= batchLimit) break;
    await sleep(2500);
  }

  return merges;
}

export async function consolidateVaultUtxos(params: {
  jwt: string;
  fleet: FarmFleetConfig;
  minUtxo?: number;
  dryRun?: boolean;
  reason?: string;
}): Promise<number> {
  const minUtxo = params.minUtxo ?? 2;
  const reason = params.reason ? ` (${params.reason})` : "";
  console.log(`Consolidate vault${reason}: minUtxo=${minUtxo}`);

  let total = 0;
  for (const asset of ["CC", "CBTC"] as const) {
    total += await consolidatePartyAsset({
      jwt: params.jwt,
      party: params.fleet.vault,
      label: "vault",
      asset,
      minUtxo,
      dryRun: params.dryRun,
      maxRounds: minUtxo <= 2 ? 40 : 10
    });
    await sleep(1000);
  }
  return total;
}

export async function consolidateFleetUtxos(params: {
  jwt: string;
  fleet: FarmFleetConfig;
  assets?: FarmAsset[];
  minUtxo?: number;
  includeVault?: boolean;
  dryRun?: boolean;
  reason?: string;
}): Promise<number> {
  const assets = params.assets ?? ["CC", "CBTC"];
  const minUtxo = params.minUtxo ?? 8;
  const includeVault = params.includeVault !== false;
  const reason = params.reason ? ` (${params.reason})` : "";

  const targets: Array<{ label: string; party: string }> = [];
  for (const t of params.fleet.traders) {
    targets.push({ label: t.hint, party: t.party });
  }
  if (includeVault) {
    targets.push({ label: "vault", party: params.fleet.vault });
  }

  console.log(
    `Consolidate fleet${reason}: assets=${assets.join("+")} minUtxo=${minUtxo} parties=${targets.length}`
  );

  let total = 0;
  for (const asset of assets) {
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]!;
      const n = await consolidatePartyAsset({
        jwt: params.jwt,
        party: t.party,
        label: t.label,
        asset,
        minUtxo,
        dryRun: params.dryRun,
        maxRounds: minUtxo <= 2 ? 40 : 10
      });
      total += n;
      if (i < targets.length - 1) await sleep(1500);
    }
  }
  return total;
}
