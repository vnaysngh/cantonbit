/**
 * redeem-ledger — server-only reads of the on-ledger CBTCWithdrawRequest.
 *
 * Shared by /api/redeem/status (live single-shot) and /api/redeem/sync
 * (DB status updater). Reading is idempotent: we only ever observe the
 * attestor-created request to learn its btcTxId — we never submit anything.
 */

import "server-only";

import { getLedgerJwt, invalidateLedgerJwtCache } from "@/lib/auth";
import { NETWORK } from "@/lib/constants";

const WITHDRAW_REQUEST_TEMPLATE_ID =
  "#cbtc:CBTC.WithdrawRequest:CBTCWithdrawRequest";

export interface OnLedgerWithdrawRequest {
  contractId: string;
  btcTxId: string | null;
  amount: string | null;
  destinationBtcAddress: string | null;
}

interface CreatedEvent {
  contractId?: string;
  templateId?: string;
  createArgument?: Record<string, unknown>;
}

/**
 * Find the active CBTCWithdrawRequest for a party + destination address.
 * Returns null if the attestor hasn't created one (or it already completed
 * and was archived). Handles JWT refresh on 401.
 */
export async function findWithdrawRequest(
  partyId: string,
  destinationBtcAddress: string,
): Promise<OnLedgerWithdrawRequest | null> {
  const query = async (token: string) => {
    const endRes = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (endRes.status === 401) return { status: 401 as const };
    if (!endRes.ok) throw new Error(`getLedgerEnd failed (${endRes.status})`);
    const { offset } = (await endRes.json()) as { offset?: number };

    const res = await fetch(`${NETWORK.ledgerHost}/v2/state/active-contracts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        filter: {
          filtersByParty: {
            [partyId]: {
              cumulative: [
                {
                  identifierFilter: {
                    TemplateFilter: {
                      value: {
                        templateId: WITHDRAW_REQUEST_TEMPLATE_ID,
                        includeCreatedEventBlob: false,
                      },
                    },
                  },
                },
              ],
            },
          },
        },
        verbose: true,
        activeAtOffset: offset ?? 0,
      }),
      cache: "no-store",
    });
    if (res.status === 401) return { status: 401 as const };
    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      throw new Error(`active-contracts failed (${res.status}): ${text}`);
    }
    const raw = (await res.json()) as unknown;
    return { status: 200 as const, entries: Array.isArray(raw) ? raw : [] };
  };

  let jwt = await getLedgerJwt();
  let result = await query(jwt);
  if (result.status === 401) {
    invalidateLedgerJwtCache();
    jwt = await getLedgerJwt();
    result = await query(jwt);
    if (result.status === 401) {
      throw new Error("Authentication failed — JWT invalid after refresh");
    }
  }

  let match: CreatedEvent | null = null;
  for (const entry of result.entries ?? []) {
    const e = entry as {
      contractEntry?: { JsActiveContract?: { createdEvent?: CreatedEvent } };
      JsActiveContract?: { createdEvent?: CreatedEvent };
    };
    const ev =
      e.contractEntry?.JsActiveContract?.createdEvent ??
      e.JsActiveContract?.createdEvent;
    if (!ev?.contractId) continue;
    const addr = ev.createArgument?.destinationBtcAddress as string | undefined;
    if (addr && addr !== destinationBtcAddress) continue;
    match = ev; // keep newest match
  }

  if (!match) return null;
  return {
    contractId: match.contractId!,
    btcTxId: (match.createArgument?.btcTxId as string | undefined) ?? null,
    amount: (match.createArgument?.amount as string | undefined) ?? null,
    destinationBtcAddress:
      (match.createArgument?.destinationBtcAddress as string | undefined) ??
      null,
  };
}

/**
 * Check whether any CBTCWithdrawRequest for this party+destination was
 * completed (CBTCWithdrawRequest_CompleteWithdrawal exercised). This is the
 * canonical "BTC was sent" signal — BitSafe may broadcast a different txid
 * than what's on the request, so we can't rely on mempool lookups alone.
 *
 * Scans the recent updates stream (last ~500 updates) for CompleteWithdrawal
 * exercises on requests matching the destination address.
 */
export async function wasWithdrawRequestCompleted(
  partyId: string,
  destinationBtcAddress: string,
): Promise<{ completed: boolean; btcTxId: string | null }> {
  const jwt = await getLedgerJwt();

  const res = await fetch(`${NETWORK.ledgerHost}/v2/updates/trees`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({
      filter: {
        filtersByParty: {
          [partyId]: {
            cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }],
          },
        },
      },
      verbose: true,
      beginExclusive: 0,
    }),
    cache: "no-store",
  });

  if (!res.ok) return { completed: false, btcTxId: null };

  const arr = (await res.json()) as unknown[];
  if (!Array.isArray(arr)) return { completed: false, btcTxId: null };

  // Build a map of requestCid → btcTxId from created WithdrawRequests,
  // then check which ones had CompleteWithdrawal exercised.
  const requestTxIds = new Map<string, string | null>();
  const completedCids = new Set<string>();

  for (const item of arr) {
    const tx = (item as { update?: { TransactionTree?: { value?: { eventsById?: Record<string, unknown> } } } })
      .update?.TransactionTree?.value;
    if (!tx?.eventsById) continue;

    for (const ev of Object.values(tx.eventsById)) {
      const created = (ev as { CreatedTreeEvent?: { value?: { templateId?: string; contractId?: string; createArgument?: Record<string, unknown> } } }).CreatedTreeEvent?.value;
      const exercised = (ev as { ExercisedTreeEvent?: { value?: { templateId?: string; contractId?: string; choice?: string } } }).ExercisedTreeEvent?.value;

      if (created?.templateId?.includes("WithdrawRequest") && created.contractId) {
        const dest = created.createArgument?.destinationBtcAddress as string | undefined;
        if (dest === destinationBtcAddress) {
          requestTxIds.set(created.contractId, (created.createArgument?.btcTxId as string | undefined) ?? null);
        }
      }

      if (exercised?.choice === "CBTCWithdrawRequest_CompleteWithdrawal" && exercised.contractId) {
        completedCids.add(exercised.contractId);
      }
    }
  }

  for (const [cid, txId] of requestTxIds) {
    if (completedCids.has(cid)) {
      return { completed: true, btcTxId: txId };
    }
  }

  return { completed: false, btcTxId: null };
}

/**
 * Is a Bitcoin txid visible on-chain (confirmed or in mempool)? Server-side
 * mempool.space lookup. Returns { found, confirmed } — devnet has no explorer
 * so always { found:false }.
 */
export async function bitcoinTxOnChain(
  btcTxId: string,
): Promise<{ found: boolean; confirmed: boolean }> {
  const base =
    NETWORK.name === "mainnet"
      ? "https://mempool.space/api"
      : NETWORK.name === "testnet"
        ? "https://mempool.space/testnet/api"
        : null;
  if (!base) return { found: false, confirmed: false };

  try {
    const res = await fetch(`${base}/tx/${encodeURIComponent(btcTxId)}`, {
      cache: "no-store",
    });
    if (res.status === 404) return { found: false, confirmed: false };
    if (!res.ok) return { found: false, confirmed: false };
    const data = (await res.json()) as { status?: { confirmed?: boolean } };
    return { found: true, confirmed: data.status?.confirmed ?? false };
  } catch {
    return { found: false, confirmed: false };
  }
}
