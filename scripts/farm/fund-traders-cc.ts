#!/usr/bin/env npx tsx
/**
 * Send CC from the settlement vault to every farm trader (or one --trader=N).
 *
 * Usage:
 *   npm run farm:fund-traders-cc:mainnet -- --i-understand-mainnet
 *   npm run farm:fund-traders-cc:mainnet -- --i-understand-mainnet --cc=50 --trader=0
 *   npm run farm:fund-traders-cc:mainnet -- --i-understand-mainnet --dry-run
 *
 * Source defaults to CANTON_SWAP_SETTLEMENT_PARTY (oranj-settle-mainnet).
 * Destinations come from .farm-fleet.mainnet.json (or FARM_FLEET_JSON).
 */
import { extractCreatedOfferCid } from "../../lib/mint-processor-logic";
import { assertMainnetNetwork, loadFleet, traderParty, vaultParty } from "./lib/config";
import { getLedgerJwt } from "./lib/jwt";
import {
  buildAcceptExercise,
  buildTransferExercise,
  ccBalance,
  holdingsForAsset,
  isDirectTransferKind,
  registrarForAsset,
  submitLedgerCommands
} from "./lib/ledger";
import { parseArg, parseFlag, requireMainnetGuard } from "./lib/parse-args";

const DEFAULT_CC = "50";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function transferCcFromVault(params: {
  jwt: string;
  senderParty: string;
  receiverParty: string;
  amount: string;
  label: string;
}): Promise<void> {
  const reg = await registrarForAsset(params.jwt, "CC");
  const holdings = await holdingsForAsset(params.jwt, params.senderParty, "CC");
  if (holdings.length === 0) {
    throw new Error(`sender has no CC holdings (${params.senderParty.slice(0, 28)}…)`);
  }

  const leg = await buildTransferExercise({
    jwt: params.jwt,
    senderParty: params.senderParty,
    receiverParty: params.receiverParty,
    amount: params.amount,
    inputHoldings: holdings,
    instrumentId: reg.instrumentId,
    registrarAdmin: reg.admin,
    registryKind: reg.kind,
    assetSymbol: "CC",
    memo: "farm-trader-cc-fund"
  });

  const tag = params.receiverParty.slice(0, 16);
  const offerCmdId = `farm-fund-cc-offer-${tag}-${Date.now()}`;
  const { eventsById } = await submitLedgerCommands({
    jwt: params.jwt,
    actAs: [params.senderParty],
    commands: [leg.command],
    disclosedContracts: leg.disclosedContracts,
    commandId: offerCmdId,
    synchronizerId: leg.synchronizerId,
    workflowId: offerCmdId
  });

  if (isDirectTransferKind(leg.transferKind)) {
    console.log(`  ✓ ${params.label}: ${params.amount} CC delivered (direct)`);
    return;
  }

  const offerCid = extractCreatedOfferCid(eventsById);
  if (!offerCid) throw new Error(`${params.label}: offer CID missing from submit tree`);

  const accept = await buildAcceptExercise({
    jwt: params.jwt,
    offerContractId: offerCid,
    registrarAdmin: reg.admin,
    registryKind: "cc"
  });
  const acceptCmdId = `farm-fund-cc-accept-${tag}-${Date.now()}`;
  await submitLedgerCommands({
    jwt: params.jwt,
    actAs: [params.receiverParty],
    commands: [accept.command],
    disclosedContracts: accept.disclosedContracts,
    commandId: acceptCmdId,
    synchronizerId: accept.synchronizerId || leg.synchronizerId,
    workflowId: acceptCmdId
  });
  console.log(`  ✓ ${params.label}: ${params.amount} CC (offer ${offerCid.slice(0, 16)}…)`);
}

export async function runFundTradersCc(): Promise<void> {
  assertMainnetNetwork();
  requireMainnetGuard();

  const ccAmount = parseArg("cc", DEFAULT_CC)!;
  const sourceParty = parseArg("from") ?? vaultParty();
  const traderFilter = parseArg("trader");
  const dryRun = parseFlag("dry-run");

  if (parseFloat(ccAmount) <= 0) {
    throw new Error("--cc must be > 0");
  }

  const fleet = loadFleet();
  const jwt = await getLedgerJwt();

  const traders = traderFilter
    ? [{ hint: `trader-${traderFilter}`, party: traderParty(fleet, traderFilter) }]
    : fleet.traders;

  const sourceCcBefore = await ccBalance(jwt, sourceParty);
  console.log(`Network:  ${process.env.NEXT_PUBLIC_NETWORK ?? "mainnet"}`);
  console.log(`Source:   ${sourceParty}`);
  console.log(`CC each:  ${ccAmount}`);
  console.log(`Traders:  ${traders.length}`);
  console.log(`Vault CC: ${sourceCcBefore} (before)\n`);

  const need = parseFloat(ccAmount) * traders.length;
  if (parseFloat(sourceCcBefore) < need) {
    console.warn(
      `⚠ Source may be short: need ~${need} CC for ${traders.length}×${ccAmount}, have ${sourceCcBefore}`
    );
  }

  if (dryRun) {
    for (const t of traders) {
      const bal = await ccBalance(jwt, t.party);
      console.log(`  [dry-run] ${t.hint}: would send ${ccAmount} CC (now ${bal} CC)`);
    }
    return;
  }

  for (let i = 0; i < traders.length; i++) {
    const t = traders[i]!;
    const before = await ccBalance(jwt, t.party);
    console.log(`[${i + 1}/${traders.length}] ${t.hint} (${t.party.slice(0, 28)}…) CC=${before}`);
    await transferCcFromVault({
      jwt,
      senderParty: sourceParty,
      receiverParty: t.party,
      amount: ccAmount,
      label: t.hint
    });
    const after = await ccBalance(jwt, t.party);
    console.log(`    balance: ${before} → ${after} CC\n`);
    if (i < traders.length - 1) await sleep(2000);
  }

  const sourceCcAfter = await ccBalance(jwt, sourceParty);
  console.log(`Source CC after: ${sourceCcAfter}`);
  console.log("\n✓ Fund traders CC complete.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runFundTradersCc().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
