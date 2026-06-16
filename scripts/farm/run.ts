#!/usr/bin/env npx tsx
/**
 * Continuous farm bot — balance-aware swaps paced to traffic bucket refill.
 */
import { randomUUID } from "node:crypto";

import { assertMainnetNetwork, loadFleet, saveFleet } from "./lib/config";
import { executeSwap } from "./lib/execute-swap";
import { getLedgerJwt } from "./lib/jwt";
import { logRunSummary, logSwapResult } from "./lib/log";
import {
  bytesDelta,
  fetchTrafficStatus,
  meanIntervalSeconds
} from "./lib/lighthouse";
import { auditMainnetConfig, printAudit } from "./lib/mainnet-audit";
import {
  organicInterval,
  pacingFromArgs,
  sleepSecondsAfterSwap,
  sleepMs
} from "./lib/organic";
import { MEASURED_BYTES_PER_SWAP, planNextSwap, type PlannerState } from "./lib/planner";
import {
  parseFlag,
  parseNumberArg,
  requireMainnetGuard
} from "./lib/parse-args";
import { isTransientError, retry } from "./lib/retry";

function assertBitsafeGate(): void {
  if (
    parseFlag("bitsafe-eligible-confirmed") ||
    process.env.BITSAFE_FARMING_ELIGIBLE === "1"
  ) {
    return;
  }
  console.error(
    "BitSafe eligibility gate: set BITSAFE_FARMING_ELIGIBLE=1 or pass --bitsafe-eligible-confirmed"
  );
  process.exit(1);
}

function resolveBytesPerSwap(
  pacingBytes: number | null,
  fleetBytes?: number
): number {
  return pacingBytes ?? fleetBytes ?? MEASURED_BYTES_PER_SWAP;
}

function logRetry(label: string) {
  return (attempt: number, delayMs: number, err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `  ${label} retry ${attempt} in ${Math.round(delayMs)}ms: ${msg.slice(0, 100)}`
    );
  };
}

async function safeTrafficConsumed(): Promise<number> {
  try {
    return (await fetchTrafficStatus()).totalConsumed;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`  lighthouse read skipped: ${msg.slice(0, 100)}`);
    return 0;
  }
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function flushBatchSummary(params: {
  runId: string;
  batchStartAt: number;
  lastSwapLogAt: number | null;
  durations: number[];
  sleeps: number[];
  intervals: number[];
}): void {
  if (params.durations.length === 0 || params.lastSwapLogAt == null) return;
  const totalWallSec = (params.lastSwapLogAt - params.batchStartAt) / 1000;
  logRunSummary({
    runId: params.runId,
    swapCount: params.durations.length,
    totalWallSec: Math.round(totalWallSec * 10) / 10,
    avgSwapDurationSec: Math.round(avg(params.durations) * 10) / 10,
    avgSleepAfterSec: Math.round(avg(params.sleeps)),
    avgWallIntervalSec:
      params.intervals.length > 0
        ? Math.round(avg(params.intervals) * 10) / 10
        : 0
  });
}

