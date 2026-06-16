import { NETWORK } from "../../../lib/constants";

function unwrapTree(item: unknown): {
  updateId?: string;
  recordTime?: string;
  eventsById?: Record<string, unknown>;
} | null {
  const u = item as {
    update?: { TransactionTree?: { value?: unknown } };
    transactionTree?: unknown;
  };
  const tree =
    u?.update?.TransactionTree?.value ?? u?.transactionTree ?? null;
  return tree as {
    updateId?: string;
    recordTime?: string;
    eventsById?: Record<string, unknown>;
  } | null;
}

export function eventsFromTree(tree: {
  eventsById?: Record<string, unknown>;
}): Record<string, unknown> {
  return tree.eventsById ?? {};
}

/** Locate a transaction tree by update id across hosted parties. */
export async function fetchTransactionTreeByUpdateId(
  jwt: string,
  updateId: string,
  partyIds: string[],
  lookback = 8000
): Promise<{ updateId: string; eventsById: Record<string, unknown> } | null> {
  const endRes = await fetch(`${NETWORK.ledgerHost}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${jwt}` },
    cache: "no-store"
  });
  if (!endRes.ok) return null;
  const { offset } = (await endRes.json()) as { offset: number };
  const beginExclusive = Math.max(0, offset - lookback);

  for (const party of partyIds) {
    if (!party) continue;
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
            [party]: {
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
        verbose: true
      }),
      cache: "no-store"
    });
    if (!res.ok) continue;
    const raw = (await res.json()) as unknown;
    const items = Array.isArray(raw)
      ? raw
      : ((raw as { updates?: unknown[] }).updates ?? []);
    for (const item of items) {
      const tree = unwrapTree(item);
      if (tree?.updateId === updateId && tree.eventsById) {
        return { updateId: tree.updateId, eventsById: tree.eventsById };
      }
    }
  }
  return null;
}

export function treeJsonBytes(tree: { eventsById?: Record<string, unknown> }): number {
  return Buffer.byteLength(JSON.stringify(tree), "utf8");
}
