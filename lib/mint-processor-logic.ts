/**
 * Pure, side-effect-free decision logic for the mint processor.
 *
 * Kept in a separate module (NO "server-only" import, NO network/DB) so it can
 * be unit-tested directly with Node's built-in test runner. These functions
 * encode the money-critical invariants:
 *   - which created contract is the transfer offer
 *   - how far the cursor may advance
 *   - whether to create a new offer or accept an existing one
 */

function isTransferOfferTemplate(templateId: string): boolean {
  return (
    templateId.includes("TransferOffer") ||
    templateId.includes("TransferInstruction")
  );
}

function eventsByIdFromTreeLike(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.eventsById && typeof v.eventsById === "object") {
    return v.eventsById as Record<string, unknown>;
  }
  const nested = v.transactionTree as { eventsById?: Record<string, unknown> } | undefined;
  if (nested?.eventsById) return nested.eventsById;
  const txn = v.transaction as { eventsById?: Record<string, unknown> } | undefined;
  if (txn?.eventsById) return txn.eventsById;
  return null;
}

/** Normalize Loop wallet / JSON API submit shapes to an eventsById map. */
export function extractEventsByIdFromSubmitResult(
  result: unknown
): Record<string, unknown> | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;

  // Loop SDK submitAndWaitForTransaction → { update_data: transactionTree, update_id }
  const fromUpdateData = eventsByIdFromTreeLike(r.update_data);
  if (fromUpdateData) return fromUpdateData;

  const fromTree = eventsByIdFromTreeLike(r.transactionTree);
  if (fromTree) return fromTree;

  const txn = r.transaction as { eventsById?: Record<string, unknown> } | undefined;
  if (txn?.eventsById) return txn.eventsById;

  const updateTree = (
    r.update as { transactionTree?: { eventsById?: Record<string, unknown> } }
  )?.transactionTree;
  if (updateTree?.eventsById) return updateTree.eventsById;

  const body = r.body as
    | {
        transactionTree?: { eventsById?: Record<string, unknown> };
        transaction?: { eventsById?: Record<string, unknown> };
        update_data?: unknown;
      }
    | undefined;
  if (body) {
    const fromBodyUpdate = eventsByIdFromTreeLike(body.update_data);
    if (fromBodyUpdate) return fromBodyUpdate;
    if (body.transactionTree?.eventsById) return body.transactionTree.eventsById;
    if (body.transaction?.eventsById) return body.transaction.eventsById;
  }
  return null;
}

function scanCreatedOffers(
  eventsById: Record<string, unknown> | undefined | null
): string[] {
  if (!eventsById) return [];
  const out: string[] = [];
  for (const node of Object.values(eventsById)) {
    const n = node as {
      CreatedTreeEvent?: { value?: { contractId?: string; templateId?: string } };
      CreatedEvent?: { contractId?: string; templateId?: string };
    };
    const created = n.CreatedTreeEvent?.value ?? n.CreatedEvent;
    if (!created?.contractId || !created.templateId) continue;
    if (isTransferOfferTemplate(created.templateId)) {
      out.push(created.contractId);
    }
  }
  return out;
}

/**
 * Extract the contractId of the created TransferOffer / TransferInstruction
 * from a Canton v2 transaction-tree `eventsById` map.
 *
 * Returns the first matching contractId, or null if none.
 */
export function extractCreatedOfferCid(
  eventsById: Record<string, unknown> | undefined | null
): string | null {
  const hits = scanCreatedOffers(eventsById);
  return hits[0] ?? null;
}

/**
 * Like extractCreatedOfferCid but returns the *last* matching offer in the tree.
 * Use when multiple TransferInstructions are created (e.g. accept + deliver fill).
 */
export function extractLastCreatedOfferCid(
  eventsById: Record<string, unknown> | undefined | null
): string | null {
  const hits = scanCreatedOffers(eventsById);
  return hits.length ? hits[hits.length - 1]! : null;
}

/**
 * Decide what action to take for a mint given its current DB row state.
 *
 *  - "skip"           — already transferred, or owned by another worker
 *  - "accept-existing"— an offer was already recorded; accept it (NEVER recreate)
 *  - "create"         — no offer yet; create one then accept
 */
export function decideMintAction(row: {
  status?: string | null;
  offerContractId?: string | null;
} | null): "skip" | "accept-existing" | "create" {
  if (row?.status === "transferred") return "skip";
  if (row?.status === "processing") return "skip";
  if (row?.offerContractId) return "accept-existing";
  return "create";
}
