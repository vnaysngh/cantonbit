import "server-only";

import { getLedgerJwt } from "./auth";
import { NETWORK } from "./constants";
import { extractEventsByIdFromSubmitResult } from "./mint-processor-logic";

const TAG = "[canton-command-recovery]";

/** Default ACS/updates lookback when resolving a committed commandId. */
const DEFAULT_LOOKBACK = 10_000;

type TransactionTreeValue = {
  updateId?: string;
  commandId?: string;
  eventsById?: Record<string, unknown>;
};

function unwrapTransactionTree(item: unknown): TransactionTreeValue | null {
  if (!item || typeof item !== "object") return null;
  const u = item as {
    update?: {
      TransactionTree?: { value?: TransactionTreeValue };
      transactionTree?: TransactionTreeValue;
    };
  };
  return (
    u.update?.TransactionTree?.value ??
    u.update?.transactionTree ??
    null
  );
}

function eventsFromTree(
  tree: TransactionTreeValue
): Record<string, unknown> {
  return (
    tree.eventsById ??
    extractEventsByIdFromSubmitResult(tree) ??
    {}
  );
}

async function scanPartyUpdateTrees(
  partyId: string,
  lookback: number,
  match: (tree: TransactionTreeValue) => boolean
): Promise<{ updateId: string; eventsById: Record<string, unknown> } | null> {
  const jwt = await getLedgerJwt();
  const endRes = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${jwt}` },
    cache: "no-store"
  });
  if (!endRes.ok) {
    console.warn(`${TAG} ledger-end failed (${endRes.status})`);
    return null;
  }
  const { offset } = (await endRes.json()) as { offset: number };
  const beginExclusive = Math.max(0, offset - lookback);

  const res = await fetch(`${NETWORK.ledgerHost}/v2/updates/trees`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`
    },
    body: JSON.stringify({
      beginExclusive,
      endInclusive: offset,
      filter: {
        filtersByParty: {
          [partyId]: {
            cumulative: [
              {
                identifierFilter: {
                  WildcardFilter: { value: { includeCreatedEventBlob: false } }
                }
              }
            ]
          }
        }
      },
      verbose: false
    }),
    cache: "no-store"
  });

  if (!res.ok) {
    console.warn(`${TAG} updates/trees failed (${res.status}) party=${partyId.slice(0, 20)}…`);
    return null;
  }

  const raw = (await res.json()) as unknown;
  const items = Array.isArray(raw)
    ? raw
    : ((raw as { updates?: unknown[] }).updates ?? []);

  for (let i = items.length - 1; i >= 0; i--) {
    const tree = unwrapTransactionTree(items[i]);
    if (!tree || !tree.updateId || !match(tree)) continue;
    return { updateId: tree.updateId, eventsById: eventsFromTree(tree) };
  }

  return null;
}

/**
 * Recover a committed transaction tree by deterministic commandId.
 * Used after DUPLICATE_COMMAND when DB lost the first submit response.
 */
export async function fetchTransactionTreeByCommandId(
  commandId: string,
  partyId: string,
  lookback = DEFAULT_LOOKBACK
): Promise<{ updateId: string; eventsById: Record<string, unknown> } | null> {
  return scanPartyUpdateTrees(
    partyId,
    lookback,
    (tree) => tree.commandId === commandId
  );
}

/**
 * Loop submit update ids are not readable via GET /v2/updates/update/{id} on
 * WarpX devnet — scan recent party update trees instead.
 */
export async function fetchTransactionTreeByUpdateId(
  updateId: string,
  partyIds: string[],
  lookback = DEFAULT_LOOKBACK
): Promise<{ updateId: string; eventsById: Record<string, unknown> } | null> {
  for (const partyId of partyIds) {
    if (!partyId) continue;
    const hit = await scanPartyUpdateTrees(
      partyId,
      lookback,
      (tree) => tree.updateId === updateId
    );
    if (hit) return hit;
  }
  return null;
}

/** Scan party updates for a TransferInstruction Accept that consumed an offer. */
export async function fetchTransactionTreeForOfferAccept(
  offerCid: string,
  partyId: string,
  matchEvents: (
    eventsById: Record<string, unknown>,
    offerCid: string
  ) => boolean,
  lookback = DEFAULT_LOOKBACK
): Promise<{ updateId: string; eventsById: Record<string, unknown> } | null> {
  return scanPartyUpdateTrees(partyId, lookback, (tree) =>
    matchEvents(eventsFromTree(tree), offerCid)
  );
}
