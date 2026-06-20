/** Poll until an EVM tx is mined and succeeded. Shared by the wallet hook and HTLC client. */

export type Eip1193Like = {
  request: (args: {
    method: string;
    params?: unknown[] | object;
  }) => Promise<unknown>;
};

export function getBrowserEvmProvider(): Eip1193Like | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { ethereum?: Eip1193Like }).ethereum ?? null;
}

/**
 * Wait for a tx hash to be MINED and succeed.
 * eth_sendTransaction returns immediately (pre-mining); callers must await this
 * before any API that verifies the on-chain receipt (recordClaim / recordRetake).
 */
export async function waitForEvmReceipt(
  provider: Eip1193Like,
  hash: string,
  opts?: { timeoutMs?: number; pollMs?: number }
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 90_000;
  const pollMs = opts?.pollMs ?? 2_500;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const receipt = (await provider.request({
      method: "eth_getTransactionReceipt",
      params: [hash]
    })) as { status?: string } | null;
    if (receipt) {
      if (receipt.status === "0x0") {
        throw new Error(
          `transaction reverted on-chain (${hash.slice(0, 12)}…)`
        );
      }
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for transaction to confirm (${hash.slice(0, 12)}…) — it may still land; check Orders`
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
