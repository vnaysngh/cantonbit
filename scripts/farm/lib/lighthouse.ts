import { NETWORK } from "../../../lib/constants";
import { MEASURED_BYTES_PER_SWAP } from "./planner";

const LIGHTHOUSE_BASE: Record<string, string> = {
  mainnet: "https://lighthouse.cantonloop.com",
  devnet: "https://lighthouse.devnet.cantonloop.com"
};

export interface TrafficStatus {
  totalConsumed: number;
  totalLimit: number;
}

export async function fetchTrafficStatus(
  validatorParty = NETWORK.warpxPartyId
): Promise<TrafficStatus> {
  const base = LIGHTHOUSE_BASE[NETWORK.name] ?? LIGHTHOUSE_BASE.mainnet;
  const url = `${base}/api/validators/${encodeURIComponent(validatorParty)}`;
  const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!r.ok) {
    throw new Error(`Lighthouse fetch failed (${r.status})`);
  }
  const j = (await r.json()) as {
    traffic_status?: { total_consumed?: number; total_limit?: number };
  };
  return {
    totalConsumed: Number(j.traffic_status?.total_consumed ?? 0),
    totalLimit: Number(j.traffic_status?.total_limit ?? 0)
  };
}

export function meanIntervalSeconds(params: {
  bytesPerSwap: number;
  targetUtilization: number;
  refillBytesPerSec?: number;
}): number {
  const refill = params.refillBytesPerSec ?? 333;
  const effective = refill * params.targetUtilization;
  if (effective <= 0 || params.bytesPerSwap <= 0) return 60;
  return params.bytesPerSwap / effective;
}

export async function measureBytesPerSwap(params: {
  swapCount: number;
  beforeConsumed: number;
  afterFn: () => Promise<void>;
}): Promise<number> {
  const afterConsumed = (await fetchTrafficStatus()).totalConsumed;
  await params.afterFn();
  const finalConsumed = (await fetchTrafficStatus()).totalConsumed;
  const delta = finalConsumed - afterConsumed;
  if (params.swapCount <= 0 || delta <= 0) return MEASURED_BYTES_PER_SWAP;
  return delta / params.swapCount;
}

/** Estimate bytes consumed between two Lighthouse readings. */
export function bytesDelta(before: number, after: number, swapCount: number): number {
  const delta = after - before;
  if (delta <= 0 || swapCount <= 0) return MEASURED_BYTES_PER_SWAP;
  return delta / swapCount;
}
