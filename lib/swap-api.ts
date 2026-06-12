/**
 * Client for the solver HTTP API (swap-solver/src/api.ts).
 *
 * The solver is the single source of truth for swap order state. This module is
 * a thin typed fetch wrapper the /swap page uses to: get a quote (which returns
 * the Permit2 typed data to sign), submit the signed order, and poll status.
 *
 * Base URL resolution:
 *   - NEXT_PUBLIC_SWAP_API_URL, if set, wins (e.g. a direct solver URL for local
 *     dev: http://localhost:8787).
 *   - Otherwise we hit the SAME-ORIGIN proxy at /api/solver (app/api/solver/[...path]),
 *     which forwards server-side to the PRIVATE solver. This keeps the solver off
 *     the public internet in split-service deploys (e.g. Railway).
 */

export const SWAP_API_URL =
  process.env.NEXT_PUBLIC_SWAP_API_URL ?? "/api/solver";

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
  /** Live WBTC/BTC price used for this quote: price = wbtcPriceRaw / 10^wbtcPriceDecimals. */
  wbtcPriceRaw?: string;
  wbtcPriceDecimals?: number;
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
  /** Bridge fee in basis points (e.g. 20 = 0.2%). */
  feeBps: number;
  floatSats: string | null;
  floatError: string | null;
  /** De-peg circuit-breaker status. null = no guard configured. */
  depeg: {
    paused: boolean;
    priceBtc?: number;
    deviationBps?: number;
    reason?: string;
  } | null;
}

/** An API error that carries the HTTP status, so callers can tell a 404 (the
 *  order is gone — stop tracking) from a transient 5xx/network error (retry). */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Error mapping — benchmarked against CoW's getSwapErrorMessage.
// Refs: common/utils/getSwapErrorMessage.ts, libs/common-utils/src/misc.ts
//       (isRejectRequestProviderError), api/.../OperatorError.ts
// CoW's 3-way split: user-rejected-signature → friendly fixed string; API error
// → the API's own message; everything else (RPC/provider) → provider message.
// ---------------------------------------------------------------------------

/** The friendly message for a user-cancelled wallet prompt (CoW: USER_SWAP_REJECTED_ERROR). */
export const USER_REJECTED_MESSAGE = "You declined the request in your wallet.";

// EIP-1193 rejection code + the message allow-list CoW matches on. We
// deliberately do NOT treat -32000 as a rejection (CoW's note: it would swallow
// real node errors).
const REJECT_CODES = [4001];
const REJECT_MESSAGES = [
  "user denied message signature",
  "user rejected",
  "user denied",
  "rejected the request",
  "rejected transaction",
  "transaction was rejected",
];

function rawErrorMessage(e: unknown): string {
  if (!e) return "";
  // viem/provider errors expose a concise `shortMessage`; prefer it (CoW does).
  const short = (e as { shortMessage?: string }).shortMessage;
  if (typeof short === "string" && short) return short;
  if (e instanceof Error) {
    if (e.message && e.message !== "[object Object]") return e.message;
    const cause = (e as { cause?: unknown }).cause;
    if (cause) return rawErrorMessage(cause);
  }
  // Raw provider/RPC errors are plain objects — dig out a message rather than
  // String(e) (which renders "[object Object]").
  const o = e as { message?: string; reason?: string; data?: { message?: string }; error?: { message?: string } };
  const nested = o?.message || o?.reason || o?.data?.message || o?.error?.message;
  if (typeof nested === "string" && nested && nested !== "[object Object]") return nested;
  try {
    const json = JSON.stringify(e);
    return json && json !== "{}" ? json : "";
  } catch {
    const fallback = String(e);
    return fallback === "[object Object]" ? "" : fallback;
  }
}

/** True if the error is a user-rejected wallet prompt (CoW: isRejectRequestProviderError). */
export function isUserRejection(e: unknown): boolean {
  const code = (e as { code?: number })?.code;
  if (typeof code === "number" && REJECT_CODES.includes(code)) return true;
  const m = rawErrorMessage(e).toLowerCase();
  return REJECT_MESSAGES.some((r) => m.includes(r));
}

/**
 * Map any swap error to a clean, user-facing string — CoW's getSwapErrorMessage.
 * Three cases: (1) user rejected → fixed friendly string; (2) our solver/API
 * ApiError → its own message; (3) anything else (RPC/provider) → the concise
 * provider message.
 */
export function getSwapErrorMessage(e: unknown): string {
  if (isUserRejection(e)) return USER_REJECTED_MESSAGE;
  if (e instanceof ApiError) {
    const m = e.message?.trim();
    return m ? m.charAt(0).toUpperCase() + m.slice(1) : `Request failed (${e.status}).`;
  }
  return rawErrorMessage(e) || "Something went wrong. Please try again.";
}

