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
import { toBaseUnitsFloor } from "../../lib/amount-units";
import type { Holding } from "../../lib/types";
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
import {
  applyTreeToVaultCbtcCache,
  bootstrapVaultCbtcCacheRecent,
  getVaultCbtcCachedHoldings,
  isVaultCbtcCacheParty,
  removeVaultCbtcFromCache
} from "./lib/vault-cbtc-holdings";

const DEFAULT_CBTC = "0.0002";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Vault cache has many dust UTXOs; pick largest-first so we spend the fresh fund chunk. */
function pickVaultCbtcInputs(holdings: Holding[], amount: string): Holding[] {
  const sorted = [...holdings].sort(
    (a, b) => parseFloat(b.payload?.amount ?? "0") - parseFloat(a.payload?.amount ?? "0")
  );
  const target = toBaseUnitsFloor(amount, 8);
  const picked: Holding[] = [];
  let acc = 0n;
  for (const h of sorted) {
    if (acc >= target) break;
    picked.push(h);
    acc += toBaseUnitsFloor(h.payload?.amount ?? "0", 8);
  }
  if (acc < target) {
    throw new Error(`vault cache short: need ${amount} CBTC`);
  }
  return picked;
}

function vaultHoldingsInvalid(msg: string): boolean {
  return (
    msg.includes("Given holdings are invalid") ||
    msg.includes("LOCAL_VERDICT_INACTIVE_CONTRACTS") ||
    msg.includes("inactive contracts")
  );
}

async function transferCbtcFromVault(params: {
  jwt: string;
  senderParty: string;
  receiverParty: string;
  amount: string;
  label: string;
}): Promise<void> {
  const reg = await registrarForAsset(params.jwt, "CBTC");
  const fromVault = isVaultCbtcCacheParty(params.senderParty);
  const maxAttempts = fromVault ? 8 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let holdings = await holdingsForAsset(params.jwt, params.senderParty, "CBTC");
    if (fromVault) {
      const cached = getVaultCbtcCachedHoldings();
      if (cached.length > 0) holdings = cached;
    }
    if (holdings.length === 0) {
      throw new Error(`sender has no CBTC holdings (${params.senderParty.slice(0, 28)}…)`);
    }

    const inputs = fromVault ? pickVaultCbtcInputs(holdings, params.amount) : holdings;
    let leg;
    try {
      leg = await buildTransferExercise({
        jwt: params.jwt,
        senderParty: params.senderParty,
        receiverParty: params.receiverParty,
        amount: params.amount,
        inputHoldings: inputs,
        useAllInputHoldings: fromVault,
        instrumentId: reg.instrumentId,
        registrarAdmin: reg.admin,
        registryKind: reg.kind,
        assetSymbol: "CBTC",
        memo: "farm-trader-cbtc-fund"
      });
      await submitTransferLeg(params, reg, leg, inputs);
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (fromVault && vaultHoldingsInvalid(msg) && attempt < maxAttempts) {
        removeVaultCbtcFromCache(inputs.map((h) => h.contractId));
        console.warn(`  retry ${attempt}: dropped stale vault UTXO(s), picking next`);
        continue;
      }
      throw e;
    }
  }

  throw new Error(`${params.label}: exhausted vault UTXO retries`);
}

async function submitTransferLeg(
  params: {
    jwt: string;
    senderParty: string;
    receiverParty: string;
    amount: string;
    label: string;
  },
  reg: Awaited<ReturnType<typeof registrarForAsset>>,
  leg: Awaited<ReturnType<typeof buildTransferExercise>>,
  _inputs: Holding[]
): Promise<void> {
  const tag = params.receiverParty.slice(0, 16);
  const offerCmdId = `farm-fund-cbtc-offer-${tag}-${Date.now()}`;
  const { updateId, eventsById } = await submitLedgerCommands({
    jwt: params.jwt,
    actAs: [params.senderParty],
    commands: [leg.command],
    disclosedContracts: leg.disclosedContracts,
    commandId: offerCmdId,
    synchronizerId: leg.synchronizerId,
    workflowId: offerCmdId
  });
  if (isVaultCbtcCacheParty(params.senderParty)) {
    applyTreeToVaultCbtcCache(params.senderParty, eventsById);
  }

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
  const acceptResult = await submitLedgerCommands({
    jwt: params.jwt,
    actAs: [params.receiverParty],
    commands: [accept.command],
    disclosedContracts: accept.disclosedContracts,
    commandId: acceptCmdId,
    synchronizerId: accept.synchronizerId || leg.synchronizerId,
    workflowId: acceptCmdId
  });
  if (isVaultCbtcCacheParty(params.senderParty)) {
    applyTreeToVaultCbtcCache(params.senderParty, acceptResult.eventsById);
  }
  console.log(`  ✓ ${params.label}: ${params.amount} CBTC (offer ${offerCid.slice(0, 16)}…)`);
  void updateId;
}

function tradersFromFilter(
  fleet: ReturnType<typeof loadFleet>,
  traderFilter: string | undefined
): Array<{ hint: string; party: string }> {
  if (!traderFilter) return fleet.traders;
  return traderFilter.split(",").map((raw) => {
    const index = raw.trim();
    return { hint: `trader-${index}`, party: traderParty(fleet, index) };
  });
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

  if (sourceParty === fleet.vault) {
    const n = await bootstrapVaultCbtcCacheRecent(jwt, fleet.vault);
    if (n > 0) {
      console.log(`Vault CBTC cache: ${n} spendable holding(s) from recent ledger updates`);
    } else {
      console.warn("⚠ Vault CBTC cache empty after bootstrap — transfers may fail");
    }
  }

  const traders = tradersFromFilter(fleet, traderFilter);

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
