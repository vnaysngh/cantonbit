/**
 * mint-history — reconstruct a party's mint history from the Canton ledger
 * (+ the `deposit_accounts` Supabase mapping for the BTC address).
 *
 * From the user party's perspective, a mint produces a clean trail:
 *
 *   1. (off-ledger)  user sends BTC to their deposit address.
 *
 *   2. btc_detected  — BTC tx is unconfirmed in mempool. We surface this
 *                      immediately so the user knows we see it.
 *
 *   3. (off-ledger)  attestors wait 6 confirmations, mint CBTC onto warpx party.
 *
 *   4. minted        — a `cbtc-mint-accept-*` transaction delivers an unlocked
 *                      Holding to the user. This is the "spendable CBTC" moment.
 *
 * Status logic:
 *   btc_detected  — unconfirmed tx in mempool (confirmed txs are already being
 *                   processed by cron so we don't surface them as pending).
 *   minted        — delivered Holding found in the ledger scan window.
 *
 * No DB write paths here — pure read.
 */

import "server-only";

import { getLedgerJwt, invalidateLedgerJwtCache } from "./auth";
import { NETWORK } from "./constants";
import { createSupabaseServiceClient } from "./supabase/server";

export type MintHistoryStatus = "pending" | "btc_detected" | "minted";

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
  /** Bitcoin txid seen in mempool for pending deposits. Null until BTC is broadcast. */
  btcTxId: string | null;
  /** Number of Bitcoin confirmations (0 = mempool only). Null until BTC is detected. */
  btcConfirmations: number | null;
  status: MintHistoryStatus;
}

const HISTORY_OFFSET_WINDOW = 60_000;

const HOLDING_SUFFIX = "Utility.Registry.Holding.V0.Holding:Holding";

// ─── Mempool helpers ────────────────────────────────────────────────────────

interface MempoolTx {
  txid: string;
  status: { confirmed: boolean; block_height?: number; block_time?: number };
  vout: Array<{ scriptpubkey_address?: string; value?: number }>;
}

interface BtcDetection {
  txid: string;
  amountSats: number;
}

/**
 * Fetch ALL incoming BTC transactions to the given address from mempool.space,
 * newest-first. Returns empty array if network is devnet or mempool unreachable.
 */
async function getAllIncomingBtcTxs(btcAddress: string): Promise<BtcDetection[]> {
  const base =
    NETWORK.name === "mainnet"
      ? "https://mempool.space/api"
      : NETWORK.name === "testnet"
        ? "https://mempool.space/testnet/api"
        : null;

  if (!base) return [];

  try {
    const res = await fetch(
      `${base}/address/${encodeURIComponent(btcAddress)}/txs`,
      { cache: "no-store" },
    );
    if (!res.ok) return [];
    const txs = (await res.json()) as MempoolTx[];

    const results: BtcDetection[] = [];
    for (const tx of txs) {
      // Only surface unconfirmed txs — confirmed ones have already been (or will
      // shortly be) minted by the cron, so we don't want to show them as pending.
      if (tx.status.confirmed) continue;
      const vout = tx.vout.find((v) => v.scriptpubkey_address === btcAddress);
      if (!vout) continue; // not an incoming tx to this address
      results.push({
        txid: tx.txid,
        amountSats: vout.value ?? 0,
      });
    }
    return results;
  } catch {
    return [];
  }
}

interface DeliveryEvent {
  updateId: string;
  at: string;
  amount: string;
}

