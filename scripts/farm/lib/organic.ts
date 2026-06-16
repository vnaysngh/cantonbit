import type { FarmFleetConfig, FarmAsset, PacingConfig } from "./types";
import { meanIntervalSeconds } from "./lighthouse";
import { parseArg, parseNumberArg } from "./parse-args";

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Jitter multiplier — tighter band for higher bucket utilization. */
export function intervalJitterMultiplier(): number {
  const roll = Math.random();
  if (roll < 0.02) return randomBetween(1.8, 2.5);
  if (roll < 0.05) return randomBetween(0.75, 0.9);
  return randomBetween(0.9, 1.1);
}

export function organicInterval(meanSec: number, pacing: PacingConfig): number {
  const sec = meanSec * intervalJitterMultiplier();
  return Math.min(pacing.maxIntervalSec, Math.max(pacing.minIntervalSec, sec));
}

/**
 * Sleep after a swap so bucket refill matches bytes consumed.
 * Subtracts time already spent executing the swap (no double-waiting).
 */
export function sleepSecondsAfterSwap(params: {
  bytesPerSwap: number;
  pacing: PacingConfig;
  swapDurationSec: number;
}): number {
  const mean = meanIntervalSeconds({
    bytesPerSwap: params.bytesPerSwap,
    targetUtilization: params.pacing.targetUtilization,
    refillBytesPerSec: params.pacing.refillBytesPerSec
  });
  const target = mean * intervalJitterMultiplier();
  const remaining = target - params.swapDurationSec;
  return Math.min(
    params.pacing.maxIntervalSec,
    Math.max(params.pacing.minIntervalSec, remaining)
  );
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function defaultPacing(): PacingConfig {
  return {
    targetUtilization: 0.92,
    bytesPerSwap: null,
    calibrateEvery: 5,
    minIntervalSec: 20,
    maxIntervalSec: 600,
    cbtcInAmount: "0.00001",
    ccInAmount: "10",
    cbtcDirectionBias: 0.5,
    refillBytesPerSec: 333
  };
}

export function pacingFromArgs(): PacingConfig {
  const base = defaultPacing();
  return {
    ...base,
    targetUtilization: parseNumberArg("target-utilization", base.targetUtilization),
    bytesPerSwap: parseArg("bytes-per-swap")
      ? parseNumberArg("bytes-per-swap", 30_000)
      : null,
    calibrateEvery: parseNumberArg("calibrate-every", base.calibrateEvery),
    minIntervalSec: parseNumberArg("min-interval", base.minIntervalSec),
    maxIntervalSec: parseNumberArg("max-interval", base.maxIntervalSec),
    cbtcInAmount: parseArg("cbtc-in", base.cbtcInAmount)!,
    ccInAmount: parseArg("cc-in", base.ccInAmount)!,
    cbtcDirectionBias: parseNumberArg("cbtc-direction-bias", base.cbtcDirectionBias)
  };
}
