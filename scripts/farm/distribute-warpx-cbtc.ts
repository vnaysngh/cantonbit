#!/usr/bin/env npx tsx
/**
 * Distribute CBTC from the warpx-mainnet-1 party (where an off-ramp deposit
 * landed) to the vault and the farm traders:
 *   - --vault-cbtc  CBTC → settlement vault            (default 0.001)
 *   - --trader-cbtc CBTC → each of the 5 farm traders  (default 0.0001)
 *
 * Sender = warpx-mainnet-1 (NETWORK.warpxPartyId). Receivers accept the offer
 * (they are our parties; vault/traders actAs). Reuses the same transfer+accept
 * primitives as fund-traders-cbtc.ts.
 *
 * Usage:
 *   npm run farm:distribute-cbtc:mainnet -- --i-understand-mainnet --dry-run
 *   npm run farm:distribute-cbtc:mainnet -- --i-understand-mainnet
 *   npm run farm:distribute-cbtc:mainnet -- --i-understand-mainnet --vault-cbtc=0.001 --trader-cbtc=0.0001
 */
import { extractCreatedOfferCid } from "../../lib/mint-processor-logic";
import { NETWORK } from "../../lib/constants";
import { assertMainnetNetwork, loadFleet, vaultParty } from "./lib/config";
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
import { retry } from "./lib/retry";

const DEFAULT_VAULT_CBTC = "0.001";
const DEFAULT_TRADER_CBTC = "0.0001";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Send CBTC from `sender` to `receiver`; receiver accepts if not a direct transfer. */
async function sendCbtc(params: {
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
    memo: "farm-warpx-cbtc-distribute"
  });

  const tag = params.receiverParty.slice(0, 16);
  const offerCmdId = `farm-distribute-cbtc-offer-${tag}-${Date.now()}`;
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
  const acceptCmdId = `farm-distribute-cbtc-accept-${tag}-${Date.now()}`;
  await submitLedgerCommands({
    jwt: params.jwt,
    actAs: [params.receiverParty], // receiver accepts
    commands: [accept.command],
    disclosedContracts: accept.disclosedContracts,
    commandId: acceptCmdId,
    synchronizerId: accept.synchronizerId || leg.synchronizerId,
    workflowId: acceptCmdId
  });
  console.log(`  ✓ ${params.label}: ${params.amount} CBTC (offer ${offerCid.slice(0, 16)}… accepted)`);
}

export async function runDistributeWarpxCbtc(): Promise<void> {
  assertMainnetNetwork();
  requireMainnetGuard();

  const vaultCbtc = parseArg("vault-cbtc", DEFAULT_VAULT_CBTC)!;
  const traderCbtc = parseArg("trader-cbtc", DEFAULT_TRADER_CBTC)!;
  const dryRun = parseFlag("dry-run");

  const sender = NETWORK.warpxPartyId; // warpx-mainnet-1
  const vault = vaultParty();
  const fleet = loadFleet();
  const jwt = await getLedgerJwt();

  const senderCbtc = await cbtcBalance(jwt, sender);
  const need = parseFloat(vaultCbtc) + parseFloat(traderCbtc) * fleet.traders.length;
  console.log(`Network:  ${process.env.NEXT_PUBLIC_NETWORK ?? "mainnet"}`);
  console.log(`Sender:   ${sender} (warpx)`);
  console.log(`Sender CBTC: ${senderCbtc}`);
  console.log(`Plan:     ${vaultCbtc} → vault, ${traderCbtc} → each of ${fleet.traders.length} traders (need ~${need})\n`);

  if (parseFloat(senderCbtc) < need) {
    throw new Error(`warpx CBTC ${senderCbtc} < required ${need}`);
  }
  if (dryRun) {
    console.log(`  [dry-run] vault ← ${vaultCbtc} CBTC`);
    for (const t of fleet.traders) console.log(`  [dry-run] ${t.hint} ← ${traderCbtc} CBTC`);
    console.log("\n[dry-run] no funds moved.");
    return;
  }

  // Retry each send through transient traffic/sequencer rejections (the node's
  // traffic bucket may be temporarily exhausted → SEQUENCER_REQUEST_FAILED).
  const send = (receiverParty: string, amount: string, label: string) =>
    retry(
      () => sendCbtc({ jwt, senderParty: sender, receiverParty, amount, label }),
      {
        label: `send-${label}`,
        retries: 20,
        maxMs: 120_000, // base-traffic bucket can take a while to refill past the tx cost
        onRetry: (attempt, delayMs, err) =>
          console.warn(
            `  ${label} retry ${attempt} in ${Math.round(delayMs / 1000)}s: ${(err instanceof Error ? err.message : String(err)).slice(0, 80)}`
          )
      }
    );

  // 1) vault
  console.log(`[vault] ${vault.slice(0, 28)}…`);
  await send(vault, vaultCbtc, "vault");
  await sleep(2000);

  // 2) each trader
  for (let i = 0; i < fleet.traders.length; i++) {
    const t = fleet.traders[i]!;
    console.log(`[${i + 1}/${fleet.traders.length}] ${t.hint} (${t.party.slice(0, 28)}…)`);
    await send(t.party, traderCbtc, t.hint);
    if (i < fleet.traders.length - 1) await sleep(2000);
  }

  const senderAfter = await cbtcBalance(jwt, sender);
  const vaultAfter = await cbtcBalance(jwt, vault);
  console.log(`\n✓ Distribute complete. warpx CBTC: ${senderCbtc} → ${senderAfter}; vault CBTC now ${vaultAfter}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDistributeWarpxCbtc().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
