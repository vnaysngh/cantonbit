#!/usr/bin/env npx tsx
/**
 * Send CC from the settlement vault to an ARBITRARY external party (e.g. a Loop
 * wallet) for off-ramping. Unlike consolidate-trader-cc-to-vault, the receiver is
 * NOT a party we control, so we CANNOT accept on its behalf:
 *   - if the receiver has CC preapproval → the transfer auto-settles (direct).
 *   - otherwise it lands as a pending offer the RECEIVER must accept in their own
 *     wallet; we print the offer CID and stop (no accept here).
 *
 * Usage:
 *   npm run farm:send-cc:mainnet -- --i-understand-mainnet --to <party> --cc 3000 --dry-run
 *   npm run farm:send-cc:mainnet -- --i-understand-mainnet --to <party> --cc 3000
 *   # leave a floor in the vault instead of naming the amount:
 *   npm run farm:send-cc:mainnet -- --i-understand-mainnet --to <party> --leave 544
 *
 * Source = vault (CANTON_SWAP_SETTLEMENT_PARTY). Exactly one of --cc / --leave.
 */
import { fromBaseUnits, toBaseUnitsFloor } from "../../lib/amount-units";
import { CC_ASSET } from "../../lib/canton-assets";
import { extractCreatedOfferCid } from "../../lib/mint-processor-logic";
import { assertMainnetNetwork, vaultParty } from "./lib/config";
import { getLedgerJwt } from "./lib/jwt";
import {
  buildTransferExercise,
  ccBalance,
  holdingsForAsset,
  isDirectTransferKind,
  registrarForAsset,
  submitLedgerCommands
} from "./lib/ledger";
import { parseArg, parseFlag, requireMainnetGuard } from "./lib/parse-args";

function isValidPartyId(p: string): boolean {
  return /^[0-9a-zA-Z_-]+::1220[0-9a-f]+$/.test(p);
}

export async function runSendVaultCc(): Promise<void> {
  assertMainnetNetwork();
  requireMainnetGuard();

  const to = parseArg("to");
  if (!to || !isValidPartyId(to)) {
    throw new Error(`--to must be a valid party id (got: ${to ?? "<missing>"})`);
  }
  const ccArg = parseArg("cc");
  const leaveArg = parseArg("leave");
  const dryRun = parseFlag("dry-run");
  if ((ccArg && leaveArg) || (!ccArg && !leaveArg)) {
    throw new Error("specify exactly one of --cc <amount> or --leave <floor>");
  }

  const vault = vaultParty();
  const jwt = await getLedgerJwt();

  const vaultCcStr = await ccBalance(jwt, vault);
  const vaultUnits = toBaseUnitsFloor(vaultCcStr, CC_ASSET.decimals);

  let sendUnits: bigint;
  if (ccArg) {
    sendUnits = toBaseUnitsFloor(ccArg, CC_ASSET.decimals);
  } else {
    const leaveUnits = toBaseUnitsFloor(leaveArg!, CC_ASSET.decimals);
    sendUnits = vaultUnits - leaveUnits;
  }
  if (sendUnits <= 0n) throw new Error("computed send amount is <= 0");
  if (sendUnits > vaultUnits) {
    throw new Error(
      `vault has ${vaultCcStr} CC, cannot send ${fromBaseUnits(sendUnits, CC_ASSET.decimals)}`
    );
  }

  const sendAmount = fromBaseUnits(sendUnits, CC_ASSET.decimals);
  const leftAmount = fromBaseUnits(vaultUnits - sendUnits, CC_ASSET.decimals);

  console.log(`Network:  ${process.env.NEXT_PUBLIC_NETWORK ?? "mainnet"}`);
  console.log(`Vault:    ${vault}`);
  console.log(`To:       ${to}`);
  console.log(`Vault CC: ${vaultCcStr} (before)`);
  console.log(`Send:     ${sendAmount} CC   → leaves ${leftAmount} CC in vault\n`);

  if (dryRun) {
    console.log("[dry-run] no funds moved.");
    return;
  }

  const reg = await registrarForAsset(jwt, "CC");
  const holdings = await holdingsForAsset(jwt, vault, "CC");
  if (holdings.length === 0) throw new Error("vault has no CC holdings");

  const leg = await buildTransferExercise({
    jwt,
    senderParty: vault,
    receiverParty: to,
    amount: sendAmount,
    inputHoldings: holdings,
    instrumentId: reg.instrumentId,
    registrarAdmin: reg.admin,
    registryKind: reg.kind,
    assetSymbol: "CC",
    memo: "farm-vault-cc-offramp"
  });

  const cmdId = `farm-send-cc-${to.slice(0, 16)}-${Date.now()}`;
  const { eventsById } = await submitLedgerCommands({
    jwt,
    actAs: [vault],
    commands: [leg.command],
    disclosedContracts: leg.disclosedContracts,
    commandId: cmdId,
    synchronizerId: leg.synchronizerId,
    workflowId: cmdId
  });

  if (isDirectTransferKind(leg.transferKind)) {
    console.log(`✓ ${sendAmount} CC delivered DIRECTLY to ${to.slice(0, 24)}… (receiver has CC preapproval)`);
  } else {
    const offerCid = extractCreatedOfferCid(eventsById) ?? "<not found>";
    console.log(
      `✓ ${sendAmount} CC sent as a PENDING OFFER (cid ${offerCid.slice(0, 24)}…).\n` +
        `  The receiving Loop wallet must ACCEPT this incoming transfer in its own wallet — ` +
        `we cannot accept on its behalf.`
    );
  }

  const vaultCcAfter = await ccBalance(jwt, vault);
  console.log(`\nVault CC after: ${vaultCcStr} → ${vaultCcAfter}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSendVaultCc().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
