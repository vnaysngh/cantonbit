#!/usr/bin/env npx tsx
/**
 * Accept a pending incoming CBTC transfer offer for the settlement vault.
 *
 * Lists the vault's pending TransferInstruction offers (native ledger ACS query —
 * no app `lib/transfer.ts` import, which pulls `server-only` and cannot run under
 * tsx), finds the CBTC offer matching --amount (the off-ramped CBTC returning from
 * Temple), and accepts it (vault actAs). Refuses on zero or ambiguous (>1) matches
 * so we never accept the wrong transfer.
 *
 * Usage:
 *   npm run farm:accept-cbtc:mainnet -- --i-understand-mainnet --amount=0.0072484698 --dry-run
 *   npm run farm:accept-cbtc:mainnet -- --i-understand-mainnet --amount=0.0072484698
 */
import { toBaseUnitsFloor } from "../../lib/amount-units";
import { CBTC_ASSET } from "../../lib/canton-assets";
import { NETWORK } from "../../lib/constants";
import { assertMainnetNetwork, vaultParty } from "./lib/config";
import { getLedgerJwt } from "./lib/jwt";
import {
  buildAcceptExercise,
  cbtcBalance,
  registrarForAsset,
  submitLedgerCommands
} from "./lib/ledger";
import { parseArg, parseFlag, requireMainnetGuard } from "./lib/parse-args";

const TRANSFER_INSTRUCTION_INTERFACE =
  "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction";

const AMOUNT_TOLERANCE_UNITS = 1n; // allow 1-sat display/rounding slack

type PendingOffer = {
  contractId: string;
  sender: string;
  receiver: string;
  amount: string;
  instrumentId?: string;
};

type RawTransfer = {
  sender?: string;
  receiver?: string;
  amount?: string;
  instrumentId?: { id?: string };
};

