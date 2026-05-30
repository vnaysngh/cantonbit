/**
 * redeem-history — reconstruct a party's redemption history from the Canton
 * ledger alone. No DB: the ledger is the source of truth.
 *
 * A redemption is three on-ledger events:
 *   1. BURN       CBTCWithdrawAccount_Withdraw  (we submit; carries amount)
 *   2. REQUEST    CBTCWithdrawAccount_CreateWithdrawRequest  (attestor; carries btcTxId)
 *   3. COMPLETE   CBTCWithdrawRequest_CompleteWithdrawal     (attestor)
 *
 * We scan the transaction tree for (1)–(3), correlate them by amount + time
 * order (a burn pairs with the next same-amount request, then its
 * completion), and derive a status. The btcTxId is then checked on-chain to
 * distinguish "sent" from "stalled".
 *
 * Status:
 *   burned        burn done; no attestor request yet.
 *   broadcasting  request + btcTxId exist; not yet on-chain.
 *   sent          btcTxId confirmed/visible on Bitcoin (or request completed).
 *   stalled       btcTxId assigned but not on-chain past the threshold.
 */

import "server-only";

import { getLedgerJwt, invalidateLedgerJwtCache } from "./auth";
import { NETWORK } from "./constants";
import { bitcoinTxOnChain } from "./redeem-ledger";

export type RedeemHistoryStatus =
  | "burned"
  | "broadcasting"
  | "sent"
  | "stalled";

export interface RedeemHistoryItem {
  /** Burn transaction updateId — stable id for the detail page. */
  id: string;
  amount: string;
  destinationBtcAddress: string | null;
  burnAt: string;
  /** Attestor request time (broadcasting milestone), if reached. */
  requestAt: string | null;
  /** Completion time (sent milestone), if reached. */
  completedAt: string | null;
  btcTxId: string | null;
  status: RedeemHistoryStatus;
}

// BitSafe docs: alert if broadcasting > 10 minutes. We surface that as stalled.
const STALL_AFTER_MS = 10 * 60 * 1000;

// How far back to scan. Matches the activity window.
const HISTORY_OFFSET_WINDOW = 60_000;

interface BurnEvent {
  updateId: string;
  at: string;
  amount: string;
  destination: string | null;
  offset: number;
}
interface RequestEvent {
  at: string;
  amount: string | null;
  btcTxId: string | null;
  destination: string | null;
  offset: number;
  /** The CBTCWithdrawRequest contractId created in this same tx — lets us
   *  cheaply tell if it was later archived (= CompleteWithdrawal ran = BTC sent). */
  requestCid: string | null;
}

/**
 * Scan the tree once and reconstruct the redeem history for a party,
 * newest-first. On-chain checks run only for requests that have a btcTxId.
 */
