/**
 * Activity derivation — scans the Canton update stream for a party and
 * turns transactions into user-facing rows (mint / redeem / send / receive).
 *
 * Why server-side: the m2m JWT can read as any cbtc-user party on this
 * validator, and we don't want to expose the JWT to the browser.
 *
 * Why scan vs. index: cBTC volume is low enough that scanning the last
 * 24h of updates on demand is fine. If the user has thousands of mints
 * we'll need to add Supabase-backed indexing — but until then this avoids
 * the complexity of an indexer.
 */

import "server-only";

import { getLedgerJwt } from "./auth";
import { NETWORK } from "./constants";
import type { ActivityKind, ActivityRow } from "./types";

const TAG = "[activity]";

// Match by qualified-name suffix so we don't have to track package hashes
// when DARs rotate. These are the substrings we look for on templateId.
const HOLDING_SUFFIX = "Utility.Registry.Holding.V0.Holding:Holding";
const TRANSFER_OFFER_SUFFIX = "TransferOffer";
const TRANSFER_INSTRUCTION_SUFFIX = "TransferInstruction";
const DEPOSIT_ACCOUNT_SUFFIX = "CBTC.DepositAccount:CBTCDepositAccount";
const WITHDRAW_ACCOUNT_SUFFIX = "CBTC.WithdrawAccount:CBTCWithdrawAccount";

// How many ledger offsets to look back. The Canton ledger is monotonic
// and growth-rate-bounded, so a fixed window is plenty for "recent
// activity." 50k offsets ≈ a day or so of WarpX traffic at current rates.
const ACTIVITY_OFFSET_WINDOW = 50_000;

interface RawCreated {
  contractId: string;
  templateId: string;
  createArgument?: {
    owner?: string;
    amount?: string;
    transfer?: {
      sender?: string;
      receiver?: string;
      amount?: string;
    };
    receiver?: string; // some templates store this top-level
    sender?: string;
    btcAddress?: string;
  };
}

interface RawArchived {
  contractId: string;
  templateId: string;
}

interface RawTransaction {
  updateId: string;
  offset: number;
  effectiveAt: string;
  events: Array<{ CreatedEvent?: RawCreated; ArchivedEvent?: RawArchived }>;
}

async function fetchLedgerEnd(jwt: string): Promise<number> {
  const res = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${jwt}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`getLedgerEnd failed (${res.status})`);
  const { offset } = (await res.json()) as { offset: number };
  return offset ?? 0;
}

