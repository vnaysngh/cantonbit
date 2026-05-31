/**
 * redeem-history — reconstruct a party's redemption history from the Canton
 * ledger alone. No DB: the ledger is the source of truth.
 *
 * A redemption is three on-ledger events:
 *   1. BURN       CBTCWithdrawAccount_Withdraw        (we submit; carries amount)
 *   2. REQUEST    CBTCWithdrawAccount_CreateWithdrawRequest  (attestor; carries btcTxId)
 *   3. COMPLETE   CBTCWithdrawRequest_CompleteWithdrawal    (attestor)
 *
 * Correlation: burns and requests are matched oldest-first by offset. A burn
 * pairs with the next unused request whose amount is within 10% above the burn
 * amount — BitSafe adds a small fee so request amount >= burn amount always.
 *
 * Status:
 *   burned        burn done; attestor hasn't created a request yet.
 *   broadcasting  request exists with a btcTxId; BTC not yet on-chain.
 *   sent          CompleteWithdrawal ran on Canton (canonical signal).
 *   stalled       btcTxId assigned but not on-chain past the stall threshold.
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

// How far back to scan (in ledger offsets). At WarpX mainnet rates ~1 offset
// per minute, 60k offsets ≈ 6 weeks — enough to cover all redeems in practice.
const HISTORY_OFFSET_WINDOW = 60_000;

// BitSafe adds a small fee so request.amount >= burn.amount. Allow up to 10%
// over to handle the fee while rejecting clearly mismatched pairs.
const FEE_TOLERANCE = 0.10;

interface BurnEvent {
  updateId: string;
  at: string;
  amount: string;
  destination: string | null;
  offset: number;
}

interface RequestEvent {
  at: string;
  /** Amount from CBTCWithdrawRequest.createArgument (includes BitSafe fee). */
  amount: string | null;
  btcTxId: string | null;
  destination: string | null;
  offset: number;
  /** CBTCWithdrawRequest contractId — present in completedRequestCids when
   *  CompleteWithdrawal ran, which is the canonical "BTC was sent" signal. */
  requestCid: string | null;
}

/**
 * Scan the ledger once and reconstruct the redeem history for a party,
 * newest-first. CompleteWithdrawal archive detection avoids mempool round-trips
 * for completed redeems.
 */
export async function getRedeemHistory(
  partyId: string,
): Promise<RedeemHistoryItem[]> {
  const { burns, requests, completedRequestCids } = await scanTree(partyId);

  // Sort oldest-first for greedy correlation.
  const burnsAsc = [...burns].sort((a, b) => a.offset - b.offset);
  const reqAsc = [...requests].sort((a, b) => a.offset - b.offset);
  const usedRequest = new Set<number>();

  const items: Array<RedeemHistoryItem & { _requestCid: string | null }> = [];

  for (const burn of burnsAsc) {
    const burnAmt = Number(burn.amount);
    let matched: RequestEvent | null = null;

    for (let i = 0; i < reqAsc.length; i++) {
      if (usedRequest.has(i)) continue;
      const r = reqAsc[i];
      if (r.offset <= burn.offset) continue; // request must come after burn
      if (r.amount == null) continue;
      const reqAmt = Number(r.amount);
      // BitSafe adds a fee: request amount is slightly above burn amount.
      if (reqAmt < burnAmt - 1e-9) continue;
      if (reqAmt > burnAmt * (1 + FEE_TOLERANCE) + 1e-9) continue;
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
      status: matched ? "broadcasting" : "burned",
      _requestCid: matched?.requestCid ?? null,
    });
  }

  // Status refinement — two paths:
  // FAST: CompleteWithdrawal archived the request on Canton → "sent".
  // SLOW: mempool.space check — only for in-flight requests (no archive yet).
  const chainProbes: Array<Promise<void>> = [];

  for (const item of items) {
    if (item._requestCid && completedRequestCids.has(item._requestCid)) {
      item.status = "sent";
      item.completedAt = item.requestAt;
      continue;
    }
    if (!item.btcTxId) continue; // burned, no request yet — nothing to probe
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

  // Return newest-first, strip internal field.
  return items
    .map(({ _requestCid: _, ...rest }) => rest)
    .sort((a, b) => (a.burnAt < b.burnAt ? 1 : -1));
}

/** Find a single redeem by its burn updateId (for the detail page). */
export async function getRedeemById(
  partyId: string,
  burnUpdateId: string,
): Promise<RedeemHistoryItem | null> {
  const all = await getRedeemHistory(partyId);
  return all.find((r) => r.id === burnUpdateId) ?? null;
}

