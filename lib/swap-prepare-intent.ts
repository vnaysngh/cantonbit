/** Max age of a prepare→commit intent (Loop sign window). */
export const PREPARE_INTENT_TTL_SECONDS = 30 * 60;

/** Allow small client/server clock skew when validating prepare timestamps. */
export const PREPARE_INTENT_MAX_CLOCK_SKEW_SECONDS = 60;

export function issuePrepareCreatedAt(
  nowSeconds = Math.floor(Date.now() / 1000)
): number {
  return nowSeconds;
}

/** Reject client-supplied prepare timestamps outside server-issued bounds. */
export function assertValidPrepareCreatedAt(
  createdAt: number,
  nowSeconds = Math.floor(Date.now() / 1000)
): number {
  if (!Number.isFinite(createdAt) || createdAt <= 0) {
    throw new Error("invalid prepare timestamp");
  }
  if (createdAt > nowSeconds + PREPARE_INTENT_MAX_CLOCK_SKEW_SECONDS) {
    throw new Error("prepare timestamp is in the future");
  }
  if (nowSeconds - createdAt > PREPARE_INTENT_TTL_SECONDS) {
    throw new Error("prepare intent expired — start a new swap");
  }
  return Math.floor(createdAt);
}