/** Native ACS query: active TransferInstruction offers where `party` is involved. */
async function listVaultPendingOffers(
  jwt: string,
  party: string
): Promise<PendingOffer[]> {
  const endRes = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${jwt}` },
    cache: "no-store"
  });
  if (!endRes.ok) throw new Error(`ledger-end failed (${endRes.status})`);
  const { offset } = (await endRes.json()) as { offset: number };

  // WarpX node caps the ACS list at ~200 and 413s above it; the vault is involved
  // in many historical TransferInstruction contracts. Cap at 150 (node limit) — the
  // incoming offer we want is recent, so it should be within the returned set. If a
  // match is not found, widen via the post-filter or accept by cid manually.
  const res = await fetch(`${NETWORK.ledgerHost}/v2/state/active-contracts?limit=150`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({
      filter: {
        filtersByParty: {
          [party]: {
            cumulative: [
              {
                identifierFilter: {
                  InterfaceFilter: {
                    value: {
                      interfaceId: TRANSFER_INSTRUCTION_INTERFACE,
                      includeInterfaceView: true,
                      includeCreatedEventBlob: false
                    }
                  }
                }
              }
            ]
          }
        }
      },
      verbose: false,
      activeAtOffset: offset
    }),
    cache: "no-store"
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    throw new Error(`pending-offers ACS query failed (${res.status}): ${text}`);
  }

  const raw = (await res.json()) as unknown[];
  const out: PendingOffer[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const ev =
      (item as { contractEntry?: { JsActiveContract?: { createdEvent?: unknown } } })
        ?.contractEntry?.JsActiveContract?.createdEvent ??
      (item as { JsActiveContract?: { createdEvent?: unknown } })?.JsActiveContract
        ?.createdEvent;
    const e = ev as
      | {
          contractId?: string;
          createArgument?: { transfer?: RawTransfer };
          interfaceViews?: Array<{
            viewStatus?: { code?: number };
            viewValue?: { transfer?: RawTransfer } | RawTransfer;
          }>;
        }
      | undefined;
    if (!e?.contractId) continue;

    let t: RawTransfer | undefined = e.createArgument?.transfer;
    if (!t?.receiver) {
      for (const v of e.interfaceViews ?? []) {
        if (v.viewStatus?.code) continue;
        const vv = v.viewValue;
        const cand = (vv && "transfer" in vv ? vv.transfer : vv) as RawTransfer | undefined;
        if (cand?.receiver) {
          t = cand;
          break;
        }
      }
    }
    if (!t?.receiver) continue;
    out.push({
      contractId: e.contractId,
      sender: t.sender ?? "",
      receiver: t.receiver,
      amount: t.amount ?? "0",
      instrumentId: t.instrumentId?.id
    });
  }
  return out;
}

export async function runAcceptVaultCbtc(): Promise<void> {
  assertMainnetNetwork();
  requireMainnetGuard();

  const amountArg = parseArg("amount");
  if (!amountArg) throw new Error("--amount=<cbtc> is required (the expected incoming amount)");
  const wantUnits = toBaseUnitsFloor(amountArg, CBTC_ASSET.decimals);
  if (wantUnits <= 0n) throw new Error("--amount must be > 0");
  const dryRun = parseFlag("dry-run");

  const vault = vaultParty();
  const jwt = await getLedgerJwt();

  const cbtcBefore = await cbtcBalance(jwt, vault);
  console.log(`Network:  ${process.env.NEXT_PUBLIC_NETWORK ?? "mainnet"}`);
  console.log(`Vault:    ${vault}`);
  console.log(`Vault CBTC: ${cbtcBefore} (before)`);
  console.log(`Looking for incoming CBTC offer ≈ ${amountArg}\n`);

  const offers = await listVaultPendingOffers(jwt, vault);
  const incoming = offers.filter((o) => {
    if (o.receiver && o.receiver !== vault) return false; // vault must be the receiver
    const u = toBaseUnitsFloor(o.amount, CBTC_ASSET.decimals);
    const diff = u > wantUnits ? u - wantUnits : wantUnits - u;
    return diff <= AMOUNT_TOLERANCE_UNITS;
  });

  console.log(`Pending offers visible to vault: ${offers.length}; ${incoming.length} match the amount.`);
  for (const o of incoming) {
    console.log(`  • cid ${o.contractId.slice(0, 24)}…  amount ${o.amount}  from ${(o.sender || "?").slice(0, 20)}…`);
  }

  if (incoming.length === 0) {
    throw new Error(
      `no pending CBTC offer to the vault matching ${amountArg}. ` +
        `It may not have arrived yet, or the amount differs — re-check the sender.`
    );
  }
  if (incoming.length > 1) {
    throw new Error(
      `${incoming.length} offers match ${amountArg} — refusing ambiguous auto-accept; accept by cid manually.`
    );
  }

  const offer = incoming[0]!;
  if (dryRun) {
    console.log(`\n[dry-run] would accept cid ${offer.contractId.slice(0, 24)}… (no funds moved).`);
    return;
  }

  const reg = await registrarForAsset(jwt, "CBTC");
  const accept = await buildAcceptExercise({
    jwt,
    offerContractId: offer.contractId,
    registrarAdmin: reg.admin,
    registryKind: "cbtc"
  });
  const cmdId = `farm-accept-cbtc-${offer.contractId.slice(0, 16)}-${Date.now()}`;
  await submitLedgerCommands({
    jwt,
    actAs: [vault],
    commands: [accept.command],
    disclosedContracts: accept.disclosedContracts,
    commandId: cmdId,
    synchronizerId: accept.synchronizerId,
    workflowId: cmdId
  });

  const cbtcAfter = await cbtcBalance(jwt, vault);
  console.log(`\n✓ Accepted CBTC offer ${offer.contractId.slice(0, 24)}…`);
  console.log(`Vault CBTC after: ${cbtcBefore} → ${cbtcAfter}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAcceptVaultCbtc().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
