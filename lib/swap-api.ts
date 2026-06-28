/**
 * HTLC swap client helpers for the /swap UI.
 *
 * Quotes go to `/api/htlc/quote`. Order lifecycle uses `/api/htlc/*` via
 * `lib/htlc-client.ts`. Legacy OIF InputSettler intake was removed.
 */

import { isLoopPopupBlockedError } from "./loop-popup";
import { LOOP_POPUP_BLOCKED_HINT } from "./swap-wait-copy";

/** Minimal order shape returned by POST /api/htlc/quote. */
export interface HtlcQuoteOrder {
  inputs: [string, string][];
  outputs: { amount: string }[];
}

export interface QuoteResponse {
  orderId?: string;
  order: HtlcQuoteOrder;
  cantonParty: string;
  cbtcAmount: string;
  wbtcAmount?: string;
  direction?: "evm-to-canton" | "canton-to-evm" | "canton-to-canton";
  fromAsset?: string;
  toAsset?: string;
  inAmount?: string;
  grossOutAmount?: string;
  outAmount?: string;
  feeBps: number;
  wbtcPriceRaw?: string;
  wbtcPriceDecimals?: number;
  evmChain?: string;
  chainId?: number;
  escrow?: string;
  wbtc: string;
  blockExplorerUrl?: string;
  expires: number;
  fillDeadline?: number;
  networkFeeCc?: string;
  networkFeeUsd?: number;
  minCcRequired?: string;
  networkFeeSource?: string;
  trafficBytes?: number;
  networkFeeTransactions?: import("@/lib/canton-network-fee-math").NetworkFeeTxLeg[];
  networkFeeCharged?: boolean;
  networkFeePreview?: boolean;
  quoteSource?: string;
  quoteAgeMs?: number;
  quoteStale?: boolean;
  midPrice?: string;
  minReceived?: string;
  minReceivedToken?: string;
  expiresAt?: number;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export const USER_REJECTED_MESSAGE = "You declined the request in your wallet.";

export function needsHtlcLoopLockConfirm(order: {
  direction?: string;
  counterMode?: string;
  status?: string;
  counterTransferUpdateId?: string;
  counterTransferOfferCid?: string;
}): boolean {
  return (
    order.direction === "canton-to-evm" &&
    order.counterMode === "loop" &&
    (order.status === "accepted" || order.status === "main_locking") &&
    !order.counterTransferUpdateId &&
    !order.counterTransferOfferCid
  );
}

export function getLoopSignErrorMessage(error: unknown): string | null {
  const maybe = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    errorCode?: unknown;
  };
  const code =
    typeof maybe?.code === "string"
      ? maybe.code
      : typeof maybe?.errorCode === "string"
        ? maybe.errorCode
        : "";
  const message =
    typeof maybe?.message === "string" ? maybe.message.toLowerCase() : "";
  const name = typeof maybe?.name === "string" ? maybe.name : "";

  const looksLikeLoop =
    code === "POPUP_CLOSED" ||
    code === "POPUP_BLOCKED" ||
    name === "PopupClosedError" ||
    name === "RejectRequestError" ||
    message.includes("loop") ||
    message.includes("popup") ||
    message.includes("cantonloop");

  if (!looksLikeLoop && !isLoopPopupBlockedError(error)) {
    return null;
  }

  if (isLoopPopupBlockedError(error) || message.includes("block")) {
    return LOOP_POPUP_BLOCKED_HINT;
  }
  if (code === "POPUP_CLOSED" || name === "PopupClosedError" || message.includes("popup")) {
    return "Loop approved or closed before WarpX received confirmation. Keep this tab open, click Try again, or finish from Orders.";
  }
  if (
    message.includes("reject") ||
    message.includes("declin") ||
    name === "RejectRequestError"
  ) {
    return "Signature was declined in Loop wallet. Please approve it to continue.";
  }
  if (
    message.includes("not connected") ||
    message.includes("cannot reconnect") ||
    message.includes("failed to reconnect")
  ) {
    return "Loop wallet connection expired. Reconnect Loop wallet, then sign again.";
  }
  if (message.includes("timeout")) {
    return "Loop wallet did not return the signature in time. Open the Loop wallet tab and try again.";
  }
  return "Loop wallet did not complete the signature. Open Loop wallet and try again.";
}

