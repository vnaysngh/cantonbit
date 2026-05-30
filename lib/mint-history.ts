/**
 * mint-history — reconstruct a party's mint history from the Canton ledger
 * (+ the `deposit_accounts` Supabase mapping for the BTC address).
 *
 * From the user party's perspective, a mint produces a clean trail:
 *
 *   1. DEPOSIT ACCOUNT CREATED       a CBTCDepositAccount Created event
 *                                    (the contractId is the join key to the
 *                                    Supabase row that has the BTC address)
 *
 *   2. (off-ledger)  user sends BTC to the deposit address — this lives only
 *                    on Bitcoin; the detail page enriches with mempool.space.
 *
 *   3. (off-ledger)  attestors watch for 6 confirmations and mint CBTC onto
 *                    the warpx party — this is invisible to the user party.
 *
 *   4. DELIVERED TO USER             a `cbtc-mint-accept-*` transaction where
 *                                    a TransferInstruction_Accept produces an
 *                                    unlocked Holding owned by the user.
 *                                    This is the "you have spendable CBTC" moment.
 *
 * Status (from the user's perspective):
 *
 *   pending   — deposit account exists, no matching delivery yet. The BTC may
 *               or may not have been sent; the detail page does the on-chain
 *               check. Activity feed shows it as "pending" either way.
 *   minted    — a delivered Holding exists for this deposit account (matched
 *               by amount + ordering — see the correlation below).
 *
 * Correlation between a deposit account and the delivered Holding is by time
 * order: deliveries arrive in the same order the deposits clear, and we pair
 * each delivery with the oldest still-unmatched deposit account.
 *
 * No DB write paths here — pure read. The deposit_accounts table is read for
 * the BTC address only; everything else comes from the ledger.
 */

import "server-only";

import { getLedgerJwt, invalidateLedgerJwtCache } from "./auth";
import { NETWORK } from "./constants";
import { createSupabaseServiceClient } from "./supabase/server";

export type MintHistoryStatus = "pending" | "minted";

export interface MintHistoryItem {
  /** Stable id for the detail page. Delivery updateId if delivered; else the
   *  deposit account's contractId so pending mints are still linkable. */
  id: string;
  /** Decimal-string CBTC amount. Null for pending (we don't know until delivered). */
  amount: string | null;
  /** Bitcoin address the user is expected to / did send to. Null if the
   *  deposit_accounts row is missing (very rare). */
  bitcoinAddress: string | null;
  /** When the deposit account was created on Canton. */
  depositAccountCreatedAt: string | null;
  /** Deposit account contractId — the join key + the bridge between the
   *  Canton-side trail and the BTC-side trail. Null for orphan deliveries
   *  whose deposit account is older than our history scan window. */
  depositAccountContractId: string | null;
  /** When the cron delivered the Holding (= mint visible to user). Null while pending. */
  deliveredAt: string | null;
  /** Canton updateId of the delivery transaction. Null while pending. */
  deliveryUpdateId: string | null;
  status: MintHistoryStatus;
}

const HISTORY_OFFSET_WINDOW = 60_000;

const DEPOSIT_ACCOUNT_SUFFIX = "CBTC.DepositAccount:CBTCDepositAccount";
const HOLDING_SUFFIX = "Utility.Registry.Holding.V0.Holding:Holding";

interface DepositAccountCreate {
  contractId: string;
  at: string;
  offset: number;
}

interface DeliveryEvent {
  updateId: string;
  at: string;
  offset: number;
  amount: string;
}

/**
 * Newest-first mint history for a party.
 *
 * Best-effort: if the ledger scan or Supabase lookup fails, returns []. The
 * activity feed treats this as "no mint history available" and falls back to
 * other sources.
 */
export async function getMintHistory(partyId: string): Promise<MintHistoryItem[]> {
  if (!partyId) return [];

  const { deposits, deliveries } = await scanTree(partyId);

  // Pair deliveries to deposit accounts by time order (oldest first).
  const usedDeposit = new Set<number>();
  const items: MintHistoryItem[] = [];

  const depositsAsc = [...deposits].sort((a, b) => a.offset - b.offset);
  const deliveriesAsc = [...deliveries].sort((a, b) => a.offset - b.offset);

  // Match each delivery to the earliest unmatched deposit account that was
  // created before it. (Mints are processed FIFO by the cron.) A delivery
  // without a matching deposit account in our scan window is an "orphan" —
  // the deposit account was created before the window began. We still surface
  // the delivery as a completed mint, just without the deposit-side info.
  const matched: Array<{
    deposit: DepositAccountCreate | null;
    delivery: DeliveryEvent | null;
  }> = [];

  for (const d of deliveriesAsc) {
    let claimed = -1;
    for (let i = 0; i < depositsAsc.length; i++) {
      if (usedDeposit.has(i)) continue;
      if (depositsAsc[i].offset > d.offset) break; // deposit can't post-date its delivery
      claimed = i;
      break;
    }
    if (claimed >= 0) {
      usedDeposit.add(claimed);
      matched.push({ deposit: depositsAsc[claimed], delivery: d });
    } else {
      // Orphan delivery: deposit account is older than our window. Pass
      // `deposit: null` so the detail page knows not to invent a fake step.
      matched.push({ deposit: null, delivery: d });
    }
  }

  // Any deposit account left unmatched is a pending mint.
  for (let i = 0; i < depositsAsc.length; i++) {
    if (usedDeposit.has(i)) continue;
    matched.push({ deposit: depositsAsc[i], delivery: null });
  }

  // Look up BTC addresses for the deposit accounts we DO know about.
  const knownDepositCids = matched
    .map((m) => m.deposit?.contractId)
    .filter((c): c is string => !!c);
  const addressByCid = await fetchBitcoinAddresses(knownDepositCids);

  for (const m of matched) {
    items.push({
      // Stable id: delivery updateId if delivered (mints are uniquely indexed
      // by their accept transaction), else the pending deposit account cid.
      id:
        m.delivery?.updateId ??
        m.deposit?.contractId ??
        `orphan-${Math.random().toString(36).slice(2)}`,
      amount: m.delivery?.amount ?? null,
      bitcoinAddress: m.deposit
        ? (addressByCid.get(m.deposit.contractId) ?? null)
        : null,
      depositAccountCreatedAt: m.deposit?.at ?? null,
      depositAccountContractId: m.deposit?.contractId ?? null,
      deliveredAt: m.delivery?.at ?? null,
      deliveryUpdateId: m.delivery?.updateId ?? null,
      status: m.delivery ? "minted" : "pending",
    });
  }

  // Newest first by the most-recent timestamp we have.
  items.sort((a, b) => {
    const ta = a.deliveredAt ?? a.depositAccountCreatedAt ?? "";
    const tb = b.deliveredAt ?? b.depositAccountCreatedAt ?? "";
    return ta < tb ? 1 : ta > tb ? -1 : 0;
  });

  return items;
}

