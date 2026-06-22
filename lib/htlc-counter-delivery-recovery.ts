import type { InstrumentId } from "./constants";
import {
  counterLegDeliveredToUserInEvents,
  extractCounterOfferCidFromEvents
} from "./canton-swap-leg-verify-logic";

export function recoverHtlcCounterDeliveryFromEvents(
  eventsById: Record<string, unknown>,
  params: {
    senderParty: string;
    receiverParty: string;
    amountBtc: string;
    expectedInstrument: InstrumentId;
  }
): { delivered: boolean; offerCid?: string } | null {
  const offerCid =
    extractCounterOfferCidFromEvents(eventsById, {
      senderParty: params.senderParty,
      receiverParty: params.receiverParty,
      amount: params.amountBtc,
      amountDecimals: 8,
      expectedInstrument: params.expectedInstrument
    }) ?? undefined;
  if (offerCid) return { delivered: false, offerCid };

  if (
    counterLegDeliveredToUserInEvents(eventsById, {
      senderParty: params.senderParty,
      receiverParty: params.receiverParty,
      amount: params.amountBtc,
      amountDecimals: 8,
      expectedInstrument: params.expectedInstrument
    })
  ) {
    return { delivered: true };
  }

  return null;
}
