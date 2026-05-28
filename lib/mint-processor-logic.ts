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

/**
 * Extract the contractId of the created TransferOffer / TransferInstruction
 * from a Canton v2 transaction-tree `eventsById` map.
 *
 * `eventsById` is keyed by nodeId; each value is one of:
 *   { CreatedTreeEvent: { value: { contractId, templateId, ... } } }
 *   { ExercisedTreeEvent: { value: { ... } } }
 * Some Canton builds also surface a flat `CreatedEvent`. We scan for any
 * created event whose templateId names a transfer offer / instruction.
 *
 * Returns the first matching contractId, or null if none.
 */
export function extractCreatedOfferCid(
  eventsById: Record<string, unknown> | undefined | null,
): string | null {
  if (!eventsById) return null;
  for (const node of Object.values(eventsById)) {
    const n = node as {
      CreatedTreeEvent?: { value?: { contractId?: string; templateId?: string } };
      CreatedEvent?: { contractId?: string; templateId?: string };
    };
    const created = n.CreatedTreeEvent?.value ?? n.CreatedEvent;
    if (!created?.contractId || !created.templateId) continue;
    if (
      created.templateId.includes("TransferOffer") ||
      created.templateId.includes("TransferInstruction")
    ) {
      return created.contractId;
    }
  }
  return null;
}

/**
 * Decide what action to take for a mint given its current DB row state.
 *
 *  - "skip"           — already transferred, or owned by another worker
 *  - "accept-existing"— an offer was already recorded; accept it (NEVER recreate)
 *  - "create"         — no offer yet; create one then accept
 *
 * This is the core duplicate-offer guard, expressed as pure logic so it can be
 * exhaustively tested.
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
