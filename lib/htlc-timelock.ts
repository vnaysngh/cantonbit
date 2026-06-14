/**
 * Timelock ladder from order expiration (R6) — Cancore params, app-side.
 *
 * Cancore (docs §8): expiration dropdown 30min/1h/2h/4h/8h/24h/48h/72h; min 2h for
 * Canton swaps; maker (user/EVM) timelock >= order expiration, taker (solver/Canton)
 * shorter. The gap (user - solver) must dominate Canton skew + EVM finality + buffer.
 *
 * userTimelock  = now + expiration              (EVM, longer — user retakes after this)
 * solverTimelock = userTimelock - GAP           (Canton, shorter — dead after this)
 */

/** Canton synchronizer skew bound (~60s default) — our gap dominates it. */
const CANTON_SKEW_MAX_SECONDS = 60;
/** Budgeted EVM L2 finality margin (Arbitrum/Base), conservative. */
const EVM_FINALITY_SECONDS = 15 * 60;
/** Execution buffer (read reveal + submit EVM claim + mine). */
const EXEC_BUFFER_SECONDS = 5 * 60;
/** The minimum safe gap between the two legs (EVM↔Canton — includes EVM finality). */
export const MIN_GAP =
  CANTON_SKEW_MAX_SECONDS + EVM_FINALITY_SECONDS + EXEC_BUFFER_SECONDS; // ~20m
/** Same-Canton swaps — no EVM finality budget. */
export const MIN_GAP_CANTON =
  CANTON_SKEW_MAX_SECONDS + EXEC_BUFFER_SECONDS; // ~6m
/** Default gap — 1h, comfortably > MIN_GAP. */
const DEFAULT_GAP = 60 * 60;

/** Cancore's expiration options (seconds). Min 2h for Canton swaps. */
export const EXPIRATION_OPTIONS = [
  { label: "30 min", seconds: 30 * 60 },
  { label: "1 hour", seconds: 60 * 60 },
  { label: "2 hours", seconds: 2 * 60 * 60 },
  { label: "4 hours", seconds: 4 * 60 * 60 },
  { label: "8 hours", seconds: 8 * 60 * 60 },
  { label: "24 hours", seconds: 24 * 60 * 60 },
  { label: "48 hours", seconds: 48 * 60 * 60 },
  { label: "72 hours", seconds: 72 * 60 * 60 }
] as const;

/** Min expiration for a Canton swap (Cancore: ensures maker timelock > taker). */
export const MIN_CANTON_EXPIRATION_SECONDS = 2 * 60 * 60; // 2h
export const DEFAULT_EXPIRATION_SECONDS = 4 * 60 * 60; // 4h (Cancore-style default)

export interface Timelocks {
  userTimelock: number; // EVM unlock (unix seconds), the longer leg
  solverTimelock: number; // Canton unlock (unix seconds), the shorter leg
}

/**
 * SERVER-SIDE ladder validation (SECURITY — never trust the client's timelocks).
 * The party who reveals the secret SECOND must have the longer window. By
 * construction userTimelock is the LONGER leg in both directions:
 *   evm-to-canton: userTimelock = EVM (user retakes WBTC); solverTimelock = Canton.
 *   canton-to-evm: userTimelock = Canton (user's CBTC HtlcLock); solverTimelock = EVM.
 * Throws if the ladder is inverted, the gap is too small, or either leg is in the
 * past / unreasonably far out. A hostile client that skips timelocksFromExpiration
 * (or inverts the legs) is rejected here.
 */
export function assertValidTimelocks(
  nowSeconds: number,
  userTimelock: number,
  solverTimelock: number,
  minGap: number = MIN_GAP
): void {
  if (!Number.isFinite(userTimelock) || !Number.isFinite(solverTimelock)) {
    throw new Error("timelocks must be finite unix seconds");
  }
  if (solverTimelock <= nowSeconds + 60) {
    throw new Error("solverTimelock is in the past / too soon");
  }
  if (userTimelock - solverTimelock < minGap) {
    throw new Error(
      `timelock ladder invalid: userTimelock must exceed solverTimelock by at least ${minGap}s (got ${userTimelock - solverTimelock}s)`
    );
  }
  // Sanity upper bound — reject absurd far-future locks (≤ 7 days).
  if (userTimelock > nowSeconds + 7 * 24 * 60 * 60) {
    throw new Error("userTimelock is unreasonably far in the future");
  }
}

/**
 * Derive the staggered timelocks from a chosen expiration (for a Canton swap).
 * Enforces: expiration >= 2h, and the gap dominates skew + finality + buffer.
 */
export function timelocksFromExpiration(
  nowSeconds: number,
  expirationSeconds: number
): Timelocks {
  if (expirationSeconds < MIN_CANTON_EXPIRATION_SECONDS) {
    throw new Error(
      `expiration too short — Canton swaps need at least ${MIN_CANTON_EXPIRATION_SECONDS / 3600}h`
    );
  }
  // Scale the gap down for short expirations so the Canton leg stays positive, but
  // never below MIN_GAP. For a 2h expiration → 1h gap leaves a 1h Canton window.
  const gap = Math.max(
    MIN_GAP,
    Math.min(DEFAULT_GAP, Math.floor(expirationSeconds / 4))
  );
  const userTimelock = nowSeconds + expirationSeconds;
  const solverTimelock = userTimelock - gap;
  if (solverTimelock <= nowSeconds) {
    throw new Error(
      "derived solverTimelock is in the past — expiration/gap misconfigured"
    );
  }
  return { userTimelock, solverTimelock };
}

/** Derive timelocks for same-Canton swaps (no EVM finality in the gap). */
export function timelocksFromExpirationCanton(
  nowSeconds: number,
  expirationSeconds: number
): Timelocks {
  if (expirationSeconds < MIN_CANTON_EXPIRATION_SECONDS) {
    throw new Error(
      `expiration too short — Canton swaps need at least ${MIN_CANTON_EXPIRATION_SECONDS / 3600}h`
    );
  }
  const gap = Math.max(
    MIN_GAP_CANTON,
    Math.min(DEFAULT_GAP, Math.floor(expirationSeconds / 4))
  );
  const userTimelock = nowSeconds + expirationSeconds;
  const solverTimelock = userTimelock - gap;
  if (solverTimelock <= nowSeconds) {
    throw new Error(
      "derived solverTimelock is in the past — expiration/gap misconfigured"
    );
  }
  return { userTimelock, solverTimelock };
}