// ─── Ledger scan ────────────────────────────────────────────────────────────

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

/** Scan the transaction tree for burns / requests / completions in one pass. */
async function scanTree(partyId: string): Promise<{
  burns: BurnEvent[];
  requests: RequestEvent[];
  completedRequestCids: Set<string>;
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

  // withdrawAccountDestination: CBTCWithdrawAccount contractId → BTC address.
  // The burn choiceArgument only carries {tokens, amount} — the destination
  // address is on the account contract itself, recovered here by contractId.
  const withdrawAccountDestination = new Map<string, string>();

  for (const u of result.arr ?? []) {
    const tx = (
      u as { update?: { TransactionTree?: { value?: TreeTx } } }
    ).update?.TransactionTree?.value;
    if (!tx) continue;

    const events = tx.eventsById ? Object.values(tx.eventsById) : [];

    // Collect all CBTCWithdrawAccount creates in this tx for destination lookup.
    for (const ev of events) {
      const cr = (ev as { CreatedTreeEvent?: { value?: CreatedTree } })
        .CreatedTreeEvent?.value;
      if (
        cr?.contractId &&
        cr.templateId?.includes("CBTC.WithdrawAccount:CBTCWithdrawAccount")
      ) {
        const dest = cr.createArgument?.destinationBtcAddress as string | undefined;
        if (dest) withdrawAccountDestination.set(cr.contractId, dest);
      }
    }

    // Track what happens in this tx.
    let createReqAt: string | null = null;
    let createReqOffset: number | null = null;
    let createReqArg: Record<string, unknown> | null = null;
    let archivedReqCid: string | null = null;
    // The CBTCWithdrawRequest created in the same tx as CreateWithdrawRequest.
    let newRequestCid: string | null = null;
    // Amount/destination from the newly created WithdrawRequest (more reliable
    // than the choiceArgument which only carries btcTxId).
    let newRequestAmount: string | null = null;
    let newRequestDestination: string | null = null;
    let newRequestBtcTxId: string | null = null;

    for (const ev of events) {
      // Exercised events — burns, requests, completions.
      const ex = (ev as { ExercisedTreeEvent?: { value?: ExercisedTree } })
        .ExercisedTreeEvent?.value;
      if (ex) {
        const arg = ex.choiceArgument ?? {};
        if (ex.choice === "CBTCWithdrawAccount_Withdraw") {
          const destination =
            (arg.destinationBtcAddress as string | undefined) ??
            (ex.contractId
              ? (withdrawAccountDestination.get(ex.contractId) ?? null)
              : null);
          burns.push({
            updateId: tx.updateId,
            at: tx.effectiveAt,
            amount: (arg.amount as string | undefined) ?? "0",
            destination,
            offset: tx.offset,
          });
        } else if (ex.choice === "CBTCWithdrawAccount_CreateWithdrawRequest") {
          createReqAt = tx.effectiveAt;
          createReqOffset = tx.offset;
          createReqArg = arg;
        } else if (ex.choice === "CBTCWithdrawRequest_CompleteWithdrawal") {
          archivedReqCid = ex.contractId ?? null;
        }
      }

      // Created events — capture the new WithdrawRequest's contractId and fields.
      const cr = (ev as { CreatedTreeEvent?: { value?: CreatedTree } })
        .CreatedTreeEvent?.value;
      if (cr?.templateId?.includes("CBTC.WithdrawRequest:CBTCWithdrawRequest")) {
        newRequestCid = cr.contractId ?? null;
        const a = cr.createArgument ?? {};
        newRequestAmount = (a.amount as string | undefined) ?? null;
        newRequestBtcTxId = (a.btcTxId as string | undefined) ?? null;
        newRequestDestination = (a.destinationBtcAddress as string | undefined) ?? null;
      }
    }

    // Emit request using data from the WithdrawRequest createArgument (reliable)
    // falling back to the choiceArgument (only has btcTxId).
    if (createReqAt !== null && createReqOffset !== null && createReqArg !== null) {
      requests.push({
        at: createReqAt,
        amount: newRequestAmount ?? (createReqArg.amount as string | undefined) ?? null,
        btcTxId: newRequestBtcTxId ?? (createReqArg.btcTxId as string | undefined) ?? null,
        destination: newRequestDestination ?? (createReqArg.destinationBtcAddress as string | undefined) ?? null,
        offset: createReqOffset,
        requestCid: newRequestCid,
      });
    }

    if (archivedReqCid) {
      completedRequestCids.add(archivedReqCid);
    }
  }

  return { burns, requests, completedRequestCids };
}
