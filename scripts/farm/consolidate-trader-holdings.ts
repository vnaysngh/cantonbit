#!/usr/bin/env npx tsx
/**
 * Merge token holdings (UTXO consolidate) via self-transfer — consumes all inputs, one output.
 *
 * Usage:
 *   npm run farm:consolidate:mainnet -- --i-understand-mainnet --asset=CBTC --trader=4
 *   npm run farm:consolidate:mainnet -- --i-understand-mainnet --asset=CBTC --min-utxo=3
 *   npm run farm:consolidate:mainnet -- --i-understand-mainnet --party=<party_id> --asset=CBTC
 */
import { fromBaseUnits, toBaseUnitsFloor } from "../../lib/amount-units";
import { CBTC_ASSET, CC_ASSET } from "../../lib/canton-assets";
import { assertMainnetNetwork, loadFleet, traderParty, vaultParty } from "./lib/config";
import { countHoldings } from "./lib/ledger";
import { getLedgerJwt } from "./lib/jwt";
import {
  buildTransferExercise,
  holdingsForAsset,
  isDirectTransferKind,
  registrarForAsset,
  submitLedgerCommands
} from "./lib/ledger";
import { parseArg, parseFlag, parseNumberArg, requireMainnetGuard } from "./lib/parse-args";

type FarmAsset = "CBTC" | "CC";

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

async function consolidateParty(params: {
  jwt: string;
  party: string;
  label: string;
  asset: FarmAsset;
  minUtxo: number;
  dryRun: boolean;
}): Promise<boolean> {
  const reg = await registrarForAsset(params.jwt, params.asset);
  const decimals = params.asset === "CC" ? CC_ASSET.decimals : CBTC_ASSET.decimals;
  const holdings = await holdingsForAsset(params.jwt, params.party, params.asset);
  if (holdings.length < params.minUtxo) {
    console.log(
      `  skip ${params.label}: ${holdings.length} ${params.asset} UTXO(s) (< ${params.minUtxo})`
    );
    return false;
  }

  const amount = sumHoldings(holdings, decimals);
  console.log(
    `  ${params.label}: merge ${holdings.length} ${params.asset} UTXO(s) → ~${amount} ${params.asset}`
  );
  if (params.dryRun) return true;

  const leg = await buildTransferExercise({
    jwt: params.jwt,
    senderParty: params.party,
    receiverParty: params.party,
    amount,
    inputHoldings: holdings,
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

  const after = await countHoldings(params.jwt, params.party);
  const utxoAfter = params.asset === "CBTC" ? after.cbtc : after.cc;
  console.log(
    `  ✓ ${params.label}: ${params.asset} UTXO ${holdings.length} → ${utxoAfter} (${isDirectTransferKind(leg.transferKind) ? "direct" : "offer path"})`
  );
  return true;
}

export async function runConsolidateTraderHoldings(): Promise<void> {
  assertMainnetNetwork();
  requireMainnetGuard();

  const asset = (parseArg("asset", "CBTC") ?? "CBTC").toUpperCase() as FarmAsset;
  if (asset !== "CBTC" && asset !== "CC") {
    throw new Error("--asset must be CBTC or CC");
  }
  const minUtxo = parseNumberArg("min-utxo", 3);
  const dryRun = parseFlag("dry-run");
  const partyOverride = parseArg("party");
  const traderFilter = parseArg("trader");
  const includeVault = parseFlag("vault");

  const fleet = loadFleet();
  const jwt = await getLedgerJwt();

  const targets: Array<{ label: string; party: string }> = [];
  if (partyOverride) {
    targets.push({ label: partyOverride.slice(0, 24), party: partyOverride });
  } else {
    const traders = traderFilter
      ? [{ hint: `trader-${traderFilter}`, party: traderParty(fleet, traderFilter) }]
      : fleet.traders;
    for (const t of traders) {
      targets.push({ label: t.hint, party: t.party });
    }
    if (includeVault) {
      targets.push({ label: "vault", party: vaultParty() });
    }
  }

  console.log(`Consolidate ${asset} (min ${minUtxo} UTXOs, ${targets.length} party/parties)\n`);

  let n = 0;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    const did = await consolidateParty({
      jwt,
      party: t.party,
      label: t.label,
      asset,
      minUtxo,
      dryRun
    });
    if (did) n++;
    if (i < targets.length - 1) await sleep(2000);
  }

  console.log(`\n✓ Consolidate complete (${n} merge(s)${dryRun ? ", dry-run" : ""}).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runConsolidateTraderHoldings().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
