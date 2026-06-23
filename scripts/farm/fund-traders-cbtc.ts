#!/usr/bin/env npx tsx
/**
 * Send CBTC from the settlement vault to every farm trader (or one --trader=N).
 *
 * Usage:
 *   npm run farm:fund-traders-cbtc:mainnet -- --i-understand-mainnet
 *   npm run farm:fund-traders-cbtc:mainnet -- --i-understand-mainnet --cbtc=0.0002 --trader=0
 *   npm run farm:fund-traders-cbtc:mainnet -- --i-understand-mainnet --dry-run
 */
import { extractCreatedOfferCid } from "../../lib/mint-processor-logic";
import { assertMainnetNetwork, loadFleet, traderParty, vaultParty } from "./lib/config";
import { getLedgerJwt } from "./lib/jwt";
import {
  buildAcceptExercise,
  buildTransferExercise,
  cbtcBalance,
  holdingsForAsset,
  isDirectTransferKind,
  registrarForAsset,
  submitLedgerCommands
} from "./lib/ledger";
import { parseArg, parseFlag, requireMainnetGuard } from "./lib/parse-args";

const DEFAULT_CBTC = "0.0002";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function transferCbtcFromVault(params: {
  jwt: string;
  senderParty: string;
  receiverParty: string;
  amount: string;
  label: string;
}): Promise<void> {
  const reg = await registrarForAsset(params.jwt, "CBTC");
  const holdings = await holdingsForAsset(params.jwt, params.senderParty, "CBTC");
  if (holdings.length === 0) {
    throw new Error(`sender has no CBTC holdings (${params.senderParty.slice(0, 28)}…)`);
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
    assetSymbol: "CBTC",
    memo: "farm-trader-cbtc-fund"
  });

  const tag = params.receiverParty.slice(0, 16);
  const offerCmdId = `farm-fund-cbtc-offer-${tag}-${Date.now()}`;
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
    console.log(`  ✓ ${params.label}: ${params.amount} CBTC delivered (direct)`);
    return;
  }

  const offerCid = extractCreatedOfferCid(eventsById);
  if (!offerCid) throw new Error(`${params.label}: offer CID missing from submit tree`);

  const accept = await buildAcceptExercise({
    jwt: params.jwt,
    offerContractId: offerCid,
    registrarAdmin: reg.admin,
    registryKind: "cbtc"
  });
  const acceptCmdId = `farm-fund-cbtc-accept-${tag}-${Date.now()}`;
  await submitLedgerCommands({
    jwt: params.jwt,
    actAs: [params.receiverParty],
    commands: [accept.command],
    disclosedContracts: accept.disclosedContracts,
    commandId: acceptCmdId,
    synchronizerId: accept.synchronizerId || leg.synchronizerId,
    workflowId: acceptCmdId
  });
  console.log(`  ✓ ${params.label}: ${params.amount} CBTC (offer ${offerCid.slice(0, 16)}…)`);
}

export async function runFundTradersCbtc(): Promise<void> {
  assertMainnetNetwork();
  requireMainnetGuard();

  const cbtcAmount = parseArg("cbtc", DEFAULT_CBTC)!;
  const sourceParty = parseArg("from") ?? vaultParty();
  const traderFilter = parseArg("trader");
  const dryRun = parseFlag("dry-run");

  if (parseFloat(cbtcAmount) <= 0) {
    throw new Error("--cbtc must be > 0");
  }

  const fleet = loadFleet();
  const jwt = await getLedgerJwt();

  const traders = traderFilter
    ? [{ hint: `trader-${traderFilter}`, party: traderParty(fleet, traderFilter) }]
    : fleet.traders;

  const sourceCbtcBefore = await cbtcBalance(jwt, sourceParty);
  console.log(`Network:  ${process.env.NEXT_PUBLIC_NETWORK ?? "mainnet"}`);
  console.log(`Source:   ${sourceParty}`);
  console.log(`CBTC each: ${cbtcAmount}`);
  console.log(`Traders:  ${traders.length}`);
  console.log(`Vault CBTC: ${sourceCbtcBefore} (before)\n`);

  const need = parseFloat(cbtcAmount) * traders.length;
  if (parseFloat(sourceCbtcBefore) < need) {
    console.warn(
      `⚠ Source may be short: need ~${need} CBTC for ${traders.length}×${cbtcAmount}, have ${sourceCbtcBefore}`
    );
  }

  if (dryRun) {
    for (const t of traders) {
      const bal = await cbtcBalance(jwt, t.party);
      console.log(`  [dry-run] ${t.hint}: would send ${cbtcAmount} CBTC (now ${bal} CBTC)`);
    }
    return;
  }

  for (let i = 0; i < traders.length; i++) {
    const t = traders[i]!;
    const before = await cbtcBalance(jwt, t.party);
    console.log(`[${i + 1}/${traders.length}] ${t.hint} (${t.party.slice(0, 28)}…) CBTC=${before}`);
    await transferCbtcFromVault({
      jwt,
      senderParty: sourceParty,
      receiverParty: t.party,
      amount: cbtcAmount,
      label: t.hint
    });
    const after = await cbtcBalance(jwt, t.party);
    console.log(`    balance: ${before} → ${after} CBTC\n`);
    if (i < traders.length - 1) await sleep(2000);
  }

  const sourceCbtcAfter = await cbtcBalance(jwt, sourceParty);
  console.log(`Source CBTC after: ${sourceCbtcAfter}`);
  console.log("\n✓ Fund traders CBTC complete.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runFundTradersCbtc().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