export async function getRedeemHistory(
  partyId: string,
): Promise<RedeemHistoryItem[]> {
  const { burns, requests, completedRequestCids } = await scanTree(partyId);

  // Correlate: for each burn (oldest first), claim the earliest still-unused
  // request with the same amount that occurred at/after the burn.
  const usedRequest = new Set<number>(); // request index
  const items: Array<RedeemHistoryItem & { _requestCid: string | null }> = [];

  const burnsAsc = [...burns].sort((a, b) => a.offset - b.offset);
  const reqAsc = [...requests].sort((a, b) => a.offset - b.offset);

  for (const burn of burnsAsc) {
    let matched: RequestEvent | null = null;
    for (let i = 0; i < reqAsc.length; i++) {
      if (usedRequest.has(i)) continue;
      const r = reqAsc[i];
      if (r.offset < burn.offset) continue;
      // Same amount (string compare is exact — both are decimal strings from
      // the same source scale). Fall back to numeric compare for safety.
      const sameAmount =
        r.amount === burn.amount ||
        (r.amount != null && Number(r.amount) === Number(burn.amount));
      if (!sameAmount) continue;
      matched = r;
      usedRequest.add(i);
      break;
    }

    items.push({
      id: burn.updateId,
      amount: burn.amount,
      destinationBtcAddress: burn.destination ?? matched?.destination ?? null,
      burnAt: burn.at,
      requestAt: matched?.at ?? null,
      completedAt: null,
      btcTxId: matched?.btcTxId ?? null,
      // Provisional; refined below using on-ledger archive (fast) or on-chain
      // check (slow, only when archive evidence is missing).
      status: matched ? "broadcasting" : "burned",
      _requestCid: matched?.requestCid ?? null,
    });
  }

  // Status refinement:
  // 1. ARCHIVE PATH (fast): if the request's contractId is in
  //    completedRequestCids, CompleteWithdrawal ran on Canton — that's the
  //    canonical "BTC was sent" signal. No mempool round-trip needed.
  // 2. CHAIN PATH (slow, mempool.space): only for requests that have a btcTxId
  //    but no archive (still in flight). This is what tells "broadcasting"
  //    apart from "stalled".
  const chainProbes: Array<Promise<void>> = [];
  for (const item of items) {
    if (item._requestCid && completedRequestCids.has(item._requestCid)) {
      item.status = "sent";
      item.completedAt = item.requestAt; // best-effort; on-chain timestamp not needed
      continue;
    }
    if (!item.btcTxId) continue; // no request yet — nothing to probe
    chainProbes.push(
      bitcoinTxOnChain(item.btcTxId).then((chain) => {
        if (chain.found) {
          item.status = "sent";
          item.completedAt = item.requestAt;
          return;
        }
        const since = item.requestAt
          ? new Date(item.requestAt).getTime()
          : Date.now();
        item.status =
          Date.now() - since > STALL_AFTER_MS ? "stalled" : "broadcasting";
      }),
    );
  }
  await Promise.all(chainProbes);

  // Strip the internal _requestCid before returning.
  const out: RedeemHistoryItem[] = items.map(
    ({ _requestCid, ...rest }) => (void _requestCid, rest),
  );

  // Newest first.
  out.sort((a, b) => (a.burnAt < b.burnAt ? 1 : -1));
  return out;
}

/** Find a single redeem by its burn updateId (for the detail page). */
export async function getRedeemById(
  partyId: string,
  burnUpdateId: string,
): Promise<RedeemHistoryItem | null> {
  const all = await getRedeemHistory(partyId);
  return all.find((r) => r.id === burnUpdateId) ?? null;
}

