/**
 * cBTC transfer flow — send and accept TransferInstructions.
 *
 * NOTE: The Loop SDK has been removed from this app. Send/accept flows
 * were previously implemented via provider.transfer() and
 * provider.submitTransaction(). These are no longer available.
 *
 * The Send page is currently mocked. A server-side m2m JWT implementation
 * can replace these functions when DARs are fully uploaded to the WarpX node.
 */

export interface TransferResult {
  /** The Canton update ID from the completed transaction. */
  updateId: string | null;
}

/**
 * Send cBTC to another Canton party.
 *
 * TODO(real-transfer): Implement via server-side m2m JWT once DARs are uploaded.
 */
export async function sendCbtc(
  _recipient: string,
  _amount: string,
): Promise<TransferResult> {
  throw new Error(
    "sendCbtc: not yet implemented without Loop SDK. Use the server-side m2m JWT route instead.",
  );
}

/**
 * Accept an incoming TransferInstruction (receiver side).
 *
 * TODO(real-transfer): Implement via server-side m2m JWT once DARs are uploaded.
 */
export async function acceptTransfer(
  _userParty: string,
  _transferInstructionCid: string,
): Promise<TransferResult> {
  throw new Error(
    "acceptTransfer: not yet implemented without Loop SDK. Use the server-side m2m JWT route instead.",
  );
}