const REJECT_CODES = [4001];
const REJECT_MESSAGES = [
  "user denied message signature",
  "user rejected",
  "user denied",
  "rejected the request",
  "rejected transaction",
  "transaction was rejected"
];

function rawErrorMessage(e: unknown): string {
  if (!e) return "";
  const short = (e as { shortMessage?: string }).shortMessage;
  if (typeof short === "string" && short) return short;
  if (e instanceof Error) {
    if (e.message && e.message !== "[object Object]") return e.message;
    const cause = (e as { cause?: unknown }).cause;
    if (cause) return rawErrorMessage(cause);
  }
  const o = e as {
    message?: string;
    reason?: string;
    data?: { message?: string };
    error?: { message?: string };
  };
  const nested =
    o?.message || o?.reason || o?.data?.message || o?.error?.message;
  if (typeof nested === "string" && nested && nested !== "[object Object]")
    return nested;
  try {
    const json = JSON.stringify(e);
    return json && json !== "{}" ? json : "";
  } catch {
    const fallback = String(e);
    return fallback === "[object Object]" ? "" : fallback;
  }
}

export function isTransientEvmFinalityError(e: unknown): boolean {
  const raw = rawErrorMessage(e).toLowerCase();
  return raw.includes("awaiting finality");
}

export function isUserRejection(e: unknown): boolean {
  const code = (e as { code?: number })?.code;
  if (typeof code === "number" && REJECT_CODES.includes(code)) return true;
  const m = rawErrorMessage(e).toLowerCase();
  return REJECT_MESSAGES.some((r) => m.includes(r));
}

export function getSwapErrorMessage(e: unknown): string {
  if (isTransientEvmFinalityError(e)) return "";
  if (isLoopPopupBlockedError(e)) return LOOP_POPUP_BLOCKED_HINT;
  const loopMsg = getLoopSignErrorMessage(e);
  if (loopMsg) return loopMsg;
  if (isUserRejection(e)) return USER_REJECTED_MESSAGE;
  if (e instanceof ApiError) {
    const m = e.message?.trim();
    return m
      ? m.charAt(0).toUpperCase() + m.slice(1)
      : `Request failed (${e.status}).`;
  }
  const raw = rawErrorMessage(e);
  const lower = raw.toLowerCase();
  if (lower === "not found" || (lower.includes("404") && lower.includes("/api/htlc"))) {
    return "This swap order could not be loaded. Open it again from Orders or refresh the page.";
  }
  if (
    lower.includes("exceeds max transaction gas limit") ||
    lower.includes("likely to fail")
  ) {
    return "No WBTC is locked on-chain for this swap — the solver counter-lock did not land. Your CBTC is still safe; wait for the solver to retry or refund after the timelock.";
  }
  return raw || "Something went wrong. Please try again.";
}

async function req<T>(
  path: string,
  init?: RequestInit,
  baseUrl?: string
): Promise<T> {
  const res = await fetch(`${baseUrl ?? "/api/htlc"}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) }
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new ApiError(
      res.status,
      (body as { error?: string }).error ?? `${path} failed (${res.status})`
    );
  }
  return body as T;
}

export function getQuote(input: {
  user: string;
  cantonParty: string;
  wbtcAmount?: string;
  cbtcAmount?: string;
  direction?: "evm-to-canton" | "canton-to-evm";
  counterMode?: "managed" | "loop";
  evmChain?: string;
}): Promise<QuoteResponse> {
  return req<QuoteResponse>("/quote", {
    method: "POST",
    body: JSON.stringify(input)
  }).then((q) => ({
    ...q,
    feeBps: q.feeBps ?? (q as { bridgeFeeBps?: number }).bridgeFeeBps ?? 0
  }));
}

export const PENDING_BUFFER_SECONDS = 60;
export const DELAYED_AFTER_SECONDS = 45;

export type SwapProgressState =
  | "initial"
  | "delivering"
  | "finished"
  | "delayed"
  | "expired"
  | "refunded"
  | "failed";
