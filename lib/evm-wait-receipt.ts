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

/** The tx mined but reverted — it did NOT take effect; safe to treat as not-sent. */
export class EvmTxRevertedError extends Error {
  constructor(hash: string) {
    super(`transaction reverted on-chain (${hash.slice(0, 12)}…)`);
    this.name = "EvmTxRevertedError";
  }
}

/** Receipt not seen before the deadline — the tx MAY STILL LAND. Callers must NOT
 *  treat this as not-sent (e.g. must not strand a lock that could still confirm). */
export class EvmReceiptTimeoutError extends Error {
  constructor(hash: string) {
    super(
      `timed out waiting for transaction to confirm (${hash.slice(0, 12)}…) — it may still land; check Orders`
    );
    this.name = "EvmReceiptTimeoutError";
  }
}

export type EvmReceiptState = "pending" | "success" | "reverted";

/** One-shot receipt probe used by durable recovery loops. */
export async function getEvmReceiptState(
  provider: Eip1193Like,
  hash: string
): Promise<EvmReceiptState> {
  const receipt = (await provider.request({
    method: "eth_getTransactionReceipt",
    params: [hash]
  })) as { status?: string } | null;
  if (!receipt) return "pending";
  return receipt.status === "0x0" ? "reverted" : "success";
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
    const state = await getEvmReceiptState(provider, hash);
    if (state === "reverted") throw new EvmTxRevertedError(hash);
    if (state === "success") return;
    if (Date.now() > deadline) {
      throw new EvmReceiptTimeoutError(hash);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