/** Newest-first mint history for a party. */
export async function getMintHistory(partyId: string): Promise<MintHistoryItem[]> {
  if (!partyId) return [];

  const [{ deliveries }, supabaseDeposits] = await Promise.all([
    scanTree(partyId),
    fetchAllDepositAccounts(partyId),
  ]);

  const items: MintHistoryItem[] = [];

  // 1. Surface all completed deliveries as "minted" rows.
  //    Attach the deposit address from the first (only) deposit account if we have one.
  const depositAddress = supabaseDeposits[0]?.bitcoinAddress ?? null;
  const depositContractId = supabaseDeposits[0]?.contractId ?? null;
  const depositCreatedAt = supabaseDeposits[0]?.createdAt ?? null;

  for (const d of deliveries) {
    items.push({
      id: d.updateId,
      amount: d.amount,
      bitcoinAddress: depositAddress,
      depositAccountCreatedAt: depositCreatedAt,
      depositAccountContractId: depositContractId,
      deliveredAt: d.at,
      deliveryUpdateId: d.updateId,
      btcTxId: null,
      btcConfirmations: null,
      status: "minted",
    });
  }

  // 2. Surface any unconfirmed BTC txs as "btc_detected" rows.
  for (const deposit of supabaseDeposits) {
    if (!deposit.bitcoinAddress) continue;

    // Only unconfirmed txs — confirmed ones are already being processed by cron.
    const unconfirmedTxs = await getAllIncomingBtcTxs(deposit.bitcoinAddress);
    for (const tx of unconfirmedTxs) {
      const amountBtc = tx.amountSats > 0
        ? (tx.amountSats / 1e8).toFixed(8).replace(/\.?0+$/, "")
        : null;
      items.push({
        id: `pending-${tx.txid}`,
        amount: amountBtc,
        bitcoinAddress: deposit.bitcoinAddress,
        depositAccountCreatedAt: deposit.createdAt,
        depositAccountContractId: deposit.contractId,
        deliveredAt: null,
        deliveryUpdateId: null,
        btcTxId: tx.txid,
        btcConfirmations: 0,
        status: "btc_detected",
      });
    }
  }

  // Newest first.
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

/** Scan the tree for `cbtc-mint-accept-*` delivery transactions. */
async function scanTree(partyId: string): Promise<{
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
    if (!isMintAccept) continue;

    const events = tx.eventsById ? Object.values(tx.eventsById) : [];

    for (const ev of events) {
      const cr = (ev as { CreatedTreeEvent?: { value?: CreatedTree } })
        .CreatedTreeEvent?.value;
      if (!cr) continue;

      // Delivery — a Holding created for the user inside a mint-accept tx.
      if (
        cr.templateId?.includes(HOLDING_SUFFIX) &&
        (cr.createArgument?.owner as string | undefined) === partyId &&
        !cr.createArgument?.lock // delivered = unlocked
      ) {
        deliveries.push({
          updateId: tx.updateId,
          at: tx.effectiveAt,
          amount: (cr.createArgument?.amount as string | undefined) ?? "0",
        });
      }
    }
  }

  return { deliveries };
}

interface SupabaseDeposit {
  contractId: string;
  bitcoinAddress: string | null;
  /** ISO timestamp from Supabase created_at column (used for ordering). */
  createdAt: string;
}

/**
 * Fetch ALL deposit accounts for this party from Supabase, oldest-first.
 * This is the source of truth — not bounded by the ledger scan window.
 */
async function fetchAllDepositAccounts(partyId: string): Promise<SupabaseDeposit[]> {
  try {
    const supabase = await createSupabaseServiceClient();
    const { data, error } = await supabase
      .from("deposit_accounts")
      .select("deposit_account_contract_id, bitcoin_address, created_at")
      .eq("canton_party_id", partyId)
      .order("created_at", { ascending: true });
    if (error) {
      console.warn(`[mint-history] deposit_accounts lookup failed:`, error);
      return [];
    }
    return (
      (data as Array<{
        deposit_account_contract_id: string;
        bitcoin_address: string | null;
        created_at: string;
      }>) ?? []
    ).map((row) => ({
      contractId: row.deposit_account_contract_id,
      bitcoinAddress: row.bitcoin_address,
      createdAt: row.created_at,
    }));
  } catch (e) {
    console.warn(`[mint-history] supabase unavailable:`, e);
    return [];
  }
}

interface TreeTx {
  updateId: string;
  effectiveAt: string;
  workflowId?: string;
  eventsById?: Record<string, unknown>;
}
interface CreatedTree {
  contractId?: string;
  templateId?: string;
  createArgument?: Record<string, unknown>;
}
