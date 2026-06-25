import "server-only";

import {
  assertOfferOnlyUserLegEvidence,
  parseUserLegEvidenceFromEvents
} from "./canton-swap-leg-verify-logic";
import { fetchUpdateEventsById } from "./canton-swap-leg-verify";
import { NETWORK } from "./constants";

export interface HtlcReverseLoopCustodyEvidence {
  offerCid?: string;
  inboundHoldingCid?: string;
}

/** Prove a Loop CBTC transfer with an order-bound memo before creating the HTLC row. */
export async function verifyHtlcReverseLoopCustodySubmit(
  submitUpdateId: string,
  params: {
    userParty: string;
    solverParty: string;
    cbtcAmount: string;
    expectedMemo: string;
    offerCidHint?: string;
  }
): Promise<HtlcReverseLoopCustodyEvidence> {
  const events = await fetchUpdateEventsById(submitUpdateId, [
    params.userParty,
    params.solverParty
  ]);
  const evidence = parseUserLegEvidenceFromEvents(events, {
    userParty: params.userParty,
    solverParty: params.solverParty,
    inAmount: params.cbtcAmount,
    fromAsset: "CBTC",
    expectedInstrument: NETWORK.instrumentId,
    expectedMemo: params.expectedMemo,
    strictOrderBoundMemo: true
  });
  if (!evidence?.offerCid && !evidence?.inboundHoldingCid) {
    throw new Error(
      "Loop CBTC transfer is not visible with this order memo — start a new swap"
    );
  }
  assertOfferOnlyUserLegEvidence(evidence);
  return evidence;
}
