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
  offset?: number;
  eventsById?: Record<string, unknown>;
};

function unwrapTransactionTree(item: unknown): TransactionTreeValue | null {
  if (!item || typeof item !== "object") return null;
  const u = item as {
    offset?: number;
    update?: {
      offset?: number;
      TransactionTree?: { value?: TransactionTreeValue };
      transactionTree?: TransactionTreeValue;
    };
  };
  const tree =
    u.update?.TransactionTree?.value ??
    u.update?.transactionTree ??
    null;
  if (!tree) return null;
  return {
    ...tree,
    offset: tree.offset ?? u.update?.offset ?? u.offset
  };
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

/** Ledger scan offset — omit when missing or non-positive (never substitute ledger end). */
export function scanOffsetFromRecovery(raw: unknown): number | undefined {
  const n = Number(raw ?? 0);
  return n > 0 ? n : undefined;
}

async function scanPartyUpdateTrees(
  partyId: string,
  range: { lookback?: number; beginExclusive?: number },
  match: (tree: TransactionTreeValue) => boolean
): Promise<{
  updateId: string;
  offset?: number;
  eventsById: Record<string, unknown>;
} | null> {
  const jwt = await getLedgerJwt();
  const endRes = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${jwt}` },
    cache: "no-store"
  });
  if (!endRes.ok) {
    const message = `${TAG} ledger-end failed (${endRes.status})`;
    if (range.beginExclusive !== undefined) throw new Error(message);
    console.warn(message);
    return null;
  }
  const { offset: endInclusive } = (await endRes.json()) as { offset: number };
  const beginExclusive =
    range.beginExclusive ?? Math.max(0, endInclusive - (range.lookback ?? DEFAULT_LOOKBACK));

  const requireCompleteScan = range.beginExclusive !== undefined;
  let cursor = beginExclusive;
  let lastSeenOffset = beginExclusive;

  while (cursor < endInclusive) {
    const res = await fetch(`${NETWORK.ledgerHost}/v2/updates/trees`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`
      },
      body: JSON.stringify({
        beginExclusive: cursor,
        endInclusive,
        filter: {
          filtersByParty: {
            [partyId]: {
              cumulative: [
                {
                  identifierFilter: {
                    WildcardFilter: { value: { includeCreatedEventBlob: true } }
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
      const message =
        `${TAG} updates/trees failed (${res.status}) ` +
        `party=${partyId.slice(0, 20)}…`;
      if (requireCompleteScan) throw new Error(message);
      console.warn(message);
      return null;
    }

    const raw = (await res.json()) as unknown;
    const items = Array.isArray(raw)
      ? raw
      : ((raw as { updates?: unknown[] }).updates ?? []);

    if (items.length === 0) {
      // Party has no further updates in [cursor, endInclusive] — range exhausted.
      break;
    }

    for (let i = items.length - 1; i >= 0; i--) {
      const tree = unwrapTransactionTree(items[i]);
      if (!tree || !tree.updateId) continue;
      const treeOffset = scanOffsetFromRecovery(tree.offset);
      if (treeOffset !== undefined) {
        lastSeenOffset = Math.max(lastSeenOffset, treeOffset);
      }
      if (!match(tree)) continue;
      return {
        updateId: tree.updateId,
        ...(treeOffset !== undefined ? { offset: treeOffset } : {}),
        eventsById: eventsFromTree(tree)
      };
    }

    if (lastSeenOffset <= cursor) break;
    cursor = lastSeenOffset;
  }

  // Strict mode throws only on HTTP failures above. Do NOT compare lastSeenOffset
  // to global ledger-end — on a shared participant node the party is virtually
  // always behind ledger-end even after a complete scan (empty page = exhausted).

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
): Promise<{
  updateId: string;
  offset?: number;
  eventsById: Record<string, unknown>;
} | null> {
  return scanPartyUpdateTrees(partyId, { lookback }, (tree) => tree.commandId === commandId);
}

/**
 * Loop submit update ids are not readable via GET /v2/updates/update/{id} on
 * WarpX devnet — scan recent party update trees instead.
 */
export async function fetchTransactionTreeByUpdateId(
  updateId: string,
  partyIds: string[],
  lookback = DEFAULT_LOOKBACK
): Promise<{
  updateId: string;
  offset?: number;
  eventsById: Record<string, unknown>;
} | null> {
  for (const partyId of partyIds) {
    if (!partyId) continue;
    const hit = await scanPartyUpdateTrees(partyId, { lookback }, (tree) => tree.updateId === updateId);
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
): Promise<{
  updateId: string;
  offset?: number;
  eventsById: Record<string, unknown>;
} | null> {
  return scanPartyUpdateTrees(partyId, { lookback }, (tree) =>
    matchEvents(eventsFromTree(tree), offerCid)
  );
}

/**
 * Strict offer-accept scan from the offer's persisted creation offset.
 * Infrastructure failures throw; "not found" means the complete ledger range was
 * successfully searched, so callers may safely consider reissue.
 */
export async function fetchOfferAcceptFromOffset(
  offerCid: string,
  partyId: string,
  beginExclusive: number,
  matchEvents: (
    eventsById: Record<string, unknown>,
    offerCid: string
  ) => boolean
): Promise<{
  updateId: string;
  offset?: number;
  eventsById: Record<string, unknown>;
} | null> {
  return scanPartyUpdateTrees(partyId, { beginExclusive }, (tree) =>
    matchEvents(eventsFromTree(tree), offerCid)
  );
}