async function req<T>(path: string, init?: RequestInit, baseUrl?: string): Promise<T> {
  const res = await fetch(`${baseUrl ?? SWAP_API_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new ApiError(res.status, (body as { error?: string }).error ?? `${path} failed (${res.status})`);
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
  // HTLC-native quote — same-origin route, no dependency on the old solver service.
  return req<QuoteResponse>("/quote", {
    method: "POST",
    body: JSON.stringify(input),
  }, "/api/htlc");
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

/**
 * Report the cBTC delivery outcome (read from the user's Loop history) to the
 * solver. status "completed" → solver finalises (releases WBTC); "rejected" →
 * solver marks failed → user refunds. This is how the swap completes: the user's
 * app, which holds the authoritative history, tells the solver to settle.
 */
export function reportAccepted(
  orderId: string,
  body: { status: "completed" | "rejected"; historyId?: string },
): Promise<{ orderId: string; status: SwapStatus }> {
  return req(`/orders/${orderId}/accepted`, {
    method: "POST",
    body: JSON.stringify(body),
  });
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

/**
 * Short status caption for the receipt header. Generic, user-facing wording —
 * we don't expose internal legs (lock / attest / finalise), the same way Uniswap
 * ("Swap submitted" → "Swap success") and CoW cross-chain ("Swapping" →
 * "Bridging in progress" → "Bridging completed!") keep the mechanics hidden.
 */
export const STATUS_LABEL: Record<SwapStatus, string> = {
  seen: "Swap in progress",
  delivering: "Swap in progress",
  delivered: "Almost there",
  attested: "Almost there",
  finalised: "Swap complete",
  refunded: "Refunded to your wallet",
  failed: "Swap didn’t complete",
};

// ---------------------------------------------------------------------------
// Progress model — benchmarked against CoW's order progress bar.
// Refs (CoW frontend monorepo):
//   modules/orderProgressBar/constants.ts            — step-name enum
//   modules/orderProgressBar/hooks/useOrderProgressBarProps.ts — getProgressBarStepName
//   legacy/state/orders/utils.ts (isOrderExpired)    — PENDING_ORDERS_BUFFER grace
//   libs/common-const/src/common.ts                  — PENDING_ORDERS_BUFFER = 60s
// ---------------------------------------------------------------------------

/**
 * Grace period after `expires` before the UI treats an in-flight order as
 * dead/expired. CoW uses the same 60s buffer (PENDING_ORDERS_BUFFER) precisely
 * "to take into account race conditions where a solver might execute a
 * transaction after the backend changed the order status." Our solver has the
 * same race (finalise can land just after expiry), so we mirror it.
 */
export const PENDING_BUFFER_SECONDS = 60;

/**
 * How long an in-progress order may sit before we show the reassuring "this is
 * taking longer than usual" copy (CoW's DELAYED state, gated by a short solving
 * countdown). We never freeze on a bare spinner — like CoW, a slow order gets an
 * explanation, not silence.
 */
export const DELAYED_AFTER_SECONDS = 45;

/**
 * The user-facing progress STATES — mirrors CoW's OrderProgressBarStepName
 * (INITIAL/EXECUTING/FINISHED/DELAYED/EXPIRED/REFUND_COMPLETED…), collapsed to
 * what a single-solver cross-chain swap actually has. The UI renders from THIS,
 * not the raw backend status, so slow/expired/refunded each get correct copy.
 */
export type SwapProgressState =
  | "initial" // deposit confirming (seen)
  | "delivering" // CBTC being sent + accepted (delivering/delivered/attested)
  | "finished" // finalised — CBTC delivered, WBTC settled
  | "delayed" // still in-flight but slow — show reassurance, never a frozen spinner
  | "expired" // past the refund window without completing — offer refund
  | "refunded" // WBTC returned to the user
  | "failed"; // couldn't complete (cBTC rejected / hard failure) — funds safe, refundable

/**
 * The three numbered steps the user sees (CoW renders a small fixed set of steps,
 * not the internal legs). Each backend state maps onto one of these.
 */
export const SWAP_STEPS = [
  "Confirming your deposit",
  "Sending CBTC to your wallet",
  "Swap complete",
] as const;

/** Which of the 3 SWAP_STEPS is active for a given progress state. */
export const STEP_FOR_PROGRESS: Record<SwapProgressState, number> = {
  initial: 0,
  delivering: 1,
  delayed: 1,
  finished: 2,
  expired: 0,
  refunded: 0,
  failed: 0,
};

/**
 * Derive the user-facing progress state from an order + the current clock —
 * the analogue of CoW's `getProgressBarStepName`. Applies the grace buffer (no
 * premature "expired") and the delayed threshold (no frozen spinner), so the UI
 * always resolves to a meaningful state instead of an endless "Swapping…".
 */
export function deriveProgress(order: OrderView, nowSeconds: number): SwapProgressState {
  switch (order.status) {
    case "finalised":
      return "finished";
    case "refunded":
      return "refunded";
    case "failed":
      return "failed";
  }
  // In-flight (seen / delivering / delivered / attested).
  // Past the refund window (+ grace buffer) without finishing → expired/refundable.
  if (nowSeconds > order.expires + PENDING_BUFFER_SECONDS) {
    return "expired";
  }
  // Slow but not expired → DELAYED (reassure), once it's sat a while.
  const ageSeconds = nowSeconds - Math.floor(new Date(order.createdAt).getTime() / 1000);
  if (ageSeconds > DELAYED_AFTER_SECONDS) {
    return "delayed";
  }
  // Normal in-flight: first leg vs second leg.
  return order.status === "seen" ? "initial" : "delivering";
}

/** Headline + sub-caption copy per progress state (CoW-style: generic, reassuring). */
export const PROGRESS_COPY: Record<
  SwapProgressState,
  { title: string; caption: string }
> = {
  initial: { title: "Swapping…", caption: "Confirming your deposit" },
  delivering: { title: "Swapping…", caption: "Sending CBTC to your wallet" },
  delayed: {
    title: "Swapping…",
    caption: "This is taking a little longer than usual — hang tight, your funds are safe.",
  },
  finished: { title: "Swap complete", caption: "CBTC delivered to your wallet" },
  expired: {
    title: "Swap didn’t complete",
    caption: "It passed its deadline. Your WBTC is safe — you can refund it now.",
  },
  refunded: { title: "Refunded", caption: "Your WBTC was returned to your wallet" },
  failed: {
    title: "Swap didn’t complete",
    caption: "Your WBTC is safe and can be refunded.",
  },
};
