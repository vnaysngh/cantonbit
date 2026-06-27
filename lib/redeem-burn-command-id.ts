import { createHash } from "node:crypto";

/** Deterministic Canton commandId so burn retries dedupe instead of double-burning. */
export function burnWithdrawCommandId(params: {
  partyId: string;
  withdrawAccountContractId: string;
  holdingCids: readonly string[];
  amount: string;
}): string {
  const material = [
    params.partyId,
    params.withdrawAccountContractId,
    [...params.holdingCids].sort().join(","),
    params.amount.trim()
  ].join("|");
  return `cbtc-burn-${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}
