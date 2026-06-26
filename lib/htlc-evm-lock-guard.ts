/**
 * Pure EVM HTLC lock checks used before CBTC reveal (Loop claim-counter + managed
 * claim-managed). Shared so both paths and unit tests use identical solver-robbery
 * guards without duplicating margin logic.
 */

/** Min seconds the solver needs left on the EVM lock to safely claim after a reveal. */
export const EVM_CLAIM_MARGIN_SECONDS = 10 * 60;

/** Allowed skew when binding on-chain unlockTime to the order userTimelock (M-7). */
export const EVM_TIMELOCK_BIND_TOLERANCE_SECONDS = 120;

export type EvmLockSnapshot = {
  unlockTime: number;
  amount: bigint;
  tokenAddress: string;
  receiver: string;
};

export type EvmLockRevealRequirements = {
  wbtcAmount: string;
  solverEvmAddress: string;
  expectedWbtcAddress: string;
  /** When set, lock.unlockTime must match the order timelock within tolerance. */
  expectedUserTimelock?: number;
};

/**
 * Throws if the on-chain EVM lock is missing, under-funded, wrong receiver, or
 * too close to expiry for the solver to claim WBTC after reveal.
 */
export function assertEvmLockSafeForReveal(
  lock: EvmLockSnapshot,
  req: EvmLockRevealRequirements,
  nowSec = Math.floor(Date.now() / 1000)
): void {
  if (lock.amount === 0n) {
    throw new Error(
      "EVM lock not found — WBTC is not locked under this hashLock"
    );
  }
  const expectedToken = req.expectedWbtcAddress.toLowerCase();
  if (lock.tokenAddress !== expectedToken) {
    throw new Error("EVM lock token is not canonical WBTC");
  }
  if (lock.amount < BigInt(req.wbtcAmount)) {
    throw new Error(
      `EVM lock amount too small (${lock.amount} < ${req.wbtcAmount})`
    );
  }
  if (lock.receiver !== req.solverEvmAddress.toLowerCase()) {
    throw new Error("EVM lock receiver is not the solver");
  }
  if (req.expectedUserTimelock != null) {
    const skew = Math.abs(lock.unlockTime - req.expectedUserTimelock);
    if (skew > EVM_TIMELOCK_BIND_TOLERANCE_SECONDS) {
      throw new Error("EVM lock unlockTime does not match order userTimelock");
    }
  }
  if (lock.unlockTime - nowSec < EVM_CLAIM_MARGIN_SECONDS) {
    throw new Error("EVM lock expires too soon for the solver to claim safely");
  }
}