/** Fetch a single mint by its id (used by the detail page). */
export async function getMintById(
  partyId: string,
  id: string,
): Promise<MintHistoryItem | null> {
  const all = await getMintHistory(partyId);
  return all.find((m) => m.id === id) ?? null;
}

/** Scan the tree for deposit-account creates and `cbtc-mint-accept-*` deliveries. */
async function scanTree(partyId: string): Promise<{
  deposits: DepositAccountCreate[];
  deliveries: DeliveryEvent[];
}> {
  const run = async (token: string) => {
    const endRes = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (endRes.status === 401) return { status: 401 as const };
    if (!endRes.ok) throw new Error(`getLedgerEnd failed (${endRes.status})`);
    const { offset } = (await endRes.json()) as { offset?: number };
    const end = offset ?? 0;
    const begin = Math.max(0, end - HISTORY_OFFSET_WINDOW);

    const res = await fetch(`${NETWORK.ledgerHost}/v2/updates/trees`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        beginExclusive: begin,
        endInclusive: end,
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
        verbose: false,
      }),
      cache: "no-store",
    });
    if (res.status === 401) return { status: 401 as const };
    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      throw new Error(`updates/trees failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as unknown;
    const arr = Array.isArray(data)
      ? data
      : ((data as { updates?: unknown[] }).updates ?? []);
    return { status: 200 as const, arr };
  };

  let jwt = await getLedgerJwt();
  let result = await run(jwt);
  if (result.status === 401) {
    invalidateLedgerJwtCache();
    jwt = await getLedgerJwt();
    result = await run(jwt);
    if (result.status === 401) {
      throw new Error("Authentication failed — JWT invalid after refresh");
    }
  }

  const deposits: DepositAccountCreate[] = [];
  const deliveries: DeliveryEvent[] = [];

  for (const u of result.arr ?? []) {
    const tx = (
      u as {
        update?: { TransactionTree?: { value?: TreeTx } };
      }
    ).update?.TransactionTree?.value;
    if (!tx) continue;
    const isMintAccept =
      typeof tx.workflowId === "string" &&
      tx.workflowId.startsWith("cbtc-mint-accept-");
    const events = tx.eventsById ? Object.values(tx.eventsById) : [];

    for (const ev of events) {
      const cr = (ev as { CreatedTreeEvent?: { value?: CreatedTree } })
        .CreatedTreeEvent?.value;
      if (!cr) continue;

      // 1) deposit account create — record it
      if (
        cr.templateId?.includes(DEPOSIT_ACCOUNT_SUFFIX) &&
        cr.contractId
      ) {
        const arg = cr.createArgument ?? {};
        // Only count this party's deposit accounts.
        if (arg.owner === partyId) {
          deposits.push({
            contractId: cr.contractId,
            at: tx.effectiveAt,
            offset: tx.offset,
          });
        }
      }

      // 2) delivery — a Holding created for the user inside a mint-accept tx
      if (
        isMintAccept &&
        cr.templateId?.includes(HOLDING_SUFFIX) &&
        (cr.createArgument?.owner as string | undefined) === partyId &&
        !cr.createArgument?.lock // delivered = unlocked
      ) {
        deliveries.push({
          updateId: tx.updateId,
          at: tx.effectiveAt,
          offset: tx.offset,
          amount: (cr.createArgument?.amount as string | undefined) ?? "0",
        });
      }
    }
  }

  return { deposits, deliveries };
}

/** Read the BTC address map from Supabase by deposit-account contractId. */
async function fetchBitcoinAddresses(
  cids: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (cids.length === 0) return out;
  try {
    const supabase = await createSupabaseServiceClient();
    const { data, error } = await supabase
      .from("deposit_accounts")
      .select("deposit_account_contract_id, bitcoin_address")
      .in("deposit_account_contract_id", cids);
    if (error) {
      console.warn(`[mint-history] deposit_accounts lookup failed:`, error);
      return out;
    }
    for (const row of (data as Array<{
      deposit_account_contract_id: string;
      bitcoin_address: string | null;
    }>) ?? []) {
      if (row.bitcoin_address) {
        out.set(row.deposit_account_contract_id, row.bitcoin_address);
      }
    }
  } catch (e) {
    console.warn(`[mint-history] supabase unavailable:`, e);
  }
  return out;
}

interface TreeTx {
  updateId: string;
  offset: number;
  effectiveAt: string;
  workflowId?: string;
  eventsById?: Record<string, unknown>;
}
interface CreatedTree {
  contractId?: string;
  templateId?: string;
  createArgument?: Record<string, unknown>;
}
