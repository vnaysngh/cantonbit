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
    expectedMemo?: string;
  }
): { delivered: boolean; offerCid?: string } | null {
  const directParams = {
    senderParty: params.senderParty,
    receiverParty: params.receiverParty,
    amount: params.amountBtc,
    amountDecimals: 8,
    expectedInstrument: params.expectedInstrument,
    expectedMemo: params.expectedMemo
  };

  // Preapproval/direct delivery can still create a TransferInstruction-looking
  // artifact in the same update tree. Prefer receiver holding + sender-bound
  // settlement proof over a pending-offer interpretation.
  if (counterLegDeliveredToUserInEvents(eventsById, directParams)) {
    return { delivered: true };
  }

  const offerCid =
    extractCounterOfferCidFromEvents(eventsById, {
      senderParty: params.senderParty,
      receiverParty: params.receiverParty,
      amount: params.amountBtc,
      amountDecimals: 8,
      expectedInstrument: params.expectedInstrument,
      expectedMemo: params.expectedMemo
    }) ?? undefined;
  if (offerCid) return { delivered: false, offerCid };

  return null;
}
