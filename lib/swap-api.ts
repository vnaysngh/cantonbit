/**
 * Client for the solver HTTP API (swap-solver/src/api.ts).
 *
 * The solver is the single source of truth for swap order state. This module is
 * a thin typed fetch wrapper the /swap page uses to: get a quote (which returns
 * the Permit2 typed data to sign), submit the signed order, and poll status.
 *
 * The base URL is configured via NEXT_PUBLIC_SWAP_API_URL (defaults to
 * http://localhost:8787 for local dev).
 */

export const SWAP_API_URL =
  process.env.NEXT_PUBLIC_SWAP_API_URL ?? "http://localhost:8787";

/** Permit2 typed data the wallet signs (EIP-712). */
export interface Permit2TypedData {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

/** A serialized StandardOrder (bigints as decimal strings). */
export interface SerializedOrder {
  user: string;
  nonce: string;
  originChainId: string;
  expires: number;
  fillDeadline: number;
  inputOracle: string;
  inputs: [string, string][];
  outputs: {
    oracle: string;
    settler: string;
    chainId: string;
    token: string;
    amount: string;
    recipient: string;
    callbackData: string;
    context: string;
  }[];
}

export interface QuoteResponse {
  orderId: string;
  order: SerializedOrder;
  cantonParty: string;
  cbtcAmount: string;
  feeBps: number;
  permit2: Permit2TypedData;
  escrow: string;
  wbtc: string;
  expires: number;
  fillDeadline: number;
}

export type SwapStatus =
  | "seen"
  | "delivering"
  | "delivered"
  | "attested"
  | "finalised"
  | "refunded"
  | "failed";

export interface OrderView {
  orderId: string;
  status: SwapStatus;
  cantonParty?: string;
  cbtcAmount?: string;
  wbtcAmount?: string;
  fillDeadline: number;
  expires: number;
  fillTimestamp?: number;
  cantonDeliveryRef?: string;
  attestTxHash?: string;
  finaliseTxHash?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HealthResponse {
  ok: boolean;
  network: string;
  chain: string;
  escrow: string;
  oracle: string;
  wbtc: string;
  agent: string;
  maxWbtcPerOrder: string;
  floatSats: string | null;
  floatError: string | null;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${SWAP_API_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `${path} failed (${res.status})`);
  }
  return body as T;
}

export function getHealth(): Promise<HealthResponse> {
  return req<HealthResponse>("/health");
}

export function getQuote(input: {
  user: string;
  wbtcAmount: string; // base units (8dp)
  cantonParty: string;
}): Promise<QuoteResponse> {
  return req<QuoteResponse>("/quote", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function submitOrder(input: {
  order: SerializedOrder;
  signature: string;
  cantonParty: string;
}): Promise<{ orderId: string; status: SwapStatus; openTx?: string; alreadyRegistered?: boolean }> {
  return req("/orders", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getOrder(orderId: string): Promise<OrderView> {
  return req<OrderView>(`/orders/${orderId}`);
}

/** Refund an expired, unfinalised order — returns the locked WBTC to the user. */
export function refundOrder(orderId: string): Promise<{
  orderId: string;
  status: SwapStatus;
  refundTx?: string;
  alreadyRefunded?: boolean;
}> {
  return req(`/orders/${orderId}/refund`, { method: "POST" });
}

/** Terminal statuses where polling should stop. */
export function isTerminal(status: SwapStatus): boolean {
  return status === "finalised" || status === "refunded" || status === "failed";
}

/** Human-friendly status labels for the UI. */
export const STATUS_LABEL: Record<SwapStatus, string> = {
  seen: "WBTC locked — solver notified",
  delivering: "Delivering cBTC on Canton…",
  delivered: "cBTC sent to your wallet — settling…",
  attested: "Fill attested — releasing WBTC…",
  finalised: "Complete — cBTC sent ✓",
  refunded: "Refunded to your wallet",
  failed: "Swap failed",
};
