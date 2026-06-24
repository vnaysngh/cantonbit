import { getSwapAsset, matchesInstrument } from "./canton-assets";
import { toBaseUnits, toBaseUnitsFloor } from "./amount-units";
import type { InstrumentId } from "./constants";
import type { CantonSwapMvpAssetId } from "./canton-swap-types";
import { userLegReceiverParty } from "./canton-swap-types";
import {
  cantonSwapUserLegMemo,
  isLegacySwapMemo,
  isOrderBoundSwapMemo,
  transferMemoFromMeta
} from "./swap-transfer-memo";

/** Minimal offer fields used to validate a Loop user sell leg against an order. */
export interface UserLegOfferSnapshot {
  contractId: string;
  sender: string;
  receiver: string;
  amountBtc: string;
  requestedAt?: string;
  executeBefore?: string;
  instrumentId?: { admin?: string; id?: string };
  meta?: Record<string, unknown>;
}

/** Exact amount match at confirm — no silent surplus capture. */
export function findUserLegOfferForOrder(
  offers: UserLegOfferSnapshot[],
  order: {
    fromAsset: CantonSwapMvpAssetId;
    inAmount: string;
    userParty: string;
    solverParty: string;
    settlementParty?: string;
    id?: string;
    createdAt?: number;
    toAsset?: CantonSwapMvpAssetId;
  },
  expectedInstrument: InstrumentId,
  reservedCids?: Set<string>
): string | null {
  const decimals = getSwapAsset(order.fromAsset).decimals;
  let orderUnits: bigint;
  try {
    orderUnits = toBaseUnits(order.inAmount, decimals);
  } catch {
    return null;
  }

  const matches = offers.filter((o) => {
    if (reservedCids?.has(o.contractId)) return false;
    if (o.sender !== order.userParty) return false;
    if (o.receiver !== userLegReceiverParty(order as import("./canton-swap-types").CantonSwapOrder)) return false;
    try {
      if (toBaseUnitsFloor(o.amountBtc, decimals) !== orderUnits) return false;
    } catch {
      return false;
    }
    if (
      o.instrumentId?.id &&
      !matchesInstrument(o.instrumentId, expectedInstrument)
    ) {
      return false;
    }
    return true;
  });

  if (matches.length === 0) return null;

  if (order.id && order.createdAt != null && order.toAsset) {
    const expectedMemo = cantonSwapUserLegMemo({
      id: order.id,
      createdAt: order.createdAt,
      fromAsset: order.fromAsset,
      toAsset: order.toAsset,
      userParty: order.userParty,
      solverParty: order.solverParty,
      settlementParty: order.settlementParty
    });
    const exact = matches.filter((o) => transferMemoFromMeta(o.meta) === expectedMemo);
    if (exact.length === 1) return exact[0]!.contractId;
    if (exact.length > 1) return null;

    const legacyCutoffMs = (order.createdAt - 60) * 1000;
    const legacy = matches.filter((o) => {
      const memo = transferMemoFromMeta(o.meta);
      if (isOrderBoundSwapMemo(memo)) return false;
      if (!isLegacySwapMemo(memo)) return false;
      const requestedAtMs = Date.parse(o.requestedAt ?? "");
      return Number.isFinite(requestedAtMs) && requestedAtMs >= legacyCutoffMs;
    });
    if (legacy.length === 1) return legacy[0]!.contractId;
    return null;
  }

  matches.sort((a, b) =>
    (a.requestedAt ?? "") < (b.requestedAt ?? "") ? 1 : -1
  );
  return matches[0]!.contractId;
}

export function validateUserLegOfferSnapshot(
  offer: UserLegOfferSnapshot,
  order: {
    fromAsset: CantonSwapMvpAssetId;
    inAmount: string;
    userParty: string;
    solverParty: string;
    settlementParty?: string;
  },
  expectedInstrument: InstrumentId
): void {
  const cid = findUserLegOfferForOrder([offer], order, expectedInstrument);
  if (!cid) {
    throw new Error("offer does not match order sell leg");
  }
  if (offer.executeBefore) {
    const expiry = new Date(offer.executeBefore).getTime();
    if (!Number.isNaN(expiry) && expiry <= Date.now()) {
      throw new Error("user leg offer expired");
    }
  }
}
