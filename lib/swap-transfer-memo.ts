import { Buffer } from "node:buffer";

import type { CantonSwapOrder } from "./canton-swap-types";
import type { SwapOrder } from "./htlc-types";
import { TRANSFER_REASON_META_KEY } from "./transfer-options";

export const CANTON_SWAP_MEMO_PREFIX = "oranj.c2c.v1.";
export const HTLC_LOOP_COUNTER_MEMO_PREFIX = "oranj.htlc.fwd.v1.";
export const LEGACY_SWAP_MEMO = "OranjSwap";

export function partyMemoTag(party: string): string {
  if (party.length <= 24) return party;
  return `${party.slice(0, 10)}-${party.slice(-10)}`;
}

export function encodeTransferMemo(
  prefix: string,
  payload: Record<string, unknown>
): string {
  const memo = `${prefix}${Buffer.from(
    JSON.stringify(payload),
    "utf8"
  ).toString("base64url")}`;
  if (memo.length > 256) {
    throw new Error("swap transfer memo exceeds Canton metadata limit");
  }
  return memo;
}

export function transferMemoFromMeta(meta?: Record<string, unknown>): string {
  const values = meta?.values;
  if (!values || typeof values !== "object") return "";
  const memo = (values as Record<string, unknown>)[TRANSFER_REASON_META_KEY];
  return typeof memo === "string" ? memo : "";
}

export function isOrderBoundSwapMemo(memo: string): boolean {
  return (
    memo.startsWith(CANTON_SWAP_MEMO_PREFIX) ||
    memo.startsWith(HTLC_LOOP_COUNTER_MEMO_PREFIX) ||
    memo.startsWith("oranj.htlc.rev.v1.")
  );
}

export function isLegacySwapMemo(memo: string): boolean {
  return memo === "" || memo === LEGACY_SWAP_MEMO;
}

export function cantonSwapUserLegMemo(
  order: Pick<
    CantonSwapOrder,
    | "id"
    | "createdAt"
    | "fromAsset"
    | "toAsset"
    | "userParty"
    | "solverParty"
    | "settlementParty"
  >
): string {
  return encodeTransferMemo(CANTON_SWAP_MEMO_PREFIX, {
    id: order.id,
    leg: "user",
    ts: order.createdAt,
    from: order.fromAsset,
    to: order.toAsset,
    user: partyMemoTag(order.userParty),
    vault: partyMemoTag(order.settlementParty ?? order.solverParty)
  });
}

export function cantonSwapCounterLegMemo(
  order: Pick<
    CantonSwapOrder,
    | "id"
    | "createdAt"
    | "fromAsset"
    | "toAsset"
    | "userParty"
    | "solverParty"
    | "settlementParty"
  >,
  attempt = 0
): string {
  return encodeTransferMemo(CANTON_SWAP_MEMO_PREFIX, {
    id: order.id,
    leg: "counter",
    attempt,
    ts: order.createdAt,
    from: order.fromAsset,
    to: order.toAsset,
    user: partyMemoTag(order.userParty),
    vault: partyMemoTag(order.settlementParty ?? order.solverParty)
  });
}

export function htlcLoopCounterDeliveryMemo(
  order: Pick<
    SwapOrder,
    "id" | "createdAt" | "userCantonParty" | "solverCantonParty"
  >
): string {
  return encodeTransferMemo(HTLC_LOOP_COUNTER_MEMO_PREFIX, {
    id: order.id.startsWith("0x") ? order.id.slice(2) : order.id,
    leg: "counter",
    ts: order.createdAt,
    user: partyMemoTag(order.userCantonParty),
    solver: partyMemoTag(order.solverCantonParty)
  });
}
