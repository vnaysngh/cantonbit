/**
 * HTLC timelock ladder (T3) — concrete, justified parameters.
 *
 * The two HTLC legs use a STAGGERED timelock:
 *   userTimelock (EVM, the LONGER one)  — user can `retake` WBTC after this.
 *   solverTimelock (Canton, the SHORTER one) — the Canton swap is dead after this.
 *
 * Safety invariant (the one rule that makes the swap non-stealable):
 *   userTimelock - solverTimelock  >  GAP
 *   GAP must dominate: EVM finality + Canton skew_max + execution buffer.
 * So that AFTER the user reveals the preimage on Canton, the solver always has
 * time to claim the WBTC on EVM before the user's EVM lock can be refunded.
 *
 * Concrete numbers (devnet/testnet defaults; tune per network in T16):
 *   - Canton skew_max (ledgerTimeRecordTimeTolerance): ~60s default, bounded &
 *     synchronizer-enforced. Negligible vs. our hour-scale windows.
 *   - EVM finality (Arbitrum/Base L2): soft finality ~seconds; we budget 15 min
 *     to be safe against reorg/RPC lag.
 *   - Execution buffer (read reveal + submit EVM claim + mining): ~15 min.
 *   => GAP = 1 hour (comfortably > 60s + 15m + 15m). Conservative.
 *
 *   - Total window (userTimelock from now): 4 hours (well over Cancore's 2h min).
 *   => solverTimelock = userTimelock - 1h = now + 3h.
 *
 * These satisfy: solverTimelock (3h) < userTimelock (4h), gap (1h) >> skew+finality.
 */

import { buildTimelocks, type Timelocks } from "./htlc-order.js";

export interface TimelockConfig {
  /** Total EVM-leg window from now (seconds). The user can retake after this. */
  totalWindowSeconds: number;
  /** Gap by which the Canton leg expires BEFORE the EVM leg (seconds). Must
   *  exceed EVM finality + Canton skew_max + execution buffer. */
  gapSeconds: number;
}

/** Default ladder — 4h total window, 1h gap. Safe for Arbitrum/Base L2 + Canton. */
export const DEFAULT_TIMELOCK_CONFIG: TimelockConfig = {
  totalWindowSeconds: 4 * 60 * 60, // 4h
  gapSeconds: 60 * 60, // 1h
};

/** Canton synchronizer skew bound (ledgerTimeRecordTimeTolerance), default ~60s.
 *  Documented for the sanity check below; the real ledger value can be read by a
 *  node operator via the Canton console (set_dynamic_domain_parameters) if it was
 *  ever changed from the default. Our 1h gap dominates any plausible value. */
export const CANTON_SKEW_MAX_SECONDS = 60;

/** Budgeted EVM L2 finality margin (Arbitrum/Base). Conservative. */
export const EVM_FINALITY_SECONDS = 15 * 60;

/** Build the staggered timelocks for a swap, asserting the safety invariant. */
export function htlcTimelocks(
  nowSeconds: number,
  cfg: TimelockConfig = DEFAULT_TIMELOCK_CONFIG,
): Timelocks {
  const minGap = CANTON_SKEW_MAX_SECONDS + EVM_FINALITY_SECONDS + 5 * 60; // + 5m buffer
  if (cfg.gapSeconds < minGap) {
    throw new Error(
      `timelock gap ${cfg.gapSeconds}s is too small: must exceed skew_max + EVM finality + buffer (${minGap}s)`,
    );
  }
  return buildTimelocks(nowSeconds, cfg.totalWindowSeconds, cfg.gapSeconds);
}
