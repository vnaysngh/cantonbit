/**
 * Pure helpers for Loop reverse-seller custody matching (CBTC user → solver).
 * Keeps order-specific memo matching strict and prevents reusing custody CIDs.
 */

export function collectUsedLoopCustodyCids(
  orders: ReadonlyArray<{ id: string; counterTransferOfferCid?: string }>,
  excludeOrderId?: string
): Set<string> {
  const used = new Set<string>();
  for (const order of orders) {
    if (excludeOrderId && order.id === excludeOrderId) continue;
    if (order.counterTransferOfferCid) used.add(order.counterTransferOfferCid);
  }
  return used;
}

export function isCustodyEvidenceConflictError(cause: unknown): boolean {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return /duplicate key|unique constraint|htlc_orders_counter_transfer_evidence_uidx/i.test(
    msg
  );
}

export function isSafeReversePrelockReleaseCause(cause: unknown): boolean {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return (
    /transfer offer not visible on-ledger yet/i.test(msg) ||
    /loop custody transfer is not visible on-ledger yet/i.test(msg) ||
    /no input holdings available/i.test(msg) ||
    /insufficient cbtc/i.test(msg) ||
    /insufficient holdings/i.test(msg) ||
    /ambiguous loop custody/i.test(msg) ||
    /duplicate key|unique constraint|htlc_orders_counter_transfer_evidence_uidx/i.test(
      msg
    )
  );
}