async function fetchUpdates(
  jwt: string,
  partyId: string,
  beginExclusive: number,
  endInclusive: number,
): Promise<RawTransaction[]> {
  const res = await fetch(`${NETWORK.ledgerHost}/v2/updates`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({
      beginExclusive,
      endInclusive,
      filter: {
        filtersByParty: {
          [partyId]: {
            cumulative: [
              {
                identifierFilter: {
                  WildcardFilter: { value: { includeCreatedEventBlob: false } },
                },
              },
            ],
          },
        },
      },
      verbose: true,
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    throw new Error(`getUpdates failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as unknown[];
  const out: RawTransaction[] = [];
  for (const item of data) {
    const txn = (item as { update?: { Transaction?: { value?: RawTransaction } } })
      .update?.Transaction?.value;
    if (txn) out.push(txn);
  }
  return out;
}

function ownerOf(ev: RawCreated): string | undefined {
  return ev.createArgument?.owner;
}

function classifyTransaction(
  txn: RawTransaction,
  partyId: string,
): ActivityRow | null {
  // Bucket events by intent. Holdings tell us amount + direction; the other
  // templates (DepositAccount, WithdrawAccount, TransferOffer) help us pick
  // the kind label.
  const createdHoldingsForUser: RawCreated[] = [];
  const archivedHoldings: RawArchived[] = [];
  const createdTransferOffers: RawCreated[] = [];
  const archivedTransferOffers: RawArchived[] = [];
  let archivedDepositAccount = false;
  let createdWithdrawAccount = false;
  let archivedWithdrawAccount: RawArchived | null = null;
  let withdrawDestination: string | undefined;

  for (const e of txn.events) {
    if (e.CreatedEvent) {
      const c = e.CreatedEvent;
      if (c.templateId.includes(HOLDING_SUFFIX)) {
        if (ownerOf(c) === partyId) createdHoldingsForUser.push(c);
      } else if (
        c.templateId.includes(TRANSFER_OFFER_SUFFIX) ||
        c.templateId.includes(TRANSFER_INSTRUCTION_SUFFIX)
      ) {
        createdTransferOffers.push(c);
      } else if (c.templateId.includes(WITHDRAW_ACCOUNT_SUFFIX)) {
        createdWithdrawAccount = true;
        withdrawDestination = c.createArgument?.btcAddress;
      }
    }
    if (e.ArchivedEvent) {
      const a = e.ArchivedEvent;
      if (a.templateId.includes(HOLDING_SUFFIX)) {
        archivedHoldings.push(a);
      } else if (
        a.templateId.includes(TRANSFER_OFFER_SUFFIX) ||
        a.templateId.includes(TRANSFER_INSTRUCTION_SUFFIX)
      ) {
        archivedTransferOffers.push(a);
      } else if (a.templateId.includes(DEPOSIT_ACCOUNT_SUFFIX)) {
        archivedDepositAccount = true;
      } else if (a.templateId.includes(WITHDRAW_ACCOUNT_SUFFIX)) {
        archivedWithdrawAccount = a;
      }
    }
  }
  // archivedWithdrawAccount is currently only used as a signal — keep it
  // referenced so the linter doesn't complain if we later branch on it.
  void archivedWithdrawAccount;

  // The most reliable signal is the holding side. Without a holding event
  // touching us, the transaction wasn't a balance-changing one for this user.
  if (createdHoldingsForUser.length === 0 && archivedHoldings.length === 0) {
    return null;
  }

  // Classify direction by net effect on the user's holdings.
  const inboundAmount = sumAmounts(createdHoldingsForUser.map((h) => h.createArgument?.amount));
  // We don't know the archived amount from the archive event alone; the
  // amount comes from the matching Transfer/Withdraw event on the same txn
  // or — for sends — from the TransferOffer.transfer.amount.
  const outboundOfferAmount = sumAmounts(
    createdTransferOffers
      .filter((o) => o.createArgument?.transfer?.sender === partyId)
      .map((o) => o.createArgument?.transfer?.amount),
  );

  if (inboundAmount !== "0") {
    // Inbound: kind depends on whether a DepositAccount was archived in the
    // same txn (= mint from BitSafe) or this is a transfer accept.
    const kind: ActivityKind = archivedDepositAccount ? "minted" : "received";
    const sender = createdTransferOffers.length
      ? createdTransferOffers[0]?.createArgument?.transfer?.sender ?? ""
      : "";
    const counterparty = kind === "minted" ? "Bitcoin deposit" : sender;
    return {
      id: txn.updateId,
      kind,
      amount: inboundAmount,
      counterparty,
      timestamp: txn.effectiveAt,
      status: "complete",
      txid: txn.updateId,
    };
  }

  // Outbound: classify by what else happened. If a WithdrawAccount was
  // created/archived, it's a redeem. Otherwise it's a send.
  if (createdWithdrawAccount || archivedHoldings.length > 0) {
    const isRedeem = createdWithdrawAccount;
    const kind: ActivityKind = isRedeem ? "redeemed" : "sent";
    // For sends, the outboundOfferAmount tells us how much we offered. For
    // redeems we sum the archived holdings — but we don't have amounts on
    // archive events, so we approximate with the offer amount or the user's
    // delta. As a fallback, omit the amount sign and show "—".
    const amount = isRedeem ? "0" : outboundOfferAmount; // redeem amount needs a different source
    const counterparty = isRedeem
      ? withdrawDestination ?? "Bitcoin withdrawal"
      : createdTransferOffers[0]?.createArgument?.transfer?.receiver ?? "";

    // For sends, if we couldn't find the offer (e.g. it was archived in the
    // same txn for an atomic accept-on-create flow), skip rather than show
    // a misleading "0".
    if (!isRedeem && amount === "0") {
      return null;
    }

    return {
      id: txn.updateId,
      kind,
      amount,
      counterparty,
      timestamp: txn.effectiveAt,
      status: "complete",
      txid: txn.updateId,
    };
  }

  // Holding archived with nothing else recognizable — likely a transfer-offer
  // accept on the sender side. Pull amount from the offer that got archived
  // (we'd need its createArgument, which we don't have here). Skip.
  void archivedTransferOffers;
  return null;
}

function sumAmounts(values: Array<string | undefined>): string {
  let satsTotal = 0n;
  for (const v of values) {
    if (!v) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    satsTotal += BigInt(Math.round(n * 1e8));
  }
  if (satsTotal === 0n) return "0";
  return (Number(satsTotal) / 1e8).toFixed(8);
}

export async function getActivityForParty(
  partyId: string,
  options: { limit?: number } = {},
): Promise<ActivityRow[]> {
  const limit = options.limit ?? 50;
  if (!partyId) return [];

  console.log(`${TAG} getActivityForParty partyId=${partyId.slice(0, 30)}... limit=${limit}`);

  const jwt = await getLedgerJwt();
  const ledgerEnd = await fetchLedgerEnd(jwt);
  const fromOffset = Math.max(0, ledgerEnd - ACTIVITY_OFFSET_WINDOW);

  const txns = await fetchUpdates(jwt, partyId, fromOffset, ledgerEnd);
  console.log(`${TAG} fetched ${txns.length} transactions in window`);

  const rows: ActivityRow[] = [];
  for (const txn of txns) {
    const row = classifyTransaction(txn, partyId);
    if (row) rows.push(row);
  }

  // Newest first, cap to limit.
  rows.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  return rows.slice(0, limit);
}
