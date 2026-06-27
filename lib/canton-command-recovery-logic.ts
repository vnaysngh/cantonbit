/**
 * Pure helpers for party update-tree scan completeness (unit-testable).
 */

/**
 * After paginating `/v2/updates/trees` for one party, an empty page means the
 * party has no further updates in `[cursor, endInclusive]` — scan is complete
 * even when the party's last offset is below global ledger-end (normal on shared nodes).
 */
export function isPartyUpdateScanComplete(emptyPage: boolean): boolean {
  return emptyPage;
}
