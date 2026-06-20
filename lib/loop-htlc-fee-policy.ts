/**
 * Oranj CC network fee policy for Loop HTLC swaps.
 * Loop wallet Canton traffic is billed by Loop on sign — we only collect Oranj
 * network fee on forward HTLC (WBTC→CBTC) before claim/accept.
 */
export function loopHtlcCollectsOranjNetworkFee(
  direction: "evm-to-canton" | "canton-to-evm"
): boolean {
  return direction === "evm-to-canton";
}
