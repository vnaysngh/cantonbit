import { appendFileSync } from "node:fs";

import { swapLogPath } from "./config";
import type { FarmSwapResult } from "./types";

export interface SwapTimingFields {
  runId?: string;
  swapNumberInRun?: number;
  /** Wall time to execute offer + fill on ledger (seconds). */
  swapDurationSec?: number;
  /** Planned sleep after this swap before the next pick (seconds). */
  sleepAfterSec?: number;
  /** Wall seconds since the previous swap log line (sleep + plan + swap). */
  wallIntervalSec?: number | null;
}

export interface RunSummaryEntry {
  type: "run_summary";
  ts: string;
  runId: string;
  swapCount: number;
  totalWallSec: number;
  avgSwapDurationSec: number;
  avgSleepAfterSec: number;
  avgWallIntervalSec: number;
}

export function appendSwapLog(
  entry: Record<string, unknown>,
  logPath = swapLogPath()
): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  appendFileSync(logPath, `${line}\n`, "utf8");
}

export function logSwapResult(
  result: FarmSwapResult,
  extra?: Record<string, unknown> & SwapTimingFields
): void {
  appendSwapLog({
    type: "swap",
    swapId: result.swapId,
    trader: result.traderParty,
    from: result.fromAsset,
    to: result.toAsset,
    inAmount: result.inAmount,
    outAmount: result.outAmount,
    offerUpdateId: result.offerUpdateId,
    fillUpdateId: result.fillUpdateId,
    counterPendingAccept: result.counterPendingAccept,
    ccBurnSuspected: result.ccBurnSuspected ?? false,
    burnChoices: result.burnChoices ?? [],
    ...extra
  });
}

export function logRunSummary(summary: Omit<RunSummaryEntry, "type" | "ts">): void {
  appendSwapLog({ type: "run_summary", ...summary });
}

