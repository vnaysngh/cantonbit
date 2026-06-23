import { ACS_QUERY_BATCH_LIMIT, isAcsLimitError } from "./ledger";

/** Plan/swap errors that mean UTXO merge should run before retrying. */
export function needsUtxoConsolidation(err: unknown): boolean {
  if (isAcsLimitError(err)) return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("utxo cap") ||
    msg.includes("utxo at cap") ||
    msg.includes("maximum_list_elements")
  );
}

/** countHoldings sentinel when ACS list is over the node cap. */
export function isUtxoOverAcsCap(count: number): boolean {
  return count >= ACS_QUERY_BATCH_LIMIT;
}
