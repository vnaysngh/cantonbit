/** Pure traffic-bytes → CC fee math (unit-testable, no I/O). */

import { fromBaseUnits, toBaseUnitsFloor } from "./amount-units";

export const CC_DECIMALS = 10;

export interface NetworkFeeTxLeg {
  id: string;
  label: string;
  trafficBytes: number;
  /** User pays this Canton submit when collection is enabled. */
  charged: boolean;
}

function envValue(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const withoutInlineComment = raw.replace(/\s+#.*$/, "").trim();
  if (!withoutInlineComment) return undefined;
  return withoutInlineComment.replace(/^["']|["']$/g, "").trim();
}

export function parseEnvInt(name: string, fallback: number): number {
  const raw = envValue(name);
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envFlagEnabled(name: string): boolean {
  const raw = envValue(name)?.toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function isNetworkFeeEnabled(): boolean {
  return envFlagEnabled("NETWORK_FEE_ENABLED");
}

/** Show fee estimates in quotes/UI without collecting CC (local dev). */
export function isNetworkFeeQuotePreview(): boolean {
  return envFlagEnabled("NETWORK_FEE_QUOTE_PREVIEW");
}

export function shouldQuoteNetworkFee(): boolean {
  return isNetworkFeeEnabled() || isNetworkFeeQuotePreview();
}

export function networkFeeReceiverParty(): string {
  return process.env.NETWORK_FEE_RECEIVER_PARTY?.trim() || "";
}

export function networkFeeBufferBps(): number {
  return parseEnvInt("NETWORK_FEE_BUFFER_BPS", 1500);
}

export function networkFeeReserveCc(): string {
  const n = parseEnvInt("NETWORK_FEE_RESERVE_CC", 5);
  return String(n);
}

export function networkFeeMaxBpsOfNotional(): number {
  return parseEnvInt("NETWORK_FEE_MAX_BPS_OF_NOTIONAL", 250);
}

/** bytes → CC before buffer. */
export function trafficBytesToCcRaw(params: {
  trafficBytes: number;
  extraTrafficPriceUsdPerMb: number;
  amuletPriceUsd: number;
}): number {
  const { trafficBytes, extraTrafficPriceUsdPerMb, amuletPriceUsd } = params;
  if (
    !Number.isFinite(trafficBytes) ||
    trafficBytes <= 0 ||
    !Number.isFinite(extraTrafficPriceUsdPerMb) ||
    extraTrafficPriceUsdPerMb <= 0 ||
    !Number.isFinite(amuletPriceUsd) ||
    amuletPriceUsd <= 0
  ) {
    return 0;
  }
  const usd =
    (trafficBytes / 1_000_000) * extraTrafficPriceUsdPerMb;
  return usd / amuletPriceUsd;
}

/** Apply buffer and round up to 6 decimal CC. */
export function applyNetworkFeeBuffer(cc: number, bufferBps: number): string {
  if (!Number.isFinite(cc) || cc <= 0) return "0";
  const withBuffer = cc * (1 + bufferBps / 10_000);
  const rounded = Math.ceil(withBuffer * 1_000_000) / 1_000_000;
  return rounded.toFixed(6).replace(/\.?0+$/, "") || "0";
}

export function trafficBytesToFeeCc(params: {
  trafficBytes: number;
  extraTrafficPriceUsdPerMb: number;
  amuletPriceUsd: number;
  bufferBps?: number;
}): { feeCc: string; feeUsd: number } {
  const rawCc = trafficBytesToCcRaw(params);
  const feeCc = applyNetworkFeeBuffer(
    rawCc,
    params.bufferBps ?? networkFeeBufferBps()
  );
  const feeUsd =
    (params.trafficBytes / 1_000_000) * params.extraTrafficPriceUsdPerMb;
  return { feeCc, feeUsd };
}

export function minCcRequiredForNetworkFee(feeCc: string): string {
  if (!isNetworkFeeEnabled() && !isNetworkFeeQuotePreview()) return "0";
  const fee = Number.parseFloat(feeCc);
  const reserve = Number.parseFloat(networkFeeReserveCc());
  if (!Number.isFinite(fee) || fee <= 0) {
    return Number.isFinite(reserve) ? reserve.toFixed(6) : "0";
  }
  const total = fee + (Number.isFinite(reserve) ? reserve : 0);
  return total.toFixed(6).replace(/\.?0+$/, "") || "0";
}

/** Never charge more than the fee bound on the order at create time. */
export function capNetworkFeeAtOrder(
  storedFeeCc: string | undefined,
  freshFeeCc: string
): string {
  if (storedFeeCc == null || storedFeeCc === "") return freshFeeCc;
  const stored = toBaseUnitsFloor(storedFeeCc, CC_DECIMALS);
  const fresh = toBaseUnitsFloor(freshFeeCc, CC_DECIMALS);
  if (fresh <= stored) return freshFeeCc;
  return fromBaseUnits(stored, CC_DECIMALS);
}

export function compareCcBalanceGte(balanceCc: string, requiredCc: string): boolean {
  return (
    toBaseUnitsFloor(balanceCc, CC_DECIMALS) >=
    toBaseUnitsFloor(requiredCc, CC_DECIMALS)
  );
}

/** Refuse economically irrational swaps whose Canton fee exceeds the bound. */
export function assertNetworkFeeNotionalGuard(params: {
  feeUsd: number;
  notionalUsd: number;
  maxBps?: number;
}): void {
  const maxBps = params.maxBps ?? networkFeeMaxBpsOfNotional();
  if (
    !Number.isFinite(params.feeUsd) ||
    params.feeUsd < 0 ||
    !Number.isFinite(params.notionalUsd) ||
    params.notionalUsd <= 0 ||
    !Number.isInteger(maxBps) ||
    maxBps <= 0 ||
    maxBps > 10_000
  ) {
    throw new NetworkFeeNotionalError(
      "Could not verify the swap value against the Canton network fee."
    );
  }
  const feeBps = (params.feeUsd / params.notionalUsd) * 10_000;
  if (feeBps > maxBps) {
    throw new NetworkFeeNotionalError(
      `Canton network fee is too high for this swap (${feeBps.toFixed(0)} bps; max ${maxBps} bps). Increase the swap amount or try later.`
    );
  }
}

export class NetworkFeeNotionalError extends Error {
  readonly userMessage: string;
  constructor(userMessage: string) {
    super(userMessage);
    this.name = "NetworkFeeNotionalError";
    this.userMessage = userMessage;
  }
}

export class NetworkFeeBalanceError extends Error {
  readonly userMessage: string;
  readonly feeCc: string;
  readonly minCcRequired: string;
  readonly balanceCc: string;
  constructor(params: {
    feeCc: string;
    minCcRequired: string;
    balanceCc: string;
  }) {
    super(
      `Need ${params.minCcRequired} CC for network fee (${params.feeCc} CC) + reserve; balance ${params.balanceCc} CC`
    );
    this.name = "NetworkFeeBalanceError";
    this.userMessage = `Need ${params.minCcRequired} CC for network fee + reserve (you have ${params.balanceCc} CC). Send CC from Account → Send.`;
    this.feeCc = params.feeCc;
    this.minCcRequired = params.minCcRequired;
    this.balanceCc = params.balanceCc;
  }
}
