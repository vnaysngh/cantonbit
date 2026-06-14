export const AMULET_HOLDING_TEMPLATE_FQN =
  "a31be0483f3175647053f28965a4e6d97e3dbc433ea2338be303fae69bbcff6a:Splice.Amulet:Amulet";

/** Change outputs from allocate — not the Allocation contract we need. */
export function isPlainChangeOutput(templateId: string): boolean {
  if (templateId === AMULET_HOLDING_TEMPLATE_FQN) return true;
  if (templateId.endsWith(":Amulet")) return true;
  if (templateId.endsWith(":Holding")) return true;
  if (templateId.includes("Holding.V0.Holding:Holding")) return true;
  return false;
}

/** Pick the Allocation contract from submit created events (not Amulet/Holding change). */
export function isAllocationContract(templateId: string): boolean {
  if (!/Allocation/i.test(templateId)) return false;
  if (isPlainChangeOutput(templateId)) return false;
  return true;
}

export function pickAllocationCid(
  created: { contractId: string; templateId: string }[]
): string {
  const alloc = created.find((c) => isAllocationContract(c.templateId));
  if (alloc) return alloc.contractId;
  const fallback = created.find((c) => !isPlainChangeOutput(c.templateId));
  return fallback?.contractId ?? "";
}