export async function runFarmBot(): Promise<void> {
  assertMainnetNetwork();
  requireMainnetGuard();
  assertBitsafeGate();

  const audit = auditMainnetConfig();
  if (!audit.ok) {
    printAudit(audit);
    process.exit(1);
  }

  const fleet = loadFleet();
  const pacing = pacingFromArgs();
  const maxSwaps = parseNumberArg("max-swaps", 0);
  const dryRun = parseFlag("dry-run");

  let bytesPerSwap = resolveBytesPerSwap(
    pacing.bytesPerSwap,
    fleet.calibration?.bytesPerSwap
  );

  let jwt = await retry(() => getLedgerJwt(), { label: "jwt", onRetry: logRetry("jwt") });
  let swapCount = 0;
  let calibrateSwaps = 0;
  let calibrateStartConsumed = await safeTrafficConsumed();
  let meanInterval = meanIntervalSeconds({
    bytesPerSwap,
    targetUtilization: pacing.targetUtilization,
    refillBytesPerSec: pacing.refillBytesPerSec
  });
  let plannerState: PlannerState = {};
  const runId = randomUUID();
  const runStartedAt = Date.now();
  let lastSwapLogAt: number | null = null;
  const batchDurations: number[] = [];
  const batchSleeps: number[] = [];
  const batchIntervals: number[] = [];
  let batchStartAt = runStartedAt;

  console.log(`Farm run — traders=${fleet.traders.length} dryRun=${dryRun} runId=${runId.slice(0, 8)}`);
  console.log(
    `Amounts: CBTC→CC in=${pacing.cbtcInAmount}  CC→CBTC in=${pacing.ccInAmount}`
  );
  console.log(
    `Pacing: bytes/swap≈${Math.round(bytesPerSwap)} meanInterval≈${Math.round(meanInterval)}s util=${pacing.targetUtilization}`
  );
  console.log(`Planner: alternates direction, balance-aware trader pick`);

  while (maxSwaps === 0 || swapCount < maxSwaps) {
    let pick;
    try {
      const planned = await retry(
        () =>
          planNextSwap({
            jwt,
            fleet,
            pacing,
            state: plannerState
          }),
        { label: "plan", onRetry: logRetry("plan") }
      );
      pick = planned.pick;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`✗ plan failed:\n${msg.split("\n").map((l) => `  ${l}`).join("\n")}`);
      if (/401|unauthorized|jwt/i.test(msg)) {
        jwt = await retry(() => getLedgerJwt(), { label: "jwt", onRetry: logRetry("jwt") });
      }
      await sleepMs(isTransientError(e) ? 30_000 : 60_000);
      continue;
    }

    if (dryRun) {
      const sleepSec = organicInterval(meanInterval, pacing);
      console.log(
        `tick ${swapCount + 1}: ${pick.traderParty.slice(0, 20)}… ${pick.fromAsset}→${pick.toAsset} in=${pick.inAmount} sleep=${Math.round(sleepSec)}s`
      );
      swapCount++;
      await sleepMs(sleepSec * 1000);
      continue;
    }

    const swapStart = Date.now();
    try {
      const result = await retry(
        () =>
          executeSwap({
            jwt,
            fleet,
            traderParty: pick.traderParty,
            fromAsset: pick.fromAsset,
            toAsset: pick.toAsset,
            inAmount: pick.inAmount
          }),
        { label: "swap", onRetry: logRetry("swap") }
      );
      swapCount++;
      calibrateSwaps++;
      const swapDurationSec = (Date.now() - swapStart) / 1000;
      const sleepSec = sleepSecondsAfterSwap({
        bytesPerSwap,
        pacing,
        swapDurationSec
      });
      console.log(
        `✓ swap ${swapCount}: ${result.fromAsset}→${result.toAsset} ${result.inAmount}→${result.outAmount} fill=${result.fillUpdateId.slice(0, 16)}… swap=${swapDurationSec.toFixed(1)}s sleep=${Math.round(sleepSec)}s`
      );
      if (result.ccBurnSuspected) {
        console.warn(
          `  ⚠ CC burn/fee choice detected: ${(result.burnChoices ?? []).join(", ")}`
        );
      }

      const loggedAt = Date.now();
      const wallIntervalSec =
        lastSwapLogAt != null ? (loggedAt - lastSwapLogAt) / 1000 : null;
      if (wallIntervalSec != null) batchIntervals.push(wallIntervalSec);
      batchDurations.push(swapDurationSec);
      batchSleeps.push(sleepSec);

      logSwapResult(result, {
        runId,
        swapNumberInRun: swapCount,
        swapDurationSec: Math.round(swapDurationSec * 10) / 10,
        sleepAfterSec: Math.round(sleepSec),
        wallIntervalSec:
          wallIntervalSec != null ? Math.round(wallIntervalSec * 10) / 10 : null
      });
      plannerState = {
        lastDirection:
          result.fromAsset === "CBTC" ? "CBTC→CC" : "CC→CBTC",
        lastTraderParty: pick.traderParty
      };
      lastSwapLogAt = loggedAt;

      if (calibrateSwaps >= pacing.calibrateEvery) {
        flushBatchSummary({
          runId,
          batchStartAt,
          lastSwapLogAt,
          durations: batchDurations,
          sleeps: batchSleeps,
          intervals: batchIntervals
        });
        batchDurations.length = 0;
        batchSleeps.length = 0;
        batchIntervals.length = 0;
        batchStartAt = Date.now();
        lastSwapLogAt = null;

        const consumed = await safeTrafficConsumed();
        const measured = bytesDelta(calibrateStartConsumed, consumed, calibrateSwaps);
        if (measured > 0 && measured !== bytesPerSwap) {
          bytesPerSwap = measured;
          fleet.calibration = {
            bytesPerSwap: Math.round(bytesPerSwap),
            measuredAt: new Date().toISOString(),
            source: "lighthouse"
          };
          saveFleet(fleet);
          meanInterval = meanIntervalSeconds({
            bytesPerSwap,
            targetUtilization: pacing.targetUtilization,
            refillBytesPerSec: pacing.refillBytesPerSec
          });
          console.log(
            `  recalibrated bytes/swap≈${Math.round(bytesPerSwap)} meanInterval≈${Math.round(meanInterval)}s (lighthouse)`
          );
        }
        calibrateSwaps = 0;
        calibrateStartConsumed = consumed;
      }

      await sleepMs(sleepSec * 1000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`✗ swap failed: ${msg.slice(0, 200)}`);
      if (/401|unauthorized|jwt/i.test(msg)) {
        jwt = await retry(() => getLedgerJwt(), { label: "jwt", onRetry: logRetry("jwt") });
      }
      if (/traffic rejection/i.test(msg)) {
        meanInterval *= 2;
        meanInterval = Math.min(meanInterval, 15 * 60);
        console.warn(`  traffic backoff → meanInterval≈${Math.round(meanInterval)}s`);
      }
      await sleepMs(organicInterval(meanInterval, pacing) * 1000);
    }
  }

  if (swapCount > 0) {
    flushBatchSummary({
      runId,
      batchStartAt,
      lastSwapLogAt,
      durations: batchDurations,
      sleeps: batchSleeps,
      intervals: batchIntervals
    });
  }

  if (swapCount > 0 && !fleet.calibration?.bytesPerSwap) {
    fleet.calibration = {
      bytesPerSwap: Math.round(bytesPerSwap),
      measuredAt: new Date().toISOString(),
      source: "ledger-estimate"
    };
    saveFleet(fleet);
  }

  console.log(`\nDone (${swapCount} swaps).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runFarmBot().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
