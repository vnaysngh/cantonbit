import { getSwapAsset, matchesInstrument } from "./canton-assets";
import { toBaseUnits, toBaseUnitsFloor } from "./amount-units";
import type { InstrumentId } from "./constants";
import type { CantonSwapMvpAssetId } from "./canton-swap-types";

/** Minimal offer fields used to validate a Loop user sell leg against an order. */
export interface UserLegOfferSnapshot {
  contractId: string;
  sender: string;
  receiver: string;
  amountBtc: string;
  requestedAt?: string;
  executeBefore?: string;
  instrumentId?: { admin?: string; id?: string };
}

/** Same lenient matching as HTLC confirmLoopSellerLock (sender + amount >= order). */
export function findUserLegOfferForOrder(
  offers: UserLegOfferSnapshot[],
  order: {
    fromAsset: CantonSwapMvpAssetId;
    inAmount: string;
    userParty: string;
    solverParty: string;
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
    if (o.receiver !== order.solverParty) return false;
    try {
      if (toBaseUnitsFloor(o.amountBtc, decimals) < orderUnits) return false;
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
