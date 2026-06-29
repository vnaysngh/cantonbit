#!/usr/bin/env npx tsx
/**
 * Send each farm trader's EXCESS CC (balance − keep) to the settlement vault.
 *
 * Each trader keeps `--keep` CC (default 100); everything above that is moved to
 * the vault. Traders already at/below the keep amount are skipped. Reuses the
 * proven CC-transfer path from fund-traders-cc.ts (direct delivery if the vault
 * has CC preapproval, otherwise create-offer + vault-accepts).
 *
 * Usage:
 *   npm run farm:consolidate-cc:mainnet -- --i-understand-mainnet --dry-run
 *   npm run farm:consolidate-cc:mainnet -- --i-understand-mainnet
 *   npm run farm:consolidate-cc:mainnet -- --i-understand-mainnet --keep=100 --trader=0
 *
 * Source = each trader (.farm-fleet.mainnet.json). Destination = vault.
 */
import { fromBaseUnits, toBaseUnitsFloor } from "../../lib/amount-units";
import { CC_ASSET } from "../../lib/canton-assets";
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

const DEFAULT_KEEP = "100";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Transfer CC from `senderParty` to `receiverParty`; accept the offer if not direct.
 *  Mirrors fund-traders-cc.ts transferCcFromVault but generic on direction:
 *  here sender=trader, receiver=vault, so the VAULT accepts. */
async function transferCc(params: {
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
    memo: "farm-trader-cc-consolidate"
  });

  const tag = params.senderParty.slice(0, 16);
  const offerCmdId = `farm-consolidate-cc-offer-${tag}-${Date.now()}`;
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
    console.log(`  ✓ ${params.label}: ${params.amount} CC → vault (direct)`);
    return;
  }

  // No preapproval on the vault → it landed as a pending offer; the vault accepts.
  const offerCid = extractCreatedOfferCid(eventsById);
  if (!offerCid) throw new Error(`${params.label}: offer CID missing from submit tree`);

  const accept = await buildAcceptExercise({
    jwt: params.jwt,
    offerContractId: offerCid,
    registrarAdmin: reg.admin,
    registryKind: "cc"
  });
  const acceptCmdId = `farm-consolidate-cc-accept-${tag}-${Date.now()}`;
  await submitLedgerCommands({
    jwt: params.jwt,
    actAs: [params.receiverParty], // vault accepts
    commands: [accept.command],
    disclosedContracts: accept.disclosedContracts,
    commandId: acceptCmdId,
    synchronizerId: accept.synchronizerId || leg.synchronizerId,
    workflowId: acceptCmdId
  });
  console.log(`  ✓ ${params.label}: ${params.amount} CC → vault (offer ${offerCid.slice(0, 16)}… accepted)`);
}

export async function runConsolidateTraderCc(): Promise<void> {
  assertMainnetNetwork();
  requireMainnetGuard();

  const keep = parseArg("keep", DEFAULT_KEEP)!;
  const traderFilter = parseArg("trader");
  const dryRun = parseFlag("dry-run");

  const keepUnits = toBaseUnitsFloor(keep, CC_ASSET.decimals);
  if (keepUnits < 0n) throw new Error("--keep must be >= 0");

  const fleet = loadFleet();
  const vault = vaultParty();
  const jwt = await getLedgerJwt();

  const traders = traderFilter
    ? [{ hint: `trader-${traderFilter}`, party: traderParty(fleet, traderFilter) }]
    : fleet.traders;

  const vaultCcBefore = await ccBalance(jwt, vault);
  console.log(`Network:  ${process.env.NEXT_PUBLIC_NETWORK ?? "mainnet"}`);
  console.log(`Vault:    ${vault}`);
  console.log(`Keep:     ${keep} CC per trader (excess → vault)`);
  console.log(`Traders:  ${traders.length}`);
  console.log(`Vault CC: ${vaultCcBefore} (before)\n`);

  let totalPlanned = 0n;
  const plan: Array<{ hint: string; party: string; amount: string }> = [];
  for (const t of traders) {
    const bal = await ccBalance(jwt, t.party);
    const balUnits = toBaseUnitsFloor(bal, CC_ASSET.decimals);
    const excessUnits = balUnits - keepUnits;
    if (excessUnits <= 0n) {
      console.log(`  – ${t.hint}: CC=${bal} ≤ keep ${keep} — skip`);
      continue;
    }
    const amount = fromBaseUnits(excessUnits, CC_ASSET.decimals);
    totalPlanned += excessUnits;
    plan.push({ hint: t.hint, party: t.party, amount });
    console.log(`  • ${t.hint}: CC=${bal} → send ${amount} CC, keep ${keep}`);
  }
  console.log(
    `\nTotal to move: ${fromBaseUnits(totalPlanned, CC_ASSET.decimals)} CC across ${plan.length} trader(s)\n`
  );

  if (dryRun) {
    console.log("[dry-run] no funds moved.");
    return;
  }
  if (plan.length === 0) {
    console.log("Nothing to do — all traders at/below keep.");
    return;
  }

  for (let i = 0; i < plan.length; i++) {
    const p = plan[i]!;
    const before = await ccBalance(jwt, p.party);
    console.log(`[${i + 1}/${plan.length}] ${p.hint} (${p.party.slice(0, 28)}…) CC=${before}`);
    await transferCc({
      jwt,
      senderParty: p.party,
      receiverParty: vault,
      amount: p.amount,
      label: p.hint
    });
    const after = await ccBalance(jwt, p.party);
    console.log(`    balance: ${before} → ${after} CC\n`);
    if (i < plan.length - 1) await sleep(2000);
  }

  const vaultCcAfter = await ccBalance(jwt, vault);
  console.log(`Vault CC after: ${vaultCcBefore} → ${vaultCcAfter}`);
  console.log("\n✓ Consolidate trader CC → vault complete.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runConsolidateTraderCc().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