/** Scan the transaction tree for burns / requests / completions. */
async function scanTree(partyId: string): Promise<{
  burns: BurnEvent[];
  requests: RequestEvent[];
  /** Set of CBTCWithdrawRequest contractIds that have been archived (via
   *  CompleteWithdrawal). Membership is the canonical "BTC was sent" signal —
   *  saves a mempool.space round-trip per completed redeem. */
  completedRequestCids: Set<string>;
  /** Map of request offset → completion timestamp (best-effort, for UI). */
  completedAtByOffset: Map<number, string>;
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

  const burns: BurnEvent[] = [];
  const requests: RequestEvent[] = [];
  const completedRequestCids = new Set<string>();
  const completedAtByOffset = new Map<number, string>();
  // Side table: the CreatedTreeEvent for the CBTCWithdrawRequest in the same
  // tx as the CreateWithdrawRequest exercise — gives us the request contractId
  // so we can later check whether it was archived (= sent).
  // Captured during the same loop below.

  for (const u of result.arr ?? []) {
    const tx = (
      u as { update?: { TransactionTree?: { value?: TreeTx } } }
    ).update?.TransactionTree?.value;
    if (!tx) continue;
    const events = tx.eventsById ? Object.values(tx.eventsById) : [];

    // First pass: identify the choice exercises in this tx.
    let createReqAt: string | null = null;
    let createReqOffset: number | null = null;
    let createReqArg: Record<string, unknown> | null = null;
    let archivedReqCid: string | null = null;

    for (const ev of events) {
      const ex = (ev as { ExercisedTreeEvent?: { value?: ExercisedTree } })
        .ExercisedTreeEvent?.value;
      if (!ex) continue;
      const arg = ex.choiceArgument ?? {};
      if (ex.choice === "CBTCWithdrawAccount_Withdraw") {
        burns.push({
          updateId: tx.updateId,
          at: tx.effectiveAt,
          amount: (arg.amount as string | undefined) ?? "0",
          destination: (arg.destinationBtcAddress as string | undefined) ?? null,
          offset: tx.offset,
        });
      } else if (ex.choice === "CBTCWithdrawAccount_CreateWithdrawRequest") {
        createReqAt = tx.effectiveAt;
        createReqOffset = tx.offset;
        createReqArg = arg;
      } else if (ex.choice === "CBTCWithdrawRequest_CompleteWithdrawal") {
        // ex.contractId is the CBTCWithdrawRequest being archived.
        archivedReqCid = ex.contractId ?? null;
      }
    }

    // Second pass for this same tx: capture the new CBTCWithdrawRequest's
    // contractId from CreatedTreeEvent so we can index it.
    if (createReqAt !== null && createReqOffset !== null && createReqArg) {
      let requestCid: string | null = null;
      for (const ev of events) {
        const cr = (ev as { CreatedTreeEvent?: { value?: CreatedTree } })
          .CreatedTreeEvent?.value;
        if (
          cr?.templateId?.includes(
            "CBTC.WithdrawRequest:CBTCWithdrawRequest",
          ) &&
          cr.contractId
        ) {
          requestCid = cr.contractId;
          break;
        }
      }
      requests.push({
        at: createReqAt,
        amount: (createReqArg.amount as string | undefined) ?? null,
        btcTxId: (createReqArg.btcTxId as string | undefined) ?? null,
        destination:
          (createReqArg.destinationBtcAddress as string | undefined) ?? null,
        offset: createReqOffset,
        requestCid,
      });
    }

    if (archivedReqCid) {
      completedRequestCids.add(archivedReqCid);
      completedAtByOffset.set(tx.offset, tx.effectiveAt);
    }
  }

  // The CreateWithdrawRequest choiceArgument only carries btcTxId — not
  // amount/destination. Backfill those from the new CBTCWithdrawRequest's
  // createArgument (it has registrar/owner/amount/btcTxId/destinationBtcAddress).
  for (const u of result.arr ?? []) {
    const tx = (
      u as { update?: { TransactionTree?: { value?: TreeTx } } }
    ).update?.TransactionTree?.value;
    if (!tx) continue;
    for (const ev of tx.eventsById ? Object.values(tx.eventsById) : []) {
      const cr = (ev as { CreatedTreeEvent?: { value?: CreatedTree } })
        .CreatedTreeEvent?.value;
      if (
        !cr?.templateId?.includes("CBTC.WithdrawRequest:CBTCWithdrawRequest")
      ) {
        continue;
      }
      const a = cr.createArgument ?? {};
      const r = requests.find((x) => x.offset === tx.offset);
      if (r) {
        if (r.amount == null) r.amount = (a.amount as string) ?? null;
        if (r.btcTxId == null) r.btcTxId = (a.btcTxId as string) ?? null;
        if (r.destination == null) {
          r.destination = (a.destinationBtcAddress as string) ?? null;
        }
      }
    }
  }

  return { burns, requests, completedRequestCids, completedAtByOffset };
}

interface TreeTx {
  updateId: string;
  offset: number;
  effectiveAt: string;
  eventsById?: Record<string, unknown>;
}
interface ExercisedTree {
  choice?: string;
  contractId?: string;
  choiceArgument?: Record<string, unknown>;
}
interface CreatedTree {
  contractId?: string;
  templateId?: string;
  createArgument?: Record<string, unknown>;
}
